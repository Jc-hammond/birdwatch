package contract_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type project struct {
	id  int
	key string
}

func projectPath(id int, report string) string {
	return fmt.Sprintf("/api/projects/%d/%s", id, report)
}

func (s server) createProject(t *testing.T, name string) project {
	t.Helper()
	created := s.expect(t, 201, "POST", "/api/projects", object{"name": name}, nil)
	id := decode[struct{ ID int }](t, created).ID
	setup := s.expect(t, 200, "GET", projectPath(id, "setup"), nil, nil)
	key := decode[struct {
		WriteKey string `json:"write_key"`
	}](t, setup).WriteKey
	if !strings.HasPrefix(key, "bw_") {
		t.Fatal("new project's setup did not return a Birdwatch write key")
	}
	return project{id, key}
}

func event(name, person string) object {
	return object{"event": name, "distinct_id": person}
}

func (s server) capture(t *testing.T, p project, fields object, status int) response {
	t.Helper()
	fields["api_key"] = p.key
	return s.expect(t, status, "POST", "/api/capture", fields, nil)
}

type overview struct {
	Current []float64
	Series  []struct{ Values []float64 }
	AsOf    time.Time `json:"as_of"`
}

func (s server) report(t *testing.T, p project, report string) response {
	t.Helper()
	return s.expect(t, 200, "GET", projectPath(p.id, report), nil, nil)
}

func (s server) overview(t *testing.T, p project, days int) overview {
	t.Helper()
	report := decode[overview](t, s.report(t, p, fmt.Sprintf("overview?days=%d", days)))
	if len(report.Current) != 4 {
		t.Fatalf("overview returned %d current metrics, want 4", len(report.Current))
	}
	return report
}

func check(t *testing.T, field string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %v, want %v", field, got, want)
	}
}

func TestIngestionPersistenceAndReports(t *testing.T) {
	db := filepath.Join(t.TempDir(), "events.sqlite3")
	s := start(t, db, false, "")
	p := s.createProject(t, "Primary")
	other := s.createProject(t, "Second")

	first := event("page_view", "alice")
	first["properties"] = object{"screen": "welcome"}
	first["uuid"] = "once"
	expectCounts(t, s.capture(t, p, first, 200), 1, 0)
	repeat := event("page_view", "alice")
	repeat["uuid"] = "once"
	expectCounts(t, s.capture(t, p, repeat, 200), 0, 1)
	s.capture(t, p, event("sign_up", "alice"), 200)
	s.capture(t, p, event("$pageview", "bob"), 200)

	s.stop()
	s = start(t, db, false, "")
	if os.Getenv("BIRDWATCH_REFERENCE") == "go" {
		rows := s.captureRows(t, p)
		check(t, "stored after reopening", len(rows), 3)
		if len(rows) > 0 {
			check(t, "first copy after reopening", rows[0].Properties["screen"], "welcome")
		}
		check(t, "second project", len(s.captureRows(t, other)), 0)
		return // BIR-14 enables the report assertions below for Go.
	}
	report := s.overview(t, p, 7)
	check(t, "current", report.Current, []float64{3, 2, 2, 1.5})
	var sum float64
	for _, day := range report.Series {
		if len(day.Values) == 0 {
			t.Fatal("missing daily event count")
		}
		sum += day.Values[0]
	}
	check(t, "daily event count sum", sum, float64(3))
	events := decode[struct {
		Rows []struct{ Properties map[string]any }
	}](t, s.report(t, p, "events?person=alice"))
	if len(events.Rows) != 2 || events.Rows[1].Properties["screen"] != "welcome" {
		t.Error("expected the first event's screen property after reopening the database")
	}
	check(t, "people", rowCount(t, s.report(t, p, "people")), 2)
	check(t, "second project", s.overview(t, other, 7).Current, []float64{0, 0, 0, 0})
}

func rowCount(t *testing.T, r response) int {
	t.Helper()
	return len(decode[struct{ Rows []json.RawMessage }](t, r).Rows)
}

