package storage

import (
	"context"
	"database/sql"
)

const fillDaily = `
INSERT INTO daily_events SELECT project_id,substr(timestamp,1,10),event,count(*)
 FROM events GROUP BY 1,2,3;
INSERT INTO daily_people SELECT project_id,substr(timestamp,1,10),distinct_id,count(*),min(timestamp),max(timestamp)
 FROM events GROUP BY 1,2,3;
`

const dailySchema = `
CREATE TABLE daily_events (
 project_id INTEGER NOT NULL REFERENCES projects(id), day TEXT NOT NULL, event TEXT NOT NULL,
 count INTEGER NOT NULL, PRIMARY KEY(project_id,day,event)
) WITHOUT ROWID;
CREATE TABLE daily_people (
 project_id INTEGER NOT NULL REFERENCES projects(id), day TEXT NOT NULL, distinct_id TEXT NOT NULL,
 count INTEGER NOT NULL, first_ts TEXT NOT NULL, last_ts TEXT NOT NULL, PRIMARY KEY(project_id,distinct_id,day)
);
CREATE INDEX daily_people_day ON daily_people(project_id,day);
CREATE INDEX daily_people_recent ON daily_people(project_id,last_ts DESC,distinct_id);
CREATE INDEX events_funnel ON events(project_id,event,distinct_id,timestamp,id);
DROP INDEX events_time;
CREATE INDEX events_time ON events(project_id,timestamp,id,event,distinct_id);
CREATE TRIGGER rollup_event AFTER INSERT ON events BEGIN
 INSERT INTO daily_events VALUES(NEW.project_id,substr(NEW.timestamp,1,10),NEW.event,1)
 ON CONFLICT(project_id,day,event) DO UPDATE SET count=count+1;
 INSERT INTO daily_people VALUES(NEW.project_id,substr(NEW.timestamp,1,10),NEW.distinct_id,1,NEW.timestamp,NEW.timestamp)
 ON CONFLICT(project_id,distinct_id,day) DO UPDATE SET count=count+1,
 first_ts=min(first_ts,NEW.timestamp),last_ts=max(last_ts,NEW.timestamp);
END;
` + fillDaily

func RebuildRollups(ctx context.Context, path string) error {
	s, err := open(ctx, path, false)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.write(ctx, func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM daily_events; DELETE FROM daily_people;"+fillDaily)
		return err
	})
}
