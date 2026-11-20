package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyBackupsPreserveCommittedRowsAndKeepSeven(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	source := filepath.Join(dir, "live.sqlite3")
	s, err := Open(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.writer.Exec("CREATE TABLE committed (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "backups")
	first := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for day := range 8 {
		if _, err = s.writer.Exec("INSERT INTO committed VALUES (?)", day); err != nil {
			t.Fatal(err)
		}
		if err = s.dailyBackup(ctx, dest, first.AddDate(0, 0, day)); err != nil {
			t.Fatal(err)
		}
	}
	old := filepath.Join(dest, "birdwatch-2026-01-01.sqlite3")
	if _, err = os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old daily backup still present", err)
	}
	// A restart between publication and rotation must finish rotation.
	if err = os.Link(filepath.Join(dest, "birdwatch-2026-01-02.sqlite3"), old); err != nil {
		t.Fatal(err)
	}
	if err = s.dailyBackup(ctx, dest, first.AddDate(0, 0, 7)); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("same-day restart left an expired backup", err)
	}
	for day := 2; day <= 8; day++ {
		path := filepath.Join(dest, fmt.Sprintf("birdwatch-2026-01-%02d.sqlite3", day))
		db, err := sql.Open("sqlite3", fileURI(path, "ro"))
		if err != nil {
			t.Fatal(err)
		}
		var n int
		err = db.QueryRow("SELECT count(*) FROM committed").Scan(&n)
		db.Close()
		if err != nil || n != day {
			t.Fatalf("day %d has %d rows: %v", day, n, err)
		}
		if err = Backup(ctx, source, path); !errors.Is(err, os.ErrExist) {
			t.Fatalf("existing snapshot overwrite: %v", err)
		}
	}
}

func TestBackupRefusesOrphanedJournal(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	source := filepath.Join(dir, "source.sqlite3")
	s, err := Open(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	dest := filepath.Join(dir, "copy.sqlite3")
	if err = os.WriteFile(dest+"-wal", []byte("unrelated"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = Backup(ctx, source, dest); err == nil {
		t.Fatal("published a backup next to an unrelated WAL")
	}
	if _, err = os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a partial backup was left behind")
	}
}