func TestBatchRollback(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Batch")
	// F1 makes rollback opt-in. The same rollback assertions apply to both servers.
	s.capture(t, p, object{"atomic": true, "batch": []object{event("first", "a"), {"event": ""}}}, 400)
	check(t, "stored after rollback", len(s.captureRows(t, p)), 0)
	r := s.capture(t, p, object{"batch": []object{event("first", "a"), event("last", "a")}}, 200)
	expectCounts(t, r, 2, 0)
}

func TestSameTimeOrderAndRepeatedFunnelSteps(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Funnel")
	ts := time.Now().UTC().Truncate(time.Second).Add(-time.Second)
	for _, pair := range [][2]string{{"yes", "a"}, {"yes", "b"}, {"no", "b"}, {"no", "a"}, {"twice", "a"}, {"twice", "a"}} {
		fields := event(pair[1], pair[0])
		fields["timestamp"] = ts
		s.capture(t, p, fields, 200)
	}
	for _, step := range []struct{ name, second string }{{"distinct steps", "b"}, {"repeated steps", "a"}} {
		result := decode[map[string]int](t, s.report(t, p, "funnel?first=a&second="+step.second))
		check(t, step.name, result, map[string]int{"entered": 3, "converted": 1})
	}
}

func TestUTCDayWindow(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "UTC")
	midnight := time.Now().UTC().Truncate(24 * time.Hour)
	s.capture(t, p, object{"event": "old", "distinct_id": "a", "timestamp": midnight.Add(-time.Microsecond)}, 200)
	s.capture(t, p, object{"event": "today", "distinct_id": "a", "timestamp": midnight}, 200)
	check(t, "today", s.overview(t, p, 1).Current, []float64{1, 1, 0, 1})
	check(t, "seven-day count", s.overview(t, p, 7).Current[0], float64(2))
	funnel := decode[map[string]int](t, s.report(t, p, "funnel?days=1&first=old&second=today"))
	entered, ok := funnel["entered"]
	if !ok || entered != 0 {
		t.Error("previous day's first step counted in today's funnel or entered missing")
	}
}

func TestInputAndProjectBoundaries(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Primary")
	s.capture(t, project{key: "unknown"}, event("page_view", "a"), 401)
	for _, invalid := range []object{
		{"event": " "}, {"properties": []string{}}, {"timestamp": "not-a-date"}, {"timestamp": "2025-02-01"},
		{"distinct_id": nil}, {"uuid": ""},
	} {
		fields := event("page_view", "a")
		for k, v := range invalid {
			fields[k] = v
		}
		s.capture(t, p, fields, 400)
	}
	s.expect(t, 400, "POST", "/api/projects", object{"name": " "}, nil)
	s.createProject(t, "Example")
}

func TestSearchAndPagination(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Search")
	var batch []object
	for range 32 {
		batch = append(batch, event("a_b", "%"))
	}
	batch = append(batch, event("axb", "outside"))
	s.capture(t, p, object{"batch": batch}, 200)
	check(t, "first page", rowCount(t, s.report(t, p, "events?q=a_b")), 30)
	check(t, "second page", rowCount(t, s.report(t, p, "events?q=a_b&offset=30")), 2)
	check(t, "people matching literal percent", rowCount(t, s.report(t, p, "people?q=%25")), 1)
}

