package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Jc-hammond/birdwatch/internal/storage"
)

type fields = map[string]json.RawMessage

func readObject(r *http.Request) (fields, error) {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, invalid("Could not read the request. Send a complete JSON object.")
	}
	var value fields
	if !utf8.Valid(data) || json.Unmarshal(data, &value) != nil || value == nil {
		return nil, invalid("Send a JSON object.")
	}
	return value, nil
}

func invalid(message string) failure { return failure{400, "invalid_event", message} }

func stringField(raw json.RawMessage, name string, limit int) (string, error) {
	var value string
	if json.Unmarshal(raw, &value) != nil || strings.TrimSpace(value) == "" || strings.ContainsRune(value, 0) || utf8.RuneCountInString(value) > limit {
		return "", invalid(fmt.Sprintf("%s must be a nonblank string of at most %d characters without NUL.", name, limit))
	}
	return value, nil
}

// Fixed-width UTC makes SQLite text order chronological, including fractional seconds.
const stamp = "2006-01-02T15:04:05.000000Z"

func (s *Server) createProject(r *http.Request) (any, error) {
	body, err := readObject(r)
	if err != nil {
		return nil, err
	}
	name, err := stringField(body["name"], "name", 60)
	if err != nil {
		return nil, err
	}
	var id int64
	err = s.db.Write(r.Context(), func(ctx context.Context, tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, "INSERT INTO projects(name,write_key,created_at) VALUES(?,?,?) RETURNING id", strings.TrimSpace(name), "bw_"+rand.Text(), time.Now().UTC().Format(stamp)).Scan(&id)
	})
	return httpResult{201, map[string]int64{"id": id}}, err
}

func (s *Server) setup(r *http.Request) (any, error) {
	var id int64
	var name, created string
	var key, asOf *string
	err := s.db.Read(r.Context(), func(reader storage.Reader) error {
		return reader.QueryRow("SELECT id,name,created_at,write_key,sample_as_of FROM projects WHERE id=?", r.PathValue("project")).Scan(&id, &name, &created, &key, &asOf)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, failure{404, "not_found", "Project not found. Check the project ID."}
	}
	return map[string]any{"id": id, "name": name, "created_at": created, "write_key": key, "sample_as_of": asOf}, err
}

type receiptTime struct{}
type rejection struct {
	Index   int    `json:"index"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type acknowledgement struct {
	Accepted   int         `json:"accepted"`
	Duplicates int         `json:"duplicates"`
	Rejected   []rejection `json:"rejected"`
}

func clockValue(raw json.RawMessage) (time.Time, bool) {
	var text string
	if json.Unmarshal(raw, &text) != nil || len(text) > 64 {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04:05Z07"} {
		if t, err := time.Parse(layout, strings.Replace(text, " ", "T", 1)); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func (s *Server) capture(r *http.Request) (any, error) {
	received := r.Context().Value(receiptTime{}).(time.Time)
	body, err := readObject(r)
	if err != nil {
		return nil, err
	}
	key, err := stringField(body["api_key"], "api_key", 128)
	if err != nil {
		return nil, err
	}
	var batch []json.RawMessage
	atomic := true
	if raw, ok := body["batch"]; ok {
		if json.Unmarshal(raw, &batch) != nil || len(batch) == 0 {
			return nil, invalid("Send a batch array of 1–100 events.")
		}
		if len(batch) > 100 {
			return nil, failure{413, "too_large", "Limit a batch to 100 events."}
		}
		atomic = string(body["atomic"]) == "true"
	}
	sent, hasSent := clockValue(body["sent_at"])
	ack := acknowledgement{Rejected: []rejection{}}
	err = s.db.Write(r.Context(), func(ctx context.Context, tx *sql.Tx) error {
		var project int64
		err := tx.QueryRowContext(ctx, "SELECT id FROM projects WHERE write_key=?", key).Scan(&project)
		if errors.Is(err, sql.ErrNoRows) {
			return failure{401, "unknown_key", "Unknown project write key. Copy the key from the project's Setup page."}
		}
		if err != nil {
			return err
		}
		for i := 0; i < max(1, len(batch)); i++ {
			item := body
			if batch != nil {
				item = nil
				_ = json.Unmarshal(batch[i], &item)
			}
			duplicate, err := storeEvent(ctx, tx, project, item, received, sent, hasSent)
			var f failure
			switch {
			case errors.As(err, &f):
				ack.Rejected = append(ack.Rejected, rejection{i, f.Code, f.Message})
			case err != nil:
				return err
			case duplicate:
				ack.Duplicates++
			default:
				ack.Accepted++
			}
		}
		if atomic && len(ack.Rejected) > 0 {
			return invalid("Correct the rejected events and resend. No events were stored.")
		}
		return nil
	})
	if err != nil && atomic && len(ack.Rejected) > 0 {
		var f failure
		if errors.As(err, &f) && f.Code == "invalid_event" {
			return httpResult{400, struct {
				failure
				Rejected []rejection `json:"rejected"`
			}{f, ack.Rejected}}, nil
		}
	}
	return ack, err
}

func storeEvent(ctx context.Context, tx *sql.Tx, project int64, item fields, received, sent time.Time, hasSent bool) (bool, error) {
	var uuid any
	if raw, ok := item["uuid"]; ok {
		id, err := stringField(raw, "uuid", 128)
		if err != nil {
			return false, err
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM events WHERE project_id=? AND uuid=?)", project, id).Scan(&exists); err != nil || exists {
			return exists, err
		}
		uuid = id
	}
	name, err := stringField(item["event"], "event", 128)
	if err != nil {
		return false, err
	}
	person, err := stringField(item["distinct_id"], "distinct_id", 256)
	if err != nil {
		return false, err
	}
	props := "{}"
	if raw, ok := item["properties"]; ok {
		if len(raw) == 0 || raw[0] != '{' {
			return false, invalid("Send properties as a JSON object.")
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err != nil {
			return false, invalid("Send valid JSON properties.")
		}
		if compact.Len() > 32768 {
			return false, failure{413, "too_large", "Limit compact properties to 32 KiB."}
		}
		props = compact.String()
	}
	ts := received
	if raw, ok := item["timestamp"]; ok {
		ts, ok = clockValue(raw)
		if !ok {
			return false, invalid("Use an ISO 8601 timestamp with a time zone.")
		}
		if hasSent {
			ts = time.Unix(ts.Unix()+received.Unix()-sent.Unix(), int64(ts.Nanosecond()+received.Nanosecond()-sent.Nanosecond())).UTC()
		}
		if ts.After(received) {
			ts = received
		}
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO events(project_id,event,distinct_id,timestamp,properties,uuid) VALUES(?,?,?,?,?,?)", project, name, person, ts.Format(stamp), props, uuid)
	return false, err
}
