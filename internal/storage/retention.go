package storage

import (
	"context"
	"database/sql"
	"log"
	"time"
)

const retentionSchema = `
ALTER TABLE projects ADD COLUMN retention_days INTEGER CHECK(retention_days >= 1);
ALTER TABLE projects ADD COLUMN deleted_max_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN retention_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX deleted_event_sequence ON projects(deleted_max_id);
CREATE TABLE expired_counts (
 project_id INTEGER NOT NULL REFERENCES projects(id), distinct_id TEXT NOT NULL, day TEXT NOT NULL,
 event TEXT NOT NULL, n INTEGER NOT NULL, first_ts TEXT NOT NULL, last_ts TEXT NOT NULL,
 PRIMARY KEY(project_id,distinct_id,day,event)
) WITHOUT ROWID;
CREATE TABLE expired_receipts (
 project_id INTEGER NOT NULL REFERENCES projects(id), digest BLOB NOT NULL, distinct_id TEXT NOT NULL,
 PRIMARY KEY(project_id,digest)
) WITHOUT ROWID;
CREATE INDEX expired_receipts_person ON expired_receipts(project_id,distinct_id);
`

// RunRetention starts with a sweep so reopening the database also enforces its policy.
func (s *Store) RunRetention(ctx context.Context, logger *log.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := s.sweep(ctx, time.Now().UTC()); err != nil && ctx.Err() == nil {
			logger.Print("retention sweep failed; will retry next hour")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Store) sweep(ctx context.Context, now time.Time) error {
	var projects []int64
	if err := s.Read(ctx, func(db Reader) error {
		rows, err := db.Query("SELECT id FROM projects WHERE retention_days IS NOT NULL AND sample_as_of IS NULL")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			projects = append(projects, id)
		}
		return rows.Err()
	}); err != nil {
		return err
	}
	for _, project := range projects {
		for {
			var count int64
			err := s.write(ctx, func(ctx context.Context, tx *sql.Tx) error {
				// Re-read the policy under the write lock on every chunk. An owner can
				// disable it while a sweep is running. SQLite returns NULL for a date
				// outside its range, so very large limits expire nothing.
				const choose = `INSERT INTO expiry_batch SELECT id FROM events WHERE project_id=? AND timestamp<(
 SELECT date(?,'-'||retention_days||' days')||? FROM projects WHERE id=? AND sample_as_of IS NULL)
 ORDER BY timestamp,id LIMIT 10000`
				if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE IF NOT EXISTS expiry_batch(id INTEGER PRIMARY KEY); DELETE FROM expiry_batch"); err != nil {
					return err
				}
				chosen, err := tx.ExecContext(ctx, choose, project, now.Format(time.DateOnly), now.Format(TimestampLayout)[10:], project)
				if err != nil {
					return err
				}
				count, err = chosen.RowsAffected()
				if err != nil || count == 0 {
					return err
				}
				// Preserve the contributions required for erasure and rebuild. Event
				// properties, UUIDs and individual raw rows expire in this transaction.
				_, err = tx.ExecContext(ctx, `INSERT INTO expired_counts
 SELECT project_id,distinct_id,substr(timestamp,1,10),event,count(*),min(timestamp),max(timestamp)
 FROM events WHERE id IN expiry_batch GROUP BY 1,2,3,4
 ON CONFLICT(project_id,distinct_id,day,event) DO UPDATE SET
 n=n+excluded.n, first_ts=min(first_ts,excluded.first_ts),last_ts=max(last_ts,excluded.last_ts)`)
				if err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, `INSERT INTO expired_receipts
 SELECT project_id,receipt_hash(uuid),distinct_id FROM events WHERE id IN expiry_batch AND uuid IS NOT NULL`); err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, "UPDATE projects SET retention_revision=retention_revision+1,deleted_max_id=max(deleted_max_id,(SELECT max(id) FROM expiry_batch)) WHERE id=?", project); err != nil {
					return err
				}
				_, err = tx.ExecContext(ctx, "DELETE FROM events WHERE id IN expiry_batch")
				return err
			})
			if err != nil {
				return err
			}
			if count < 10000 {
				break
			}
		}
	}
	return nil
}

// ErasePerson subtracts live and expired contributions before discarding the
// visitor's summaries. The caller holds the writer and has checked the project.
func ErasePerson(ctx context.Context, tx *sql.Tx, project int64, person string) (int64, error) {
	var count int64
	if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM events WHERE project_id=?1 AND distinct_id=?2)
 + coalesce((SELECT sum(n) FROM expired_counts WHERE project_id=?1 AND distinct_id=?2),0)`, project, person).Scan(&count); err != nil {
		return 0, err
	}
	if count == 0 {
		var remnants bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM daily_people WHERE project_id=?1 AND distinct_id=?2)
 OR EXISTS(SELECT 1 FROM expired_receipts WHERE project_id=?1 AND distinct_id=?2)`, project, person).Scan(&remnants); err != nil || !remnants {
			return 0, err
		}
	}
	const subtract = `WITH contributions AS (
 SELECT substr(timestamp,1,10) day,event,count(*) n FROM events WHERE project_id=?1 AND distinct_id=?2 GROUP BY 1,2
 UNION ALL SELECT day,event,n FROM expired_counts WHERE project_id=?1 AND distinct_id=?2
), totals AS (SELECT day,event,sum(n) n FROM contributions GROUP BY day,event)
 UPDATE daily_events AS d SET count=count-t.n FROM totals t WHERE d.project_id=?1 AND d.day=t.day AND d.event=t.event`
	for _, query := range []string{
		subtract,
		`UPDATE projects SET retention_revision=retention_revision+1,
 deleted_max_id=max(deleted_max_id,coalesce((SELECT max(id) FROM events WHERE project_id=?1 AND distinct_id=?2),0))
 WHERE id=?1`,
		"DELETE FROM events WHERE project_id=? AND distinct_id=?",
		"DELETE FROM expired_counts WHERE project_id=? AND distinct_id=?",
		"DELETE FROM expired_receipts WHERE project_id=? AND distinct_id=?",
		"DELETE FROM daily_people WHERE project_id=? AND distinct_id=?",
	} {
		if _, err := tx.ExecContext(ctx, query, project, person); err != nil {
			return 0, err
		}
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM daily_events WHERE project_id=? AND count=0", project)
	return count, err
}
