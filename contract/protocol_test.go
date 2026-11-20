package contract_test

import (
	"mime"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

type acknowledgement struct {
	Accepted, Duplicates *int // A missing counter is different from zero.
	Rejected             []rejection
}

func (a acknowledgement) counts(accepted, duplicates int) bool {
	return a.Accepted != nil && *a.Accepted == accepted && a.Duplicates != nil && *a.Duplicates == duplicates
}

func expectCounts(t *testing.T, r response, accepted, duplicates int) acknowledgement {
	t.Helper()
	ack := decode[acknowledgement](t, r)
	if !ack.counts(accepted, duplicates) {
		t.Errorf("expected acknowledgement with accepted=%d and duplicates=%d", accepted, duplicates)
	}
	return ack
}

type apiError struct {
	Code     string
	Error    string
	Rejected []rejection
}

type rejection struct {
	Index         *int
	Code, Message string
}

func errorBody(t *testing.T, r response) apiError {
	t.Helper()
	media, _, err := mime.ParseMediaType(r.header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		t.Fatal("expected an application/json error response")
	}
	body := decode[apiError](t, r)
	if strings.TrimSpace(body.Code) == "" || strings.TrimSpace(body.Error) == "" {
		t.Error("expected a nonempty error message and code")
	}
	return body
}

func TestCaptureErrors(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"invalid_event", 400},
		{"unknown_key", 401},
		{"too_large", 413},
	} {
		t.Run(tc.code, func(t *testing.T) {
			s := startEmpty(t)
			p := s.createProject(t, "Errors")
			body := event("page_view", "a")
			switch tc.code {
			case "invalid_event":
				body["event"] = ""
			case "unknown_key":
				p.key = "unknown"
			case "too_large":
				batch := make([]object, 101)
				for i := range batch {
					batch[i] = event("page_view", "a")
				}
				body = object{"batch": batch}
			}
			r := s.capture(t, p, body, tc.status)
			check(t, "error code", errorBody(t, r).Code, tc.code)
		})
	}
}

func TestBatchResults(t *testing.T) {
	for _, mode := range []string{"partial", "atomic"} {
		t.Run(mode, func(t *testing.T) {
			s := startEmpty(t)
			p := s.createProject(t, "Batch results")
			body := object{"batch": []object{event("first", "a"), event("", "a"), event("last", "a")}}
			var rejected []rejection
			if mode == "atomic" {
				body["atomic"] = true
				r := s.capture(t, p, body, 400)
				check(t, "stored", len(s.captureRows(t, p)), 0)
				failure := errorBody(t, r)
				check(t, "error code", failure.Code, "invalid_event")
				rejected = failure.Rejected
			} else {
				r := s.capture(t, p, body, 200)
				rejected = expectCounts(t, r, 2, 0).Rejected
				rows := s.captureRows(t, p)
				var names []string
				for _, row := range rows {
					names = append(names, row.Event)
				}
				slices.Sort(names)
				check(t, "stored event names", names, []string{"first", "last"})
			}
			if len(rejected) != 1 {
				t.Fatalf("got %d rejections, want one", len(rejected))
			}
			bad := rejected[0]
			if bad.Index == nil || *bad.Index != 1 || bad.Code != "invalid_event" || strings.TrimSpace(bad.Message) == "" {
				t.Error("expected invalid_event with a message at batch index 1")
			}
		})
	}
}

func TestCaptureClock(t *testing.T) {
	for _, mode := range []string{"clamp_future", "sent_at"} {
		t.Run(mode, func(t *testing.T) {
			s := startEmpty(t)
			p := s.createProject(t, "Clocks")
			before := time.Now().UTC()
			fast := before.Truncate(time.Second).Add(time.Hour)
			item := event("clock", "a")
			item["timestamp"] = fast
			batch := object{"batch": []object{item}}
			var age time.Duration
			if mode == "sent_at" {
				// Still in the past on receipt, so clamping alone cannot pass.
				age = 2 * time.Hour
				batch["sent_at"] = fast
				item["timestamp"] = fast.Add(-age)
			}
			r := s.capture(t, p, batch, 200)
			after := time.Now().UTC()
			expectCounts(t, r, 1, 0)
			events := s.captureRows(t, p)
			if len(events) != 1 {
				t.Fatal("expected one stored event in the report")
			}
			// Allow second-resolution timestamps, using only the capture round trip as the receipt window.
			stored := events[0].Timestamp
			if stored.Before(before.Add(-age).Truncate(time.Second)) || stored.After(after.Add(-age)) {
				t.Errorf("stored time %s outside the expected receipt window for age %s", stored, age)
			}
		})
	}
}

func TestTextPlainCapture(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Browser")
	body := event("page_view", "a")
	body["api_key"] = p.key
	r := s.expect(t, 200, "POST", "/api/capture", body, http.Header{"Content-Type": {"text/plain"}})
	expectCounts(t, r, 1, 0)
	check(t, "stored", len(s.captureRows(t, p)), 1)
}

func TestCapturePreflight(t *testing.T) {
	s := startEmpty(t)
	r := s.expect(t, 204, "OPTIONS", "/api/capture", nil, http.Header{
		"Origin":                         {"https://app.test"},
		"Access-Control-Request-Method":  {"POST"},
		"Access-Control-Request-Headers": {"Content-Type"},
	})
	check(t, "preflight max age", r.header.Get("Access-Control-Max-Age"), "86400")
}

func TestRoutingErrors(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		status             int
	}{
		{"unsupported_method", "PUT", "/healthz", 405},
		{"unknown_route", "GET", "/api/no-such-route", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := startEmpty(t)
			r := s.expect(t, tc.status, tc.method, tc.path, nil, nil)
			errorBody(t, r)
		})
	}
}
