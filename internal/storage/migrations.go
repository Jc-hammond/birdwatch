package storage

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/ncruces/go-sqlite3"
)

var migrations = []string{`
CREATE TABLE projects (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, write_key TEXT UNIQUE,
 sample_as_of TEXT, created_at TEXT NOT NULL
);
CREATE TABLE events (
 id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
 event TEXT NOT NULL, distinct_id TEXT NOT NULL, timestamp TEXT NOT NULL,
 properties TEXT NOT NULL, uuid TEXT, UNIQUE(project_id, uuid)
);
CREATE INDEX events_person ON events(project_id, distinct_id, event, timestamp, id);
CREATE INDEX events_time ON events(project_id, timestamp, event, distinct_id);
`}

func (s *Store) migrate(ctx context.Context, steps []string, existing bool) error {
	var version int
	// Inspect through a read-only connection before opening a writer or changing journal mode.
	err := s.readers.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	if errors.Is(err, sqlite3.READONLY_ROLLBACK) || errors.Is(err, sqlite3.READONLY_RECOVERY) {
		// SQLite needs write access to restore committed pages after an interrupted transaction.
		err = s.writer.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	}
	if err != nil {
		return err
	}
	if version < 0 || version > len(steps) {
		return fmt.Errorf("unsupported database version %d; upgrade Birdwatch", version)
	}
	for i := version; i < len(steps); i++ {
		if err := s.apply(ctx, i, steps, existing && i == version); err != nil {
			return fmt.Errorf("schema version %d: %w", i+1, err)
		}
	}
	return nil
}

func (s *Store) apply(ctx context.Context, from int, steps []string, backup bool) error {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// BEGIN IMMEDIATE serialized us with any other process starting against this file.
	var current int
	if err = tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	if current > len(steps) {
		return fmt.Errorf("database version %d is newer; upgrade Birdwatch", current)
	}
	if current > from {
		return nil
	}
	if current != from {
		return fmt.Errorf("expected database version %d, found %d", from, current)
	}
	if backup {
		if err = s.backupVersion(ctx, from); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, steps[from]); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", from+1)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) backupVersion(ctx context.Context, version int) error {
	return copyDatabase(ctx, s.readers, fmt.Sprintf("%s.v%d.bak", s.path, version), os.Rename)
}