func TestHostOriginAndPassword(t *testing.T) {
	t.Run("guarded_routes", func(t *testing.T) {
		s := startEmpty(t)
		s.expect(t, 403, "GET", "/api/projects", nil, http.Header{"Host": {"foreign.test"}})
		s.expect(t, 403, "POST", "/api/projects", object{"name": "x"}, http.Header{"Origin": {"https://foreign.test"}})
		const password = "sample-test-password"
		s = start(t, filepath.Join(t.TempDir(), "private.sqlite3"), false, password)
		auth := func(value string) http.Header {
			return http.Header{"Authorization": {"Basic " + base64.StdEncoding.EncodeToString([]byte(value))}}
		}
		for _, credentials := range []http.Header{nil, auth("owner:" + password), auth("admin:wrong")} {
			r := s.expect(t, 401, "GET", "/api/projects", nil, credentials)
			if !strings.HasPrefix(r.header.Get("WWW-Authenticate"), "Basic ") {
				t.Fatal("missing Basic challenge")
			}
			check(t, "API cache policy", r.header.Get("Cache-Control"), "no-store")
		}
		headers := auth("admin:" + password)
		headers.Set("Origin", s.url)
		page := s.expect(t, 200, "GET", "/", nil, headers)
		if page.header.Get("Content-Security-Policy") == "" || page.header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("private page is missing its same-origin policy")
		}
		headers.Set("Origin", "https://foreign.test")
		s.expect(t, 403, "GET", "/", nil, headers)
		public := http.Header{"Origin": {"https://app.test"}}
		script := s.expect(t, 200, "GET", "/birdwatch.js", nil, public)
		check(t, "public script CORS", script.header.Get("Access-Control-Allow-Origin"), "*")
		check(t, "referrer policy", script.header.Get("Referrer-Policy"), "no-referrer")
		check(t, "content sniffing", script.header.Get("X-Content-Type-Options"), "nosniff")
		// Capture remains public on a password-protected instance.
		capture := s.expect(t, 204, "OPTIONS", "/api/capture", nil, public)
		check(t, "public capture challenge", capture.header.Get("WWW-Authenticate"), "")
		check(t, "public capture CORS", capture.header.Get("Access-Control-Allow-Origin"), "*")
	})
	t.Run("error_codes_and_public_health", func(t *testing.T) {
		s := start(t, filepath.Join(t.TempDir(), "private.sqlite3"), false, "sample-test-password")
		unauthorized := s.expect(t, 401, "GET", "/", nil, nil)
		check(t, "missing credential code", errorBody(t, unauthorized).Code, "unauthorized")
		local := startEmpty(t)
		denied := local.expect(t, 403, "GET", "/api/projects", nil, http.Header{"Host": {"foreign.test"}})
		check(t, "foreign host code", errorBody(t, denied).Code, "forbidden")
		s.expect(t, 200, "GET", "/healthz", nil, http.Header{"Origin": {"https://app.test"}})
	})
}

// Exercise the actual project and ingestion endpoints with the dashboard protected.
func TestAuthenticatedProjectReadsAndPublicCapture(t *testing.T) {
	db := filepath.Join(t.TempDir(), "events.sqlite3")
	s := start(t, db, false, "")
	p := s.createProject(t, "Access")
	preflight := s.expect(t, 204, "OPTIONS", "/api/capture", nil, http.Header{"Origin": {"https://app.test"}})
	check(t, "capture allowed origin", preflight.header.Get("Access-Control-Allow-Origin"), "*")
	s.stop()
	const password = "sample-test-password"
	s = start(t, db, false, password)
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("admin:"+password))
	r := s.expect(t, 200, "GET", projectPath(p.id, "setup"), nil, http.Header{"Authorization": {auth}})
	if r.header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("private API returned a cross-origin access header")
	}
	s.capture(t, p, event("page_view", "a"), 200)
}

func TestDemoProjectIsSeparateAndFrozen(t *testing.T) {
	db := filepath.Join(t.TempDir(), "demo.sqlite3")
	s := start(t, db, true, "")
	type sample struct {
		ID   int
		AsOf time.Time `json:"sample_as_of"`
	}
	readSample := func() sample {
		t.Helper()
		r := s.expect(t, 200, "GET", "/api/projects", nil, nil)
		list := decode[struct{ Projects []sample }](t, r)
		if len(list.Projects) != 1 || list.Projects[0].AsOf.IsZero() {
			t.Fatal("expected exactly one project with a frozen sample time")
		}
		return list.Projects[0]
	}
	first := readSample()
	s.stop()
	s = start(t, db, true, "")
	check(t, "sample after restart", readSample(), first)
	p := project{id: first.ID}
	setup := decode[map[string]json.RawMessage](t, s.report(t, p, "setup"))
	if string(setup["write_key"]) != "null" {
		t.Error("demo setup must return a null write key")
	}
	report := s.overview(t, p, 7)
	if !report.AsOf.Equal(first.AsOf) || report.Current[0] <= 0 {
		t.Error("demo overview must have events and use the frozen sample time")
	}
}
