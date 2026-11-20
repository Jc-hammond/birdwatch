package main

import (
	"bufio"
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
	args = append(args, "--host", "127.0.0.1", "--port", "0", "--db", db, "--no-demo")
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = append(cmd.Environ(), "BIRDWATCH_PASSWORD=")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	addr := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(out)
		line, _ := reader.ReadString('\n')
		host, port, err := net.SplitHostPort(strings.TrimPrefix(strings.TrimSpace(line), "Birdwatch listening at http://"))
		if err != nil || host != "127.0.0.1" || port == "" {
			addr <- ""
		} else {
			addr <- "http://" + net.JoinHostPort(host, port)
		}
		_, _ = io.Copy(io.Discard, reader)
	}()
	select {
	case url := <-addr:
		if url != "" {
			return &instance{cmd, url}, nil
		}
	case <-time.After(10 * time.Second):
	case <-ctx.Done():
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return nil, errors.New("server did not announce its loopback address within 10 seconds")
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
