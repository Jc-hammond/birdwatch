package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ncruces/go-sqlite3/driver"
)

// Backup opens only an existing source. The command never creates or migrates it.
func Backup(ctx context.Context, source, destination string) error {
	path, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite3", fileURI(path, "ro"))
	if err != nil {
		return err
	}
	defer db.Close()
	return newBackup(ctx, db, destination)
}

func newBackup(ctx context.Context, db *sql.DB, destination string) error {
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("%s: %w", destination, os.ErrExist)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Linking the finished file also excludes a concurrent creator.
	return copyDatabase(ctx, db, destination, os.Link)
}

func copyDatabase(ctx context.Context, db *sql.DB, destination string, publish func(string, string) error) error {
	dir, err := filepath.Abs(filepath.Dir(destination))
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".birdwatch-backup-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Close(); err != nil {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	err = conn.Raw(func(raw any) error {
		src := raw.(driver.Conn).Raw()
		prev := src.SetInterrupt(ctx)
		defer src.SetInterrupt(prev)
		// Pin a WAL snapshot across steps so ongoing capture cannot restart the copy.
		if err := src.Exec("BEGIN; SELECT count(*) FROM sqlite_schema"); err != nil {
			return err
		}
		defer src.Exec("ROLLBACK")
		backup, err := src.BackupInit("main", fileURI(tmp.Name(), "rw"))
		if err != nil {
			return err
		}
		for done := false; !done && err == nil; {
			if err = ctx.Err(); err != nil {
				break
			}
			done, err = backup.Step(128)
		}
		return errors.Join(err, backup.Close())
	})
	if err != nil {
		return err
	}
	return publish(tmp.Name(), destination)
}

func (s *Store) ScheduleBackups(ctx context.Context, dir string, logger *log.Logger) {
	for ctx.Err() == nil {
		now := time.Now().UTC()
		if err := s.dailyBackup(ctx, dir, now); err != nil && ctx.Err() == nil {
			logger.Printf("daily backup failed: %v", err)
		}
		timer := time.NewTimer(time.Until(now.Truncate(24 * time.Hour).Add(24 * time.Hour)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Store) dailyBackup(ctx context.Context, dir string, day time.Time) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	const prefix = "birdwatch-"
	const suffix = ".sqlite3"
	name := prefix + day.UTC().Format(time.DateOnly) + suffix
	if err := newBackup(ctx, s.readers, filepath.Join(dir, name)); err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		return err
	}
	entries, err := os.ReadDir(dir) // name order is chronological for UTC dates
	if err != nil {
		return err
	}
	source, err := os.Stat(s.path)
	if err != nil {
		return err
	}
	var backups []string
	for _, entry := range entries {
		date, ok := strings.CutPrefix(entry.Name(), prefix)
		if !ok {
			continue
		}
		date, ok = strings.CutSuffix(date, suffix)
		if !ok {
			continue
		}
		if _, err := time.Parse(time.DateOnly, date); err != nil {
			continue
		}
		info, err := entry.Info()
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && !os.SameFile(source, info) {
			backups = append(backups, entry.Name())
		}
	}
	for _, name := range backups[:max(0, len(backups)-7)] {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
