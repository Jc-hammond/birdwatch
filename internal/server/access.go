package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
)

const dashboardCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"

func dashboardCredential(password string) []byte {
	if password == "" {
		return nil
	}
	digest := sha256.Sum256([]byte("admin:" + password))
	return digest[:]
}

func localHost(authority string) bool {
	host, _, err := net.SplitHostPort(authority)
	if err != nil {
		host = authority
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = host[1 : len(host)-1]
		}
	}
	return strings.EqualFold(host, "localhost") || net.ParseIP(host).IsLoopback()
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) *failure {
	headers := w.Header()
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("Referrer-Policy", "no-referrer")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		headers.Set("Cache-Control", "no-store")
	}
	switch r.URL.Path {
	case "/api/capture", "/birdwatch.js", "/healthz":
		headers.Set("Access-Control-Allow-Origin", "*")
		return nil
	}
	headers.Set("Content-Security-Policy", dashboardCSP)
	if len(s.credential) == 0 {
		if !localHost(r.Host) {
			return &failure{403, "forbidden", "Use the loopback address to access this dashboard."}
		}
	} else {
		user, password, ok := r.BasicAuth()
		provided := sha256.Sum256([]byte(user + ":" + password))
		if !ok || subtle.ConstantTimeCompare(provided[:], s.credential) != 1 {
			headers.Set("WWW-Authenticate", `Basic realm="Birdwatch", charset="UTF-8"`)
			return &failure{401, "unauthorized", "Sign in to the dashboard as admin."}
		}
	}
	if origins := r.Header.Values("Origin"); len(origins) > 0 {
		if len(origins) != 1 || (origins[0] != "http://"+r.Host && origins[0] != "https://"+r.Host) {
			return &failure{403, "forbidden", "Send dashboard requests from the same origin."}
		}
	}
	return nil
}
