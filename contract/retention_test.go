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
	s.capture(t, p, object{"event": "old", "distinct_id": "subscriber", "timestamp": time.Now().UTC().AddDate(0, 0, -3)}, 200)
	s.capture(t, p, event("fresh", "subscriber"), 200)
	before := s.overview(t, p, 7)
	for _, value := range []any{0, -1, 1.5, "1"} {
		s.expect(t, 400, "PATCH", base, object{"retention_days": value}, nil)
	}
	s.expect(t, 200, "PATCH", base, object{"retention_days": 1}, nil)
	s.stop()
	s = start(t, path, false, "") // Startup runs the same sweep as the hourly timer.
	deadline := time.Now().Add(10 * time.Second)
	for rowCount(t, s.report(t, p, "events?name=old")) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("expired event remains after startup sweep")
		}
		time.Sleep(20 * time.Millisecond)
	}
	check(t, "fresh rows", rowCount(t, s.report(t, p, "events")), 1)
	check(t, "daily totals", s.overview(t, p, 7).Series, before.Series)
	check(t, "stored retention", decode[object](t, s.report(t, p, "setup"))["retention_days"], float64(1))
	s.expect(t, 200, "PATCH", base, object{"retention_days": nil}, nil)
	check(t, "unlimited", decode[object](t, s.report(t, p, "setup"))["retention_days"], nil)
	s.expect(t, 200, "DELETE", base+"/people/subscriber", nil, nil)
	check(t, "erased archived contributions", s.overview(t, p, 7).Current[0], float64(0))
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
	key := http.Header{"Authorization": {"Bearer " + p.key}}
	s.expect(t, 401, "DELETE", projectPath(other.id, "people/"+url.PathEscape(person)), nil, key)
	s.expect(t, 401, "PATCH", "/api/projects/"+strconv.Itoa(other.id), object{"retention_days": 1}, key)
}
