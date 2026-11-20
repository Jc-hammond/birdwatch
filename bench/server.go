package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type instance struct {
	cmd *exec.Cmd
	url string
}

func launch(ctx context.Context, db string) (*instance, error) {
	spec := os.Getenv("BIRDWATCH_SERVER_CMD")
	args := strings.Fields(spec)
	dir := ""
	if info, err := os.Stat(spec); err == nil && info.Mode().IsRegular() {
		path, err := filepath.Abs(spec)
		if err != nil {
			return nil, err
		}
		args = []string{path}
		dir = filepath.Dir(db)
	}
	if len(args) == 0 {
		return nil, errors.New("set BIRDWATCH_SERVER_CMD to the server command")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	addr := listener.Addr().(*net.TCPAddr)
	if err := listener.Close(); err != nil {
		return nil, err
	}
	args = append(args, "--host", "127.0.0.1", "--port", fmt.Sprint(addr.Port), "--db", db, "--no-demo")
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	configureProcess(cmd)
	cmd.Dir = dir
	cmd.Env = append(cmd.Environ(), "BIRDWATCH_PASSWORD=")
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for ctx.Err() == nil && time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp4", addr.String(), 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return &instance{cmd, "http://" + addr.String()}, nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	_, _ = stop(cmd)
	return nil, errors.New("server did not accept loopback connections within 10 seconds")
}

var client = &http.Client{Timeout: 60 * time.Second}

func request(ctx context.Context, method, url string, body []byte, status int, result any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		// URL errors contain query filters. Keep only the underlying transport error.
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			return context.DeadlineExceeded
		}
		return errors.New("server connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != status {
		return fmt.Errorf("server returned HTTP %d, want %d", resp.StatusCode, status)
	}
	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	_, err = io.Copy(io.Discard, resp.Body)
	return err
}

func project(ctx context.Context, url string) (path, key string, err error) {
	var created struct{ ID int }
	if err = request(ctx, "POST", url+"/api/projects", []byte(`{"name":"Benchmark"}`), 201, &created); err != nil {
		return
	}
	path = fmt.Sprintf("/api/projects/%d/", created.ID)
	var setup struct {
		Key string `json:"write_key"`
	}
	err = request(ctx, "GET", url+path+"setup", nil, 200, &setup)
	if err == nil && setup.Key == "" {
		err = errors.New("project setup returned no write key")
	}
	return path, setup.Key, err
}
