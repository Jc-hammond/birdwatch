package storage

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ncruces/go-sqlite3"
)

// Backup opens only an existing source. The command never creates or migrates it.
func Backup(ctx context.Context, source, destination string) error {
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("%s: %w", destination, os.ErrExist)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Linking the finished file also excludes a concurrent creator.
	return copyDatabase(ctx, source, destination, os.Link)
}

func noSidecars(path string) error {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(path + suffix); err == nil {
			return fmt.Errorf("destination has an existing SQLite %s file", suffix)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func copyDatabase(ctx context.Context, source, destination string, publish func(string, string) error) error {
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
	path, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	src, err := sqlite3.OpenFlags(fileURI(path, "ro"), sqlite3.OPEN_READONLY|sqlite3.OPEN_URI)
	if err != nil {
		return err
	}
	defer src.Close()
	src.SetInterrupt(ctx)
	if err = src.BusyTimeout(5 * time.Second); err != nil {
		return err
	}
	// This dedicated reader pins one WAL snapshot while capture continues.
	if err = src.Exec("BEGIN; SELECT count(*) FROM sqlite_schema"); err != nil {
		return err
	}
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
	if err = errors.Join(err, backup.Close()); err != nil {
		return err
	}
	if err = noSidecars(destination); err != nil {
		return err
	}
	if err = publish(tmp.Name(), destination); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
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
	source, err := os.Stat(s.path)
	if err != nil {
		return err
	}
	destination := filepath.Join(dir, name)
	if err := Backup(ctx, s.path, destination); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if err = existingDaily(ctx, destination, source); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(dir) // name order is chronological for UTC dates
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

func existingDaily(ctx context.Context, path string, source os.FileInfo) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || os.SameFile(source, info) {
		return errors.New("daily backup path is occupied")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return errors.New("daily backup permissions must be owner-only")
	}
	if err = noSidecars(path); err != nil {
		return err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	conn, err := sqlite3.OpenFlags(fileURI(abs, "ro")+"&immutable=1", sqlite3.OPEN_READONLY|sqlite3.OPEN_URI)
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetInterrupt(ctx)
	stmt, _, err := conn.Prepare("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('projects','events')")
	if err != nil {
		return err
	}
	defer stmt.Close()
	if !stmt.Step() || stmt.ColumnInt(0) != 2 {
		return errors.New("daily backup path does not contain a Birdwatch database")
	}
	return nil
}
