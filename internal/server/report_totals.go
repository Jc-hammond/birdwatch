package server

import "time"

func (q report) count(query string, args ...any) (int64, error) {
	var n int64
	err := q.db.QueryRow(query, args...).Scan(&n)
	return n, err
}

// Match event names from the daily counts. Only visitors whose ID matches the
// search can contribute extra raw rows, and their matching names are excluded
// so an event matching both fields counts once.
func (q report) eventTotal(where string, args []any) (int64, error) {
	if q.params.Get("person") != "" {
		return q.count("SELECT count(*) FROM events WHERE "+where, args...)
	}
	search, name := q.params.Get("q"), q.params.Get("name")
	if search != "" && name != "" {
		var matches bool
		if err := q.db.QueryRow("SELECT instr(lower(?),lower(?))>0", name, search).Scan(&matches); err != nil {
			return 0, err
		}
		if matches {
			search = ""
		}
	}
	// Inspect the identity dictionary once. For a broad term it costs less
	// to count the excluded visitors and subtract them from the whole range.
	var persons, matching int64
	if search != "" {
		err := q.db.QueryRow(`SELECT count(*), count(*) FILTER (WHERE instr(lower(distinct_id),lower(?))>0)
 FROM daily_people WHERE project_id=? AND previous_day=''`, search, q.id).Scan(&persons, &matching)
		if err != nil {
			return 0, err
		}
	}
	complement := matching > persons-matching
	nameSearch := search
	if complement {
		nameSearch = ""
	}
	end, err := time.Parse(stamp, q.cursor.AsOf)
	if err != nil {
		return 0, err
	}
	counts, params, partial, err := q.eventDays(q.start, end)
	if err != nil {
		return 0, err
	}
	// A day that has lost raw events must be counted from its surviving rows.
	// Probe the archive index once per day, even if millions of visitors expired.
	// A partial boundary already uses raw rows in counts.
	lastDaily := end
	if partial {
		lastDaily = end.AddDate(0, 0, -1)
	}
	params = append(params, q.start.Format(time.DateOnly), lastDaily.Format(time.DateOnly), q.id, q.id, q.cursor.AsOf)
	n, err := q.count(counts+`, bounds(first,last) AS (VALUES(?,?)), days(day) AS (
 SELECT first FROM bounds WHERE first<=last UNION ALL
 SELECT date(day,'+1 day') FROM days,bounds WHERE day<last
), archived AS MATERIALIZED (
 SELECT day FROM days WHERE EXISTS(SELECT 1 FROM expired_counts a WHERE a.project_id=? AND a.day=days.day)
), raw_counts AS (SELECT event,count FROM counts WHERE day NOT IN (SELECT day FROM archived)
 UNION ALL SELECT e.event,1 FROM archived CROSS JOIN events e WHERE e.project_id=?
 AND e.timestamp>=archived.day AND e.timestamp<date(archived.day,'+1 day') AND e.timestamp<=?)
 SELECT coalesce(sum(count),0) FROM raw_counts WHERE (?='' OR event=?)
 AND (?='' OR instr(lower(event),lower(?))>0)`, append(params, name, name, nameSearch, nameSearch)...)
	if err != nil || matching == 0 || matching == persons {
		return n, err
	}
	match := ">0"
	if complement {
		match = "=0"
	}
	query := `SELECT count(*) FROM daily_people p CROSS JOIN events e INDEXED BY events_person
 ON e.project_id=p.project_id AND e.distinct_id=p.distinct_id
 WHERE p.project_id=?1 AND p.previous_day='' AND instr(lower(p.distinct_id),lower(?2))` + match +
		` AND e.timestamp BETWEEN ?3 AND ?4 AND e.event NOT IN
 (SELECT event FROM daily_events WHERE project_id=?1 AND instr(lower(event),lower(?2))>0)`
	params = []any{q.id, search, q.start.Format(stamp), q.cursor.AsOf}
	if name != "" {
		query += " AND e.event=?5"
		params = append(params, name)
	}
	extra, err := q.count(query, params...)
	if complement {
		return n - extra, err
	}
	return n + extra, err
}

func (q report) peopleTotal() (int64, error) {
	first, last := q.start.Format(time.DateOnly), q.cursor.AsOf[:10]
	if search := q.params.Get("q"); search != "" {
		// The partial index contains one ID per person, even if they visited
		// many days. Only matching IDs need an activity check.
		return q.count(`SELECT count(*) FROM daily_people p WHERE p.project_id=?1 AND p.previous_day=''
 AND instr(lower(p.distinct_id),lower(?2))>0 AND EXISTS(SELECT 1 FROM daily_people d
 WHERE d.project_id=p.project_id AND d.distinct_id=p.distinct_id AND d.day BETWEEN ?3 AND ?4 AND d.first_ts<=?5)`,
			q.id, search, first, last, q.cursor.AsOf)
	}
	// Seek into the (project, day, previous_day) index once per UTC day.
	return q.count(`WITH RECURSIVE days(day) AS (VALUES(?2) UNION ALL
 SELECT date(day,'+1 day') FROM days WHERE day<?3)
 SELECT count(*) FROM days CROSS JOIN daily_people p WHERE p.project_id=?1 AND p.day=days.day
 AND p.previous_day<?2 AND p.first_ts<=?4`, q.id, first, last, q.cursor.AsOf)
}
