package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Jc-hammond/birdwatch/internal/storage"
	"github.com/ncruces/go-sqlite3"
	"log"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/Jc-hammond/birdwatch/internal/dashboard"
)

const maxBody = 1 << 20

type endpoint func(*http.Request) (any, error)

type httpResult struct {
	status int
	body   any
}

type Server struct {
	db         *storage.Store
	routes     map[string]map[string]endpoint
	active     chan struct{}
	log        *log.Logger
	credential []byte
}

func New(logger *log.Logger, password string, db *storage.Store) *Server {
	s := &Server{
		db: db,
		routes: map[string]map[string]endpoint{
			"/healthz": {"GET": func(r *http.Request) (any, error) {
				if err := db.Health(r.Context()); err != nil {
					return nil, failure{503, "unavailable", "Database unavailable. Retry in one second."}
				}
				return map[string]bool{"ok": true}, nil
			}},
		},
		active:     make(chan struct{}, 256),
		log:        logger,
		credential: dashboardCredential(password),
	}
	s.routes["/api/projects"] = map[string]endpoint{"POST": s.createProject}
	s.routes["/api/projects/{project}/setup"] = map[string]endpoint{"GET": s.setup}
	s.routes["/api/capture"] = map[string]endpoint{"POST": s.capture, "OPTIONS": nil}
	return s
}

type failure struct {
	status  int
	Code    string `json:"code"`
	Message string `json:"error"`
}

func (f failure) Error() string { return f.Message }

var internalError = failure{500, "internal", "Unexpected server error. Retry the request."}
var tooLargeError = failure{413, "too_large", "Limit the request body to 1 MiB."}

var assetMethods = map[string]endpoint{http.MethodGet: nil, http.MethodHead: nil}

func resolve(w http.ResponseWriter, r *http.Request, methods map[string]endpoint) (endpoint, error) {
	if methods == nil {
		return nil, failure{404, "not_found", "Unknown endpoint. Check the request path."}
	}
	fn, allowed := methods[r.Method]
	if !allowed {
		for method := range methods {
			w.Header().Add("Allow", method)
		}
		return nil, failure{405, "method_not_allowed", "Use a supported HTTP method for this endpoint."}
	}
	if r.ContentLength > maxBody {
		return nil, tooLargeError
	}
	if r.ContentLength < 0 {
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		// POST handlers finish reading before opening a transaction.
		if r.Method != http.MethodPost {
			if _, err := readBody(r.Body); err != nil {
				return nil, err
			}
		}
	}
	return fn, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	pattern := "unmatched"
	route := r.URL.Path
	if tail, ok := strings.CutPrefix(route, "/api/projects/"); ok {
		id, kind, _ := strings.Cut(tail, "/")
		if _, err := strconv.ParseUint(id, 10, 60); err == nil && len(id) <= 18 {
			route = "/api/projects/{project}/" + kind
			r.SetPathValue("project", id)
		}
	}
	methods := s.routes[route]
	asset := dashboard.Lookup(r.URL.Path)
	if asset != nil {
		pattern = "dashboard"
		methods = assetMethods
	} else if methods != nil {
		// Only exact, registered paths reach the log.
		pattern = route
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
	public := publicRoute(r.URL.Path)
	setSecurityHeaders(w.Header(), r.URL.Path, public)
	select {
	case s.active <- struct{}{}:
		defer func() { <-s.active }()
	default:
		w.Header().Set("Retry-After", "1")
		status = writeJSON(w, 503, failure{503, "unavailable", "Server is busy. Retry in one second."})
		return
	}
	if !public {
		if denied := s.authorize(w, r); denied != nil {
			w.Header().Set("Cache-Control", "no-store")
			status = writeJSON(w, denied.status, denied)
			return
		}
	}
	var body any
	fn, err := resolve(w, r, methods)
	if err == nil {
		if asset != nil {
			status = asset.Serve(w, r)
			return
		}
		if route == "/api/capture" && r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			status = http.StatusNoContent
			w.WriteHeader(status)
			return
		}
		body, err = fn(r)
		if result, ok := body.(httpResult); ok {
			status, body = result.status, result.body
		}
	}
	if err != nil {
		var f failure
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, sqlite3.BUSY) {
			f = failure{503, "unavailable", "Database busy. Retry in one second."}
		} else if !errors.As(err, &f) {
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
