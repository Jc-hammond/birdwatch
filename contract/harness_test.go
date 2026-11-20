package contract_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type object = map[string]any

type server struct {
	url  string
	stop func()
}

// These cases run by default, including against the Go server. Only the Python
// reference run skips them; keep shared behaviour covered in both modes.
var pythonGaps = map[string]string{
	"TestDashboardAssets":                  "dashboard lacks ETags and build-time gzip",
	"TestConcurrentCapture":                "concurrent writes lose events",
	"TestCaptureErrors/invalid_event":      "capture errors lack a code",
	"TestCaptureErrors/unknown_key":        "capture errors lack a code",
	"TestCaptureErrors/too_large":          "oversized batches return 400",
	"TestBatchResults/partial":             "a mixed batch always rolls back",
	"TestBatchResults/atomic":              "rollback lacks per-event rejection details",
	"TestCaptureClock/clamp_future":        "future timestamps are rejected",
	"TestCaptureClock/sent_at":             "sent_at is ignored",
	"TestTextPlainCapture":                 "capture requires application/json",
	"TestCapturePreflight":                 "preflight lacks the 24-hour max age",
	"TestRoutingErrors/unsupported_method": "unsupported method returns HTML",
	"TestRoutingErrors/unknown_route":      "unknown route error lacks a code",
}

func start(t *testing.T, db string, demo bool, password string) server {
	t.Helper()
	if reason, known := pythonGaps[t.Name()]; known && os.Getenv("BIRDWATCH_REFERENCE") == "python" {
		t.Skip("Python reference:", reason)
	}
	spec := os.Getenv("BIRDWATCH_SERVER_CMD")
	command := strings.Fields(spec)
	runDir := ".."
	// A single executable must run without the source checkout. Keep interpreter
	// commands such as "python3 server.py" relative to the module root.
	executable := spec
	if !filepath.IsAbs(executable) {
		executable = filepath.Join(runDir, executable)
	}
	if info, err := os.Stat(executable); err == nil && info.Mode().IsRegular() {
		absolute, err := filepath.Abs(executable)
		if err != nil {
			t.Fatal(err)
		}
		command = []string{absolute}
		runDir = t.TempDir()
	}
	if len(command) == 0 {
		t.Fatal("set BIRDWATCH_SERVER_CMD to the server command, e.g. python3 server.py")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().(*net.TCPAddr)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	args := append(command[1:], "--host", "127.0.0.1", "--port", strconv.Itoa(addr.Port), "--db", db)
	if !demo {
		args = append(args, "--no-demo")
	}
	cmd := exec.Command(command[0], args...)
	cmd.Dir = runDir
	cmd.Env = append(cmd.Environ(), "BIRDWATCH_PASSWORD="+password)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	stop := func() {
		_ = cmd.Process.Kill()
		<-done
	}
	t.Cleanup(stop)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			t.Fatalf("server exited before accepting connections (%s)", cmd.ProcessState)
		default:
		}
		conn, err := net.DialTimeout("tcp", addr.String(), 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return server{"http://" + addr.String(), stop}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("server did not accept connections within 10 seconds")
	return server{}
}

func startEmpty(t *testing.T) server {
	t.Helper()
	return start(t, filepath.Join(t.TempDir(), "events.sqlite3"), false, "")
}

type response struct {
	status int
	header http.Header
	body   []byte
}

var client = &http.Client{
	Timeout: 20 * time.Second,
	// Assert the status returned by Birdwatch itself.
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func (s server) request(method, path string, payload any, headers http.Header) (response, error) {
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return response{}, err
		}
	}
	req, err := http.NewRequest(method, s.url+path, bytes.NewReader(body))
	if err != nil {
		return response{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	for key, values := range headers {
		if key == "Host" {
			req.Host = values[0]
		} else {
			req.Header[key] = values
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		// net/url errors include the request URL, which may contain private filters.
		return response{}, errors.New("HTTP request failed: no response received")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return response{resp.StatusCode, resp.Header, data}, err
}

func (s server) expect(t *testing.T, status int, method, path string, payload any, headers http.Header) response {
	t.Helper()
	r, err := s.request(method, path, payload, headers)
	if err != nil {
		t.Fatal(err)
	}
	if r.status != status {
		t.Fatalf("%s returned HTTP %d, want %d", method, r.status, status)
	}
	return r
}

func decode[T any](t *testing.T, r response) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(r.body, &value); err != nil {
		t.Fatalf("invalid JSON response (HTTP %d): %v", r.status, err)
	}
	return value
}
