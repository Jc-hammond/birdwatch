package storage

import (
	"context"
	"database/sql"
)

const fillDaily = `
INSERT INTO daily_events SELECT project_id,substr(timestamp,1,10),event,count(*)
 FROM events GROUP BY 1,2,3;
INSERT INTO daily_people SELECT project_id,day,distinct_id,n,first_ts,last_ts,
 lag(day,1,'') OVER(PARTITION BY project_id,distinct_id ORDER BY day)
 FROM (SELECT project_id,substr(timestamp,1,10) day,distinct_id,count(*) n,min(timestamp) first_ts,max(timestamp) last_ts
 FROM events GROUP BY 1,2,3);
`

const dailySchema = `
CREATE TABLE daily_events (
 project_id INTEGER NOT NULL REFERENCES projects(id), day TEXT NOT NULL, event TEXT NOT NULL,
 count INTEGER NOT NULL, PRIMARY KEY(project_id,day,event)
) WITHOUT ROWID;
CREATE TABLE daily_people (
 project_id INTEGER NOT NULL REFERENCES projects(id), day TEXT NOT NULL, distinct_id TEXT NOT NULL,
 count INTEGER NOT NULL, first_ts TEXT NOT NULL, last_ts TEXT NOT NULL, previous_day TEXT NOT NULL, PRIMARY KEY(project_id,distinct_id,day)
);
CREATE INDEX daily_people_day ON daily_people(project_id,day,previous_day,first_ts);
CREATE INDEX daily_people_recent ON daily_people(project_id,last_ts DESC,distinct_id);
CREATE INDEX events_funnel ON events(project_id,event,distinct_id,timestamp,id);
DROP INDEX events_time;
CREATE INDEX events_time ON events(project_id,timestamp,id,event,distinct_id);
-- Keep the immediate successor linked when an event arrives out of day order.
CREATE TRIGGER link_person_day AFTER INSERT ON daily_people BEGIN
 UPDATE daily_people SET previous_day=NEW.day WHERE project_id=NEW.project_id AND distinct_id=NEW.distinct_id
 AND day=(SELECT min(day) FROM daily_people WHERE project_id=NEW.project_id AND distinct_id=NEW.distinct_id AND day>NEW.day);
END;
CREATE TRIGGER rollup_event AFTER INSERT ON events BEGIN
 INSERT INTO daily_events VALUES(NEW.project_id,substr(NEW.timestamp,1,10),NEW.event,1)
 ON CONFLICT(project_id,day,event) DO UPDATE SET count=count+1;
 INSERT INTO daily_people VALUES(NEW.project_id,substr(NEW.timestamp,1,10),NEW.distinct_id,1,NEW.timestamp,NEW.timestamp,
 COALESCE((SELECT max(day) FROM daily_people WHERE project_id=NEW.project_id AND distinct_id=NEW.distinct_id
 AND day<substr(NEW.timestamp,1,10)),''))
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
