package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"runtime/debug"
	"time"
)

const maxBody = 1 << 20

type endpoint func(*http.Request) (any, error)

type Server struct {
	routes map[string]map[string]endpoint
	active chan struct{}
	log    *log.Logger
}

func New(logger *log.Logger, health func(context.Context) error) *Server {
	return &Server{
		routes: map[string]map[string]endpoint{
			"/healthz": {"GET": func(r *http.Request) (any, error) {
				if err := health(r.Context()); err != nil {
					return nil, failure{503, "unavailable", "Database unavailable. Retry in one second."}
				}
				return map[string]bool{"ok": true}, nil
			}},
		},
		active: make(chan struct{}, 256),
		log:    logger,
	}
}

type failure struct {
	status  int
	Code    string `json:"code"`
	Message string `json:"error"`
}

func (f failure) Error() string { return f.Message }

var internalError = failure{500, "internal", "Unexpected server error. Retry the request."}
var tooLargeError = failure{413, "too_large", "Limit the request body to 1 MiB."}

func handle(w http.ResponseWriter, r *http.Request, methods map[string]endpoint) (any, error) {
	if methods == nil {
		return nil, failure{404, "not_found", "Unknown endpoint. Check the request path."}
	}
	fn := methods[r.Method]
	if fn == nil {
		for method := range methods {
			w.Header().Add("Allow", method)
		}
		return nil, failure{405, "method_not_allowed", "Use a supported HTTP method for this endpoint."}
	}
	if r.ContentLength > maxBody {
		return nil, tooLargeError
	}
	if r.ContentLength < 0 {
		// A chunked request has no declared size. Verify it before the handler can act.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return nil, tooLargeError
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				w.Header().Set("Retry-After", "1")
				return nil, failure{503, "unavailable", "Request body timed out. Retry in one second."}
			}
			return nil, failure{400, "invalid_event", "Could not read the request body."}
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	return fn(r)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	pattern := "unmatched"
	methods := s.routes[r.URL.Path]
	if methods != nil {
		// Only exact, registered paths reach the log.
		pattern = r.URL.Path
	}
	status := http.StatusOK
	defer func() {
		if recover() != nil {
			s.log.Printf("handler panic\n%s", debug.Stack())
			status = internalError.status
			writeJSON(w, status, internalError)
		}
		s.log.Printf("method=%s route=%s status=%d duration=%s", r.Method, pattern, status, time.Since(start))
	}()
	select {
	case s.active <- struct{}{}:
		defer func() { <-s.active }()
	default:
		w.Header().Set("Retry-After", "1")
		status = writeJSON(w, 503, failure{503, "unavailable", "Server is busy. Retry in one second."})
		return
	}
	body, err := handle(w, r, methods)
	if err != nil {
		var f failure
		if !errors.As(err, &f) {
			f = internalError
		}
		if f.status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "1")
		}
		status, body = f.status, f
	}
	status = writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, value any) int {
	data, err := json.Marshal(value)
	if err != nil {
		status = internalError.status
		data, _ = json.Marshal(internalError)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
	return status
}
