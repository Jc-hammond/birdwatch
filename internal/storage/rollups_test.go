package storage

import (
	"context"
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyRollupsMatchStoredEvents(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "events.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.writer.Exec("INSERT INTO projects(id,name,created_at) VALUES(1,'A','now'),(2,'B','now')"); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(42))
	for range 300 {
		project := 1 + rng.Intn(2)
		ts := time.Date(2026, 1, 1+rng.Intn(4), rng.Intn(24), 0, 0, 0, time.UTC)
		_, err := s.writer.Exec("INSERT INTO events(project_id,event,distinct_id,timestamp,properties,uuid) VALUES(?,?,?,?,'{}',?) ON CONFLICT(project_id,uuid) DO NOTHING",
			project, fmt.Sprint(rng.Intn(4)), fmt.Sprint(rng.Intn(8)), ts.Format(TimestampLayout), fmt.Sprint(rng.Intn(120)))
		if err != nil {
			t.Fatal(err)
		}
	}
	for table, grouped := range map[string]string{
		"daily_events": "SELECT project_id,substr(timestamp,1,10),event,COUNT(*) FROM events GROUP BY 1,2,3",
		"daily_people": "SELECT project_id,substr(timestamp,1,10),distinct_id,COUNT(*),MIN(timestamp),MAX(timestamp) FROM events GROUP BY 1,2,3",
	} {
		actual := "SELECT * FROM " + table
		for _, pair := range [][2]string{{actual, grouped}, {grouped, actual}} {
			var differs bool
			if err := s.writer.QueryRow("SELECT EXISTS(" + pair[0] + " EXCEPT " + pair[1] + ")").Scan(&differs); err != nil {
				t.Fatal(err)
			}
			if differs {
				t.Fatalf("%s differs from the raw events", table)
			}
		}
	}
}
