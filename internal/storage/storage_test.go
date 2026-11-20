package storage

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestFailedMigrationPreservesVersionDataAndBackup(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "events.sqlite3")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.writer.ExecContext(ctx, "INSERT INTO projects(id,name,created_at) VALUES(1,'before','now')"); err != nil {
		t.Fatal(err)
	}
	const broken = "DELETE FROM projects; INSERT INTO missing_table VALUES(1);"
	if err := s.migrate(ctx, append(append([]string{}, migrations...), broken), true); err == nil {
		t.Fatal("broken migration succeeded")
	}
	for _, file := range []string{path, path + ".v1.bak"} {
		db, err := sql.Open("sqlite3", fileURI(file, "ro"))
		if err != nil {
			t.Fatal(err)
		}
		var version int
		var name string
		err = db.QueryRow("PRAGMA user_version").Scan(&version)
		if err == nil {
			err = db.QueryRow("SELECT name FROM projects WHERE id=1").Scan(&name)
		}
		db.Close()
		if err != nil || version != 1 || name != "before" {
			t.Fatalf("database %s: version %d, original row present %t, err %v", filepath.Base(file), version, name == "before", err)
		}
	}
}

func TestReadCancelsQueryAtDeadline(t *testing.T) {
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "events.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	const query = "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<100000000) SELECT sum(n) FROM numbers"
	start := time.Now()
	err = s.Read(context.Background(), func(r Reader) error {
		var total int64
		return r.QueryRow(query).Scan(&total)
	})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 10*time.Second {
		t.Fatalf("read ended after %s with %v", time.Since(start), err)
	}
	if err := s.Read(context.Background(), func(r Reader) error {
		var one int
		return r.QueryRow("SELECT 1").Scan(&one)
	}); err != nil {
		t.Fatalf("reader unavailable after cancellation: %v", err)
	}
}
