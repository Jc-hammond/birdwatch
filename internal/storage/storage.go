// Package storage owns Birdwatch's SQLite connections and schema.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
)

const readTimeout = 5 * time.Second

type Store struct {
	path            string
	writer, readers *sql.DB
}

func fileURI(path, mode string) string {
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{"mode": {mode}}
	if mode == "rw" {
		q.Set("_txlock", "immediate")
		q.Add("_pragma", "foreign_keys(ON)")
		q.Add("_pragma", "busy_timeout(5000)")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func Open(ctx context.Context, path string) (*Store, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	// Reserve a new file with owner-only permissions before SQLite opens it.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	existing := errors.Is(err, os.ErrExist)
	if err != nil && !existing {
		return nil, err
	}
	if f != nil {
		if err = f.Close(); err != nil {
			return nil, err
		}
	}
	writer, err := sql.Open("sqlite3", fileURI(path, "rw"))
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	readers, err := sql.Open("sqlite3", fileURI(path, "ro"))
	if err != nil {
		writer.Close()
		return nil, err
	}
	s := &Store{path: path, writer: writer, readers: readers}
	if err = s.migrate(ctx, migrations, existing); err != nil {
		s.Close()
		return nil, err
	}
	var journal string
	if err = writer.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&journal); err == nil && journal != "wal" {
		err = errors.New("SQLite could not enable WAL mode")
	}
	if err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return errors.Join(s.readers.Close(), s.writer.Close()) }

// Reader binds every statement in a snapshot to the same deadline.
type Reader struct {
	ctx context.Context
	tx  *sql.Tx
}

func (r Reader) QueryRow(query string, args ...any) *sql.Row {
	return r.tx.QueryRowContext(r.ctx, query, args...)
}

func (r Reader) Query(query string, args ...any) (*sql.Rows, error) {
	return r.tx.QueryContext(r.ctx, query, args...)
}

// Read runs the report against one snapshot, with a deadline shared by all its queries.
func (s *Store) Read(ctx context.Context, query func(Reader) error) error {
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	tx, err := s.readers.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	err = query(Reader{ctx: ctx, tx: tx})
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func (s *Store) Health(ctx context.Context) error {
	// A pooled connection can keep serving an unlinked or replaced file.
	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	probe, err := sql.Open("sqlite3", fileURI(s.path, "ro"))
	if err != nil {
		return err
	}
	defer probe.Close()
	var version int
	if err := probe.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version != len(migrations) {
		return errors.New("database schema unavailable")
	}
	return nil
}

// Write reserves the single writer and bounds both the queue wait and the transaction.
func (s *Store) Write(ctx context.Context, apply func(context.Context, *sql.Tx) error) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := apply(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}
