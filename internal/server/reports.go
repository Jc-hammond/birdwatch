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
		rows, err = records(db, "SELECT id,name,sample_as_of FROM projects ORDER BY id")
		return
	})
	return record{"projects": rows}, err
}

func badParam(name string) error {
	return failure{400, "invalid_parameter", "Check the " + name + " parameter."}
}

type pageCursor struct {
	Scope  string
	AsOf   string
	MaxID  int64
	Last   string
	ID     int64
	Person string
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
			projects, err := records(db, "SELECT id,name,created_at,write_key,sample_as_of FROM projects WHERE id=?", id)
			if err != nil {
				return err
			}
			if len(projects) == 0 {
				return failure{404, "not_found", "Project not found. Check the project ID."}
			}
			project := projects[0]
			if kind == "setup" {
				result = project
				return nil
			}
			if rawCursor == "" {
				cursor = pageCursor{Scope: scope, AsOf: time.Now().UTC().Format(stamp)}
				if frozen, ok := project["sample_as_of"].(string); ok {
					cursor.AsOf = frozen
				}
				if kind == "people" || kind == "events" {
					err = db.QueryRow("SELECT COALESCE((SELECT id FROM events WHERE project_id=? ORDER BY id DESC LIMIT 1),0)", id).Scan(&cursor.MaxID)
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
				result, err = q.page(kind)
			case "overview":
				result, err = q.overview(end)
			case "funnel":
				result, err = q.funnel()
			case "names":
				rows, e := records(db, "SELECT DISTINCT event FROM events WHERE project_id=? ORDER BY event", id)
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

func (q report) page(kind string) (any, error) {
	where := inWindow + " AND id<=?"
	args := []any{q.id, q.start.Format(stamp), q.cursor.AsOf, q.cursor.MaxID}
	if search := q.params.Get("q"); search != "" {
		if strings.ContainsRune(search, 0) {
			return nil, badParam("q")
		}
		if kind == "events" {
			where += " AND (instr(lower(event),lower(?))>0 OR instr(lower(distinct_id),lower(?))>0)"
			args = append(args, search, search)
		} else {
			where += " AND instr(lower(distinct_id),lower(?))>0"
			args = append(args, search)
		}
	}
	query := ""
	if kind == "events" {
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
		query = "SELECT distinct_id,COUNT(*) n,MIN(timestamp) first_seen,MAX(timestamp) last_seen FROM events WHERE " + where + " GROUP BY distinct_id"
		if q.cursor.Last != "" {
			query += " HAVING last_seen<? OR (last_seen=? AND distinct_id>?)"
			args = append(args, q.cursor.Last, q.cursor.Last, q.cursor.Person)
		}
		query += " ORDER BY last_seen DESC,distinct_id LIMIT 31"
	}
	rows, err := records(q.db, query, args...)
	if err != nil {
		return nil, err
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
	return record{"rows": rows, "next": next, "as_of": q.cursor.AsOf}, nil
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
 SELECT distinct_id,timestamp,id,ROW_NUMBER() OVER(PARTITION BY distinct_id ORDER BY timestamp,id) AS rank
 FROM events WHERE project_id=? AND event=? AND timestamp BETWEEN ? AND ?)
 SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM events e WHERE e.project_id=? AND e.distinct_id=s.distinct_id
 AND e.event=? AND (e.timestamp,e.id)>(s.timestamp,s.id) AND e.timestamp<=?)),0) FROM starts s WHERE rank=1`,
		q.id, first, q.start.Format(stamp), q.cursor.AsOf, q.id, second, q.cursor.AsOf).Scan(&entered, &converted)
	return record{"entered": entered, "converted": converted}, err
}

const totals = "COUNT(*) n,COUNT(DISTINCT distinct_id) people,COALESCE(SUM(event IN ('page_view','$pageview')),0) pages"

func metrics(n, people, pages int64) [4]float64 {
	var avg float64
	if people > 0 {
		avg, _ = strconv.ParseFloat(strconv.FormatFloat(float64(n)/float64(people), 'f', 1, 64), 64)
	}
	return [4]float64{float64(n), float64(people), float64(pages), avg}
}

func (q report) overview(end time.Time) (any, error) {
	result := record{"as_of": q.cursor.AsOf}
	for i, field := range []string{"current", "previous"} {
		shift := -i * q.days
		var n, people, pages int64
		err := q.db.QueryRow("SELECT "+totals+" FROM events WHERE "+inWindow, q.id, q.start.AddDate(0, 0, shift).Format(stamp), end.AddDate(0, 0, shift).Format(stamp)).Scan(&n, &people, &pages)
		if err != nil {
			return nil, err
		}
		result[field] = metrics(n, people, pages)
	}
	args := []any{q.id, q.start.Format(stamp), q.cursor.AsOf}
	rows, err := records(q.db, "SELECT substr(timestamp,1,10) day,"+totals+" FROM events WHERE "+inWindow+" GROUP BY day", args...)
	if err != nil {
		return nil, err
	}
	byDay := map[string][4]float64{}
	for _, row := range rows {
		byDay[row["day"].(string)] = metrics(row["n"].(int64), row["people"].(int64), row["pages"].(int64))
	}
	series := make([]record, q.days)
	for i := range series {
		day := q.start.AddDate(0, 0, i).Format(time.DateOnly)
		series[i] = record{"date": day, "values": byDay[day]}
	}
	result["series"] = series
	result["top"], err = records(q.db, "SELECT event,COUNT(*) n FROM events WHERE "+inWindow+" GROUP BY event ORDER BY n DESC,event LIMIT 5", args...)
	if err != nil {
		return nil, err
	}
	result["recent"], err = records(q.db, "SELECT "+eventColumns+" FROM events WHERE "+inWindow+" ORDER BY timestamp DESC,id DESC LIMIT 5", args...)
	return result, err
}
