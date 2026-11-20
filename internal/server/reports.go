package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Jc-hammond/birdwatch/internal/storage"
)

type record = map[string]any

// Select lists are the public response fields. Properties remain JSON data.
func records(db storage.Reader, query string, args ...any) ([]record, error) {
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []record{}
	values := make([]any, len(names))
	dest := make([]any, len(names))
	for i := range dest {
		dest[i] = &values[i]
	}
	for rows.Next() {
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		row := record{}
		for i, name := range names {
			row[name] = values[i]
			if t, ok := values[i].(time.Time); ok {
				row[name] = t.UTC().Format(stamp)
			}
		}
		if props, ok := row["properties"].(string); ok {
			row["properties"] = json.RawMessage(props)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Server) projects(r *http.Request) (any, error) {
	var rows []record
	err := s.db.Read(r.Context(), func(db storage.Reader) (err error) {
		rows, err = records(db, "SELECT id,name,sample_as_of,retention_days FROM projects ORDER BY id")
		return
	})
	return record{"projects": rows}, err
}

func badParam(name string) error {
	return failure{400, "invalid_parameter", "Check the " + name + " parameter."}
}

type pageCursor struct {
	Scope    string
	AsOf     string
	MaxID    int64
	Revision int64
	Last     string
	ID       int64
	Person   string
}

type report struct {
	db     storage.Reader
	id     int64
	days   int
	start  time.Time
	cursor pageCursor
	params url.Values
}

func (s *Server) readReport(kind string) endpoint {
	return func(r *http.Request) (any, error) {
		params, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			return nil, badParam("query")
		}
		days := 7
		if raw := params.Get("days"); params.Has("days") {
			days, err = strconv.Atoi(raw)
			if err != nil || (days != 1 && days != 7 && days != 14 && days != 30) {
				return nil, badParam("days")
			}
		}
		rawCursor := params.Get("cursor")
		params.Del("cursor")
		withTotal := params.Has("include_total")
		if withTotal && (params.Get("include_total") != "1" || rawCursor != "" || (kind != "people" && kind != "events")) {
			return nil, badParam("include_total (use 1 on the first page)")
		}
		params.Del("include_total")
		if params.Has("offset") {
			return nil, badParam("offset (use cursor)")
		}
		id, _ := strconv.ParseInt(r.PathValue("project"), 10, 64)
		scope := fmt.Sprintf("%x", sha256.Sum256([]byte(r.URL.Path+"?"+params.Encode())))
		var cursor pageCursor
		if rawCursor != "" {
			if len(rawCursor) > 8192 {
				return nil, badParam("cursor")
			}
			bytes, err := base64.RawURLEncoding.DecodeString(rawCursor)
			if err != nil || json.Unmarshal(bytes, &cursor) != nil || cursor.Scope != scope || cursor.MaxID < 1 || (kind != "events" && kind != "people") {
				return nil, badParam("cursor")
			}
			if _, err = time.Parse(stamp, cursor.AsOf); err != nil {
				return nil, badParam("cursor")
			}
			if _, err = time.Parse(stamp, cursor.Last); err != nil {
				return nil, badParam("cursor")
			}
		}
		var result any
		err = s.db.Read(r.Context(), func(db storage.Reader) error {
			projects, err := records(db, "SELECT id,name,created_at,write_key,sample_as_of,retention_days,retention_revision FROM projects WHERE id=?", id)
			if err != nil {
				return err
			}
			if len(projects) == 0 {
				return failure{404, "not_found", "Project not found. Check the project ID."}
			}
			project := projects[0]
			revision := project["retention_revision"].(int64)
			delete(project, "retention_revision")
			if rawCursor != "" && cursor.Revision != revision {
				return failure{409, "cursor_expired", "Retention or erasure changed this project. Restart from the first page."}
			}
			if kind == "setup" {
				result = project
				return nil
			}
			if rawCursor == "" {
				cursor = pageCursor{Scope: scope, Revision: revision, AsOf: time.Now().UTC().Format(stamp)}
				if frozen, ok := project["sample_as_of"].(string); ok {
					cursor.AsOf = frozen
				}
				if kind == "people" || kind == "events" {
					err = db.QueryRow("SELECT max(deleted_max_id,COALESCE((SELECT id FROM events WHERE project_id=?1 ORDER BY id DESC LIMIT 1),0)) FROM projects WHERE id=?1", id).Scan(&cursor.MaxID)
					if err != nil {
						return err
					}
				}
			}
			end, err := time.Parse(time.RFC3339Nano, cursor.AsOf)
			if err != nil {
				return err
			}
			q := report{db, id, days, end.UTC().Truncate(24*time.Hour).AddDate(0, 0, 1-days), cursor, params}
			switch kind {
			case "events", "people":
				result, err = q.page(kind, withTotal)
			case "overview":
				result, err = q.overview(end)
			case "funnel":
				result, err = q.funnel()
			case "names":
				rows, e := records(db, "SELECT DISTINCT event FROM daily_events WHERE project_id=? ORDER BY event", id)
				names := make([]any, len(rows))
				for i, r := range rows {
					names[i] = r["event"]
				}
				result, err = record{"names": names}, e
			}
			return err
		})
		return result, err
	}
}

const inWindow = "project_id=? AND timestamp BETWEEN ? AND ?"
const eventColumns = "id,event,distinct_id,timestamp,properties"

func (q report) page(kind string, withTotal bool) (any, error) {
	where := inWindow + " AND id<=?"
	args := []any{q.id, q.start.Format(stamp), q.cursor.AsOf, q.cursor.MaxID}
	search := q.params.Get("q")
	if strings.ContainsRune(search, 0) {
		return nil, badParam("q")
	}
	query := ""
	if kind == "events" {
		if search != "" {
			where += " AND (instr(lower(event),lower(?))>0 OR instr(lower(distinct_id),lower(?))>0)"
			args = append(args, search, search)
		}
		for _, filter := range []struct{ key, column string }{{"name", "event"}, {"person", "distinct_id"}} {
			if v := q.params.Get(filter.key); v != "" {
				where += " AND " + filter.column + "=?"
				args = append(args, v)
			}
		}
		if q.cursor.Last != "" {
			where += " AND (timestamp,id)<(?,?)"
			args = append(args, q.cursor.Last, q.cursor.ID)
		}
		query = "SELECT " + eventColumns + " FROM events WHERE " + where + " ORDER BY timestamp DESC,id DESC LIMIT 31"
	} else {
		query, args = q.peoplePage()
	}
	rows, err := records(q.db, query, args...)
	if err != nil {
		return nil, err
	}
	result := record{"as_of": q.cursor.AsOf}
	if withTotal {
		total := int64(len(rows))
		if len(rows) > 30 {
			if kind == "events" {
				total, err = q.eventTotal(where, args)
			} else {
				total, err = q.peopleTotal()
			}
			if err != nil {
				return nil, err
			}
		}
		result["total"] = total
	}
	var next *string
	if len(rows) > 30 {
		rows = rows[:30]
		last := rows[29]
		if kind == "events" {
			q.cursor.Last = last["timestamp"].(string)
			q.cursor.ID = last["id"].(int64)
		} else {
			q.cursor.Last = last["last_seen"].(string)
			q.cursor.Person = last["distinct_id"].(string)
		}
		raw, err := json.Marshal(q.cursor)
		if err != nil {
			return nil, err
		}
		encoded := base64.RawURLEncoding.EncodeToString(raw)
		next = &encoded
	}
	result["rows"], result["next"] = rows, next
	return result, nil
}

func (q report) peoplePage() (string, []any) {
	// Keep each page at its original capture watermark. Only visitors whose
	// summaries include newer rows need their counts reconstructed from events.
	const query = `WITH changed AS MATERIALIZED (
 SELECT distinct_id FROM events INDEXED BY events_project_sequence
 WHERE project_id=?1 AND id>?6 AND timestamp BETWEEN ?2 AND ?3
 UNION SELECT distinct_id FROM events WHERE project_id=?1 AND timestamp>?3 AND timestamp<?10
), candidates AS MATERIALIZED (
 SELECT distinct_id,last_ts FROM daily_people p WHERE project_id=?1 AND last_ts BETWEEN ?2 AND ?3
 AND (last_ts<?8 OR (last_ts=?8 AND distinct_id>?9))
 AND (?7='' OR instr(lower(distinct_id),lower(?7))>0)
 AND distinct_id NOT IN (SELECT distinct_id FROM changed)
 AND NOT EXISTS(SELECT 1 FROM daily_people later WHERE later.project_id=p.project_id
 AND later.distinct_id=p.distinct_id AND later.day>p.day AND later.day<=?4)
 ORDER BY last_ts DESC,distinct_id LIMIT 31
), prior_activity AS (
 SELECT e.distinct_id,1 n,e.timestamp first_ts,e.timestamp last_ts FROM changed c
 CROSS JOIN events e INDEXED BY events_person ON e.project_id=?1 AND e.distinct_id=c.distinct_id
 WHERE e.timestamp BETWEEN ?2 AND ?3 AND e.id<=?6
 UNION ALL SELECT a.distinct_id,a.n,a.first_ts,a.last_ts FROM changed c
 CROSS JOIN expired_counts a ON a.project_id=?1 AND a.distinct_id=c.distinct_id
 WHERE a.day BETWEEN ?5 AND ?4
), snapshot AS (
 SELECT c.distinct_id,SUM(d.count) n,MIN(d.first_ts) first_seen,c.last_ts last_seen
 FROM candidates c CROSS JOIN daily_people d ON d.project_id=?1 AND d.distinct_id=c.distinct_id AND d.day BETWEEN ?5 AND ?4
 GROUP BY c.distinct_id,c.last_ts
 UNION ALL SELECT distinct_id,SUM(n),MIN(first_ts),MAX(last_ts) last_seen FROM prior_activity
 WHERE (?7='' OR instr(lower(distinct_id),lower(?7))>0)
 GROUP BY distinct_id HAVING last_seen<?8 OR (last_seen=?8 AND distinct_id>?9)
)
 SELECT * FROM snapshot ORDER BY last_seen DESC,distinct_id LIMIT 31`
	last := q.cursor.Last
	if last == "" {
		last = q.cursor.AsOf
	}
	return query, []any{q.id, q.start.Format(stamp), q.cursor.AsOf, q.cursor.AsOf[:10], q.start.Format(time.DateOnly), q.cursor.MaxID, q.params.Get("q"), last, q.cursor.Person, q.cursor.AsOf[:10] + "T24"}

}

func (q report) funnel() (any, error) {
	first, second := q.params.Get("first"), q.params.Get("second")
	for _, p := range []string{"first", "second"} {
		value := q.params.Get(p)
		if strings.TrimSpace(value) == "" || len([]rune(value)) > 128 || strings.ContainsRune(value, 0) {
			return nil, badParam(p)
		}
	}
	// The earliest first step maximizes the opportunity to convert. Order ties by insertion.
	var entered, converted int64
	err := q.db.QueryRow(`WITH starts AS (
 SELECT distinct_id,MIN(timestamp) ts FROM events INDEXED BY events_funnel
 WHERE project_id=? AND event=? AND timestamp BETWEEN ? AND ? GROUP BY distinct_id)
 SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM events e WHERE e.project_id=? AND e.distinct_id=s.distinct_id
 AND e.event=? AND e.timestamp BETWEEN s.ts AND ? AND (e.timestamp>s.ts OR e.id>(
 SELECT MIN(id) FROM events a WHERE a.project_id=e.project_id AND a.distinct_id=e.distinct_id
 AND a.event=? AND a.timestamp=s.ts)))),0) FROM starts s`,
		q.id, first, q.start.Format(stamp), q.cursor.AsOf, q.id, second, q.cursor.AsOf, first).Scan(&entered, &converted)
	return record{"entered": entered, "converted": converted}, err
}

func metrics(n, people, pages int64) [4]float64 {
	var avg float64
	if people > 0 {
		avg, _ = strconv.ParseFloat(strconv.FormatFloat(float64(n)/float64(people), 'f', 1, 64), 64)
	}
	return [4]float64{float64(n), float64(people), float64(pages), avg}
}

// A historical comparison can end halfway through a UTC day. Only that
// boundary needs raw timestamps; all complete days come from the summaries.
func (q report) eventDays(start, end time.Time) (string, []any, bool, error) {
	day := end.Format(time.DateOnly)
	next := end.Truncate(24*time.Hour).AddDate(0, 0, 1).Format(stamp)
	var partial bool
	err := q.db.QueryRow("SELECT EXISTS(SELECT 1 FROM events WHERE project_id=? AND timestamp>? AND timestamp<?)", q.id, end.Format(stamp), next).Scan(&partial)
	query := "SELECT day,event,count FROM daily_events WHERE project_id=? AND day BETWEEN ? AND ?"
	args := []any{q.id, start.Format(time.DateOnly), day}
	if partial {
		args[2] = end.AddDate(0, 0, -1).Format(time.DateOnly)
		query += " UNION ALL SELECT substr(timestamp,1,10),event,COUNT(*) FROM events WHERE " + inWindow + " GROUP BY event"
		args = append(args, q.id, end.Truncate(24*time.Hour).Format(stamp), end.Format(stamp))
	}
	return "WITH RECURSIVE counts AS (" + query + ") ", args, partial, err
}

func (q report) overview(end time.Time) (any, error) {
	result := record{"as_of": q.cursor.AsOf}
	for i, field := range []string{"current", "previous"} {
		shift := -i * q.days
		start, stop := q.start.AddDate(0, 0, shift), end.AddDate(0, 0, shift)
		if field == "previous" {
			var archived bool
			day := stop.Format(time.DateOnly)
			if err := q.db.QueryRow("SELECT EXISTS(SELECT 1 FROM expired_counts WHERE project_id=? AND day=?)", q.id, day).Scan(&archived); err != nil {
				return nil, err
			}
			if archived {
				// The archived day no longer has raw timestamps for a partial cutoff.
				stop = stop.Truncate(24*time.Hour).AddDate(0, 0, 1).Add(-time.Microsecond)
				result["previous_full_day"] = day
			}
		}
		counts, args, partial, err := q.eventDays(start, stop)
		if err != nil {
			return nil, err
		}
		daily := "SELECT day,SUM(count) n,SUM(CASE WHEN event IN ('page_view','$pageview') THEN count ELSE 0 END) pages FROM counts GROUP BY day"
		// A visitor's first active day in this window is the one whose
		// predecessor lies before the window. Each visitor contributes once.
		dayPeople := "SELECT COUNT(*) FROM daily_people p WHERE p.project_id=? AND p.day=d.day"
		eligible := ""
		endArgs := []any{}
		if partial {
			eligible = " AND (p.day<? OR p.first_ts<=?)"
			endArgs = []any{stop.Format(time.DateOnly), stop.Format(stamp)}
		}
		dailyArgs := append([]any{}, args...)
		dailyCount := "0"
		if i == 0 {
			dailyCount = dayPeople + eligible
			dailyArgs = append(dailyArgs, q.id)
			dailyArgs = append(dailyArgs, endArgs...)
		}
		windowCount := dayPeople + " AND p.previous_day<?" + eligible
		dailyArgs = append(dailyArgs, q.id, start.Format(time.DateOnly))
		dailyArgs = append(dailyArgs, endArgs...)
		rows, err := records(q.db, counts+"SELECT d.*,("+dailyCount+") people,("+windowCount+") new_in_window FROM ("+daily+") d", dailyArgs...)
		if err != nil {
			return nil, err
		}
		var n, people, pages int64
		days := make(map[string][4]float64, len(rows))
		for _, row := range rows {
			events, views := row["n"].(int64), row["pages"].(int64)
			n += events
			people += row["new_in_window"].(int64)
			pages += views
			days[row["day"].(string)] = metrics(events, row["people"].(int64), views)
		}
		result[field] = metrics(n, people, pages)
		if i != 0 {
			continue
		}
		series := make([]record, q.days)
		for j := range series {
			day := start.AddDate(0, 0, j).Format(time.DateOnly)
			series[j] = record{"date": day, "values": days[day]}
		}
		result["series"] = series
		result["top"], err = records(q.db, counts+"SELECT event,SUM(count) n FROM counts GROUP BY event ORDER BY n DESC,event LIMIT 5", args...)
		if err != nil {
			return nil, err
		}
	}
	recent, err := records(q.db, "SELECT "+eventColumns+" FROM events WHERE "+inWindow+" ORDER BY timestamp DESC,id DESC LIMIT 5", q.id, q.start.Format(stamp), q.cursor.AsOf)
	result["recent"] = recent
	return result, err
}
