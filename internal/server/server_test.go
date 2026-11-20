package server

import (
	"encoding/json"
	"github.com/Jc-hammond/birdwatch/internal/storage"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestPanicReturnsJSONAndServerKeepsServing(t *testing.T) {
	db, err := storage.Open(t.Context(), filepath.Join(t.TempDir(), "events.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := New(log.New(io.Discard, "", 0), "", db)
	s.routes["/panic"] = map[string]endpoint{"GET": func(*http.Request) (any, error) { panic("test") }}
	ts := httptest.NewServer(s)
	defer ts.Close()
	for _, tc := range []struct {
		path   string
		status int
	}{{"/panic", 500}, {"/healthz", 200}} {
		resp, err := ts.Client().Get(ts.URL + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Code, Error string
			OK          bool
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != tc.status {
			t.Fatalf("%s: HTTP %d, JSON error %v", tc.path, resp.StatusCode, err)
		}
		if tc.status == 500 && (body.Code != "internal" || body.Error == "") {
			t.Fatal("missing internal error details")
		}
		if tc.status == 200 && !body.OK {
			t.Fatal("health check failed after panic")
		}
	}
}
