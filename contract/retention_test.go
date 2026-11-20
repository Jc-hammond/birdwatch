package contract_test

import (
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestProjectRetention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "retention.db")
	s := start(t, path, false, "")
	p := s.createProject(t, "Retention")
	base := "/api/projects/" + strconv.Itoa(p.id)
	s.capture(t, p, object{"event": "old", "distinct_id": "subscriber", "uuid": "expiry-retry", "timestamp": time.Now().UTC().AddDate(0, 0, -3)}, 200)
	s.capture(t, p, event("fresh", "subscriber"), 200)
	before := s.overview(t, p, 7)
	for _, value := range []any{0, -1, 1.5, "1"} {
		s.expect(t, 400, "PATCH", base, object{"retention_days": value}, nil)
	}
	s.expect(t, 200, "PATCH", base, object{"retention_days": 1}, nil)
	paged := s.createProject(t, "Archived people")
	var batch []object
	for i := 0; i < 32; i++ {
		batch = append(batch, object{"event": "old", "distinct_id": "guest" + strconv.Itoa(i), "timestamp": time.Now().UTC().AddDate(0, 0, -3)})
	}
	boundary := time.Now().UTC().AddDate(0, 0, -7).Truncate(24 * time.Hour)
	for _, ts := range []time.Time{boundary, boundary.Add(24*time.Hour - time.Microsecond)} {
		batch = append(batch, object{"event": "comparison", "distinct_id": "comparison", "timestamp": ts})
	}
	s.capture(t, paged, object{"batch": batch}, 200)
	type comparison struct {
		Previous []float64
		FullDay  string `json:"previous_full_day"`
	}
	beforeExpiry := decode[comparison](t, s.report(t, paged, "overview?days=7"))
	check(t, "exact previous period", beforeExpiry.Previous[0], float64(1))
	check(t, "exact comparison label", beforeExpiry.FullDay, "")
	s.expect(t, 200, "PATCH", "/api/projects/"+strconv.Itoa(paged.id), object{"retention_days": 1}, nil)
	s.stop()
	s = start(t, path, false, "") // Startup runs the same sweep as the hourly timer.
	deadline := time.Now().Add(10 * time.Second)
	for rowCount(t, s.report(t, p, "events?name=old")) != 0 || rowCount(t, s.report(t, paged, "events")) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("expired event remains after startup sweep")
		}
		time.Sleep(20 * time.Millisecond)
	}
	expectCounts(t, s.capture(t, p, object{"event": "old", "distinct_id": "subscriber", "uuid": "expiry-retry"}, 200), 0, 1)
	check(t, "fresh rows", rowCount(t, s.report(t, p, "events")), 1)
	check(t, "daily totals", s.overview(t, p, 7).Series, before.Series)
	check(t, "stored retention", decode[object](t, s.report(t, p, "setup"))["retention_days"], float64(1))
	s.expect(t, 200, "PATCH", base, object{"retention_days": nil}, nil)
	check(t, "unlimited", decode[object](t, s.report(t, p, "setup"))["retention_days"], nil)
	s.expect(t, 200, "DELETE", base+"/people/subscriber", nil, nil)
	check(t, "erased archived contributions", s.overview(t, p, 7).Current[0], float64(0))
	afterExpiry := decode[comparison](t, s.report(t, paged, "overview?days=7"))
	check(t, "whole previous UTC day", afterExpiry.Previous[0], float64(2))
	check(t, "archived comparison label", afterExpiry.FullDay, boundary.Format(time.DateOnly))
	first := decode[struct{ Next string }](t, s.report(t, paged, "people"))
	if first.Next == "" {
		t.Fatal("missing cursor for archived people")
	}
	later := "people?cursor=" + url.QueryEscape(first.Next)
	rows := decode[struct{ Rows []object }](t, s.report(t, paged, later)).Rows
	if len(rows) != 2 {
		t.Fatalf("archived second page contains %d rows", len(rows))
	}
	person := rows[0]["distinct_id"].(string)
	s.capture(t, paged, event("later", person), 200)
	check(t, "snapshot after later capture", decode[struct{ Rows []object }](t, s.report(t, paged, later)).Rows, rows)
	s.expect(t, 200, "DELETE", projectPath(paged.id, "people/"+url.PathEscape(person)), nil, nil)
	check(t, "erased snapshot", errorBody(t, s.expect(t, 409, "GET", projectPath(paged.id, later), nil, nil)).Code, "cursor_expired")
	// Exact Events totals cover surviving rows. People retains archived activity.
	batch = nil
	for i := range 35 {
		batch = append(batch, event("old", "current"+strconv.Itoa(i)))
	}
	s.capture(t, paged, object{"batch": batch}, 200)
	for _, tc := range []struct {
		path string
		want int
	}{{"events?q=old", 35}, {"people?q=guest", 31}, {"people?days=7", 66}} {
		got := decode[struct{ Total int }](t, s.report(t, paged, tc.path+"&include_total=1"))
		check(t, tc.path+" after expiry and erasure", got.Total, tc.want)
	}
}

func TestErasePerson(t *testing.T) {
	db := filepath.Join(t.TempDir(), "erase.db")
	s := start(t, db, true, "")
	p, other := s.createProject(t, "Erase"), s.createProject(t, "Independent")
	const person = "guest/with % space?"
	s.capture(t, p, event("private", person), 200)
	s.capture(t, p, event("shared", person), 200)
	s.capture(t, p, event("shared", "kept"), 200)
	s.capture(t, other, event("shared", person), 200)
	path := projectPath(p.id, "people/"+url.PathEscape(person))
	s.expect(t, 403, "DELETE", path, nil, http.Header{"Origin": {"https://foreign.test"}})
	s.expect(t, 403, "DELETE", projectPath(1, "people/unknown"), nil, nil)
	s.expect(t, 403, "PATCH", "/api/projects/1", object{"retention_days": 1}, nil)
	for _, expected := range []int{2, 0} {
		check(t, "removed", decode[map[string]int](t, s.expect(t, 200, "DELETE", path, nil, nil))["removed"], expected)
	}
	check(t, "remaining events", rowCount(t, s.report(t, p, "events")), 1)
	check(t, "erased events", rowCount(t, s.report(t, p, "events?person="+url.QueryEscape(person))), 0)
	check(t, "erased people", rowCount(t, s.report(t, p, "people?q="+url.QueryEscape(person))), 0)
	check(t, "remaining totals", s.overview(t, p, 7).Current, []float64{1, 1, 0, 1})
	check(t, "remaining names", decode[struct{ Names []string }](t, s.report(t, p, "names")).Names, []string{"shared"})
	check(t, "other project", rowCount(t, s.report(t, other, "events?person="+url.QueryEscape(person))), 1)
	s.stop()
	s = start(t, db, true, "retention-owner")
	key := http.Header{"Authorization": {"Bearer " + other.key}}
	s.expect(t, 401, "DELETE", projectPath(other.id, "people/"+url.PathEscape(person)), nil, key)
	s.expect(t, 401, "PATCH", "/api/projects/"+strconv.Itoa(other.id), object{"retention_days": 1}, key)
}
