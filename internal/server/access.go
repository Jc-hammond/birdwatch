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

func publicRoute(path string) bool {
	return path == "/api/capture" || path == "/birdwatch.js" || path == "/healthz"
}

func setSecurityHeaders(headers http.Header, path string, public bool) {
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("Referrer-Policy", "no-referrer")
	if strings.HasPrefix(path, "/api/") {
		headers.Set("Cache-Control", "no-store")
	}
	if public {
		headers.Set("Access-Control-Allow-Origin", "*")
	} else {
		headers.Set("Content-Security-Policy", dashboardCSP)
	}
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) *failure {
	if len(s.credential) == 0 {
		if !localHost(r.Host) {
			return &failure{403, "forbidden", "Use the loopback address to access this dashboard."}
		}
	} else {
		user, password, ok := r.BasicAuth()
		provided := sha256.Sum256([]byte(user + ":" + password))
		if !ok || subtle.ConstantTimeCompare(provided[:], s.credential) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Birdwatch", charset="UTF-8"`)
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
