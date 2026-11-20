package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	mathrand "math/rand"
	"time"
)

// TimestampLayout keeps UTC timestamps sortable as SQLite text.
const TimestampLayout = "2006-01-02T15:04:05.000000Z"

func insertProject(ctx context.Context, tx *sql.Tx, name string) (int64, error) {
	var id int64
	err := tx.QueryRowContext(ctx, "INSERT INTO projects(name,write_key,created_at) VALUES(?,?,?) RETURNING id", name, "bw_"+rand.Text(), time.Now().UTC().Format(TimestampLayout)).Scan(&id)
	return id, err
}

func (s *Store) CreateProject(ctx context.Context, name string) (int64, error) {
	var id int64
	err := s.Write(ctx, func(ctx context.Context, tx *sql.Tx) (err error) {
		id, err = insertProject(ctx, tx, name)
		return err
	})
	return id, err
}

// Seed commits the first project and its entire history together, even across concurrent starts.
func (s *Store) Seed(ctx context.Context, demo bool) error {
	return s.write(ctx, func(ctx context.Context, tx *sql.Tx) error {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM projects)").Scan(&exists); err != nil || exists {
			return err
		}
		if !demo {
			_, err := insertProject(ctx, tx, "My project")
			return err
		}
		return seedDemo(ctx, tx)
	})
}

func seedDemo(ctx context.Context, tx *sql.Tx) error {
	// Fix both the calendar window and the random seed so independently installed demos match.
	asOf := time.Date(2026, time.January, 30, 12, 0, 0, 0, time.UTC)
	date := asOf.Format(TimestampLayout)
	var project int64
	err := tx.QueryRowContext(ctx, "INSERT INTO projects(name,sample_as_of,created_at) VALUES('Demo project',?,?) RETURNING id", date, date).Scan(&project)
	if err != nil {
		return err
	}
	insert, err := tx.PrepareContext(ctx, "INSERT INTO events(project_id,event,distinct_id,timestamp,properties) VALUES(?,?,?,?,?)")
	if err != nil {
		return err
	}
	defer insert.Close()
	rng := mathrand.New(mathrand.NewSource(42))
	paths := []string{"/", "/dashboard", "/pricing", "/docs", "/settings", "/projects"}
	devices := []string{"desktop", "desktop", "mobile"}
	wave := []float64{0.83, 0.93, 0.74, 1.09, 0.98, 1.19, 1.27}
	for offset := range 60 {
		start := asOf.Truncate(24*time.Hour).AddDate(0, 0, offset-59)
		span := min(24*time.Hour, asOf.Sub(start))
		volume := int((430 + 16*float64(offset) + 55*math.Sin(float64(offset)/4)) * wave[(offset+3)%7])
		for range volume {
			name := "page_view"
			switch n := rng.Intn(100); {
			case n >= 94:
				name = "feature_use"
			case n >= 86:
				name = "project_create"
			case n >= 75:
				name = "sign_up"
			case n >= 51:
				name = "button_click"
			}
			person := fmt.Sprintf("visitor_%06x", rng.Intn(350+17*offset))
			ts := start.Add(time.Duration(rng.Int63n(int64(span))))
			props, _ := json.Marshal(map[string]string{"path": paths[rng.Intn(len(paths))], "device": devices[rng.Intn(len(devices))]})
			if _, err := insert.ExecContext(ctx, project, name, person, ts.Format(TimestampLayout), string(props)); err != nil {
				return err
			}
		}
	}
	return nil
}
