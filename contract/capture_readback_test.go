package contract_test

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
)

// Until G5 supplies report readback, inspect committed Go capture rows independently.
func (s server) captureRows(t *testing.T, p project) []capturedEvent {
	t.Helper()
	if os.Getenv("BIRDWATCH_REFERENCE") != "go" {
		return decode[struct{ Rows []capturedEvent }](t, s.report(t, p, "events")).Rows
	}
	path := filepath.ToSlash(s.db)
	if path[0] != '/' {
		path = "/" + path
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite3", uri.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT event,distinct_id,timestamp FROM events WHERE project_id=? ORDER BY id", p.id)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var events []capturedEvent
	for rows.Next() {
		var event capturedEvent
		var stamp string
		if err := rows.Scan(&event.Event, &event.Person, &stamp); err != nil {
			t.Fatal(err)
		}
		event.Timestamp, err = time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

type capturedEvent struct {
	Event     string
	Person    string `json:"distinct_id"`
	Timestamp time.Time
}
