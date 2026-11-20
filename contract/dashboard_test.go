package contract_test

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestDashboardAssets(t *testing.T) {
	s := startEmpty(t)
	identity := http.Header{"Accept-Encoding": {"identity"}}
	index := s.expect(t, 200, "GET", "/", nil, identity)
	etag := index.header.Get("ETag")
	if etag == "" || index.header.Get("Cache-Control") != "no-cache" {
		t.Fatal("dashboard index lacks revalidation headers")
	}
	s.expect(t, 304, "GET", "/", nil, http.Header{"If-None-Match": {etag}, "Accept-Encoding": {"identity"}})
	match := regexp.MustCompile(`(?:src|href)="(/assets/[^"]+\.(?:js|css))"`).FindAllSubmatch(index.body, -1)
	var hashed string
	hash := regexp.MustCompile(`[-.][a-fA-F0-9]{8,}\.`)
	for _, m := range match {
		if hash.Match(m[1]) {
			hashed = string(m[1])
			break
		}
	}
	if hashed == "" {
		t.Fatal("dashboard missing its hashed application asset")
	}
	plain := s.expect(t, 200, "GET", hashed, nil, identity)
	zipped := s.expect(t, 200, "GET", hashed, nil, http.Header{"Accept-Encoding": {"gzip"}})
	if !strings.Contains(zipped.header.Get("Cache-Control"), "max-age=31536000") || !strings.Contains(zipped.header.Get("Cache-Control"), "immutable") || zipped.header.Get("Content-Encoding") != "gzip" {
		t.Fatal("hashed asset lacks immutable caching or gzip")
	}
	zr, err := gzip.NewReader(bytes.NewReader(zipped.body))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(zr)
	zr.Close()
	if err != nil || !bytes.Equal(data, plain.body) {
		t.Fatal("encoded asset differs from its identity representation")
	}
	script := s.expect(t, 200, "HEAD", "/birdwatch.js", nil, http.Header{"Origin": {"https://app.test"}})
	if script.header.Get("Access-Control-Allow-Origin") != "*" || len(script.body) != 0 {
		t.Fatal("cross-origin script HEAD response is invalid")
	}
	s.expect(t, 405, "POST", "/", nil, nil)
	missing := s.expect(t, 404, "GET", "/assets/../outside", nil, nil)
	if decode[struct{ Code string }](t, missing).Code != "not_found" {
		t.Fatal("unknown file did not return a JSON error")
	}
}
