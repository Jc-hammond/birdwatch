package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Jc-hammond/birdwatch/internal/config"
	"golang.org/x/crypto/acme/autocert"
)

func serve(ctx context.Context, cfg config.Config, handler http.Handler) error {
	app := httpServer(handler)
	servers := []*http.Server{app}
	results := make(chan error, 2)
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	if cfg.Domain != "" {
		address = ":443"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	defer listener.Close()

	if cfg.Domain == "" {
		fmt.Printf("Birdwatch listening at http://%s\n", listener.Addr())
		go func() { results <- app.Serve(listener) }()
	} else {
		manager, err := certificates(cfg.DB, cfg.Domain)
		if err != nil {
			return err
		}
		plain, err := net.Listen("tcp", ":80")
		if err != nil {
			return err
		}
		defer plain.Close()
		challenges := domainServers(cfg.Domain, manager, app)
		servers = append(servers, challenges)
		fmt.Printf("Birdwatch listening at https://%s\n", cfg.Domain)
		go func() { results <- challenges.Serve(plain) }()
		go func() { results <- app.ServeTLS(listener, "", "") }()
	}
	select {
	case err = <-results:
	case <-ctx.Done():
	}
	deadline, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, server := range servers {
		if stopErr := server.Shutdown(deadline); stopErr != nil {
			err = errors.Join(err, server.Close())
		}
	}
	return err
}

func httpServer(handler http.Handler) *http.Server {
	// Transport errors include peer addresses. Request metadata is logged by the application.
	return &http.Server{Handler: handler, ErrorLog: log.New(io.Discard, "", 0), DisableGeneralOptionsHandler: true,
		ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second}
}

func certificates(db, domain string) (*autocert.Manager, error) {
	directory := filepath.Join(filepath.Dir(db), "birdwatch-certs")
	if err := privateCache(directory); err != nil {
		return nil, fmt.Errorf("certificate cache: %w", err)
	}
	return &autocert.Manager{Prompt: autocert.AcceptTOS, Cache: autocert.DirCache(directory),
		HostPolicy: autocert.HostWhitelist(domain)}, nil
}

func domainServers(domain string, manager *autocert.Manager, app *http.Server) *http.Server {
	app.TLSConfig = manager.TLSConfig()
	app.TLSConfig.GetCertificate = func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if !strings.EqualFold(hello.ServerName, domain) {
			return nil, errors.New("unrecognised TLS server name")
		}
		return manager.GetCertificate(hello)
	}
	app.Handler = domainOnly(domain, "443", app.Handler)
	redirect := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := url.URL{Scheme: "https", Host: domain, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
		http.Redirect(w, r, target.String(), http.StatusPermanentRedirect)
	})
	return httpServer(domainOnly(domain, "80", manager.HTTPHandler(redirect)))
}

func domainOnly(domain, port string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		if !strings.EqualFold(r.Host, domain) && !strings.EqualFold(r.Host, net.JoinHostPort(domain, port)) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusMisdirectedRequest)
			io.WriteString(w, `{"code":"forbidden","error":"Use the configured Birdwatch domain."}`)
			return
		}
		next.ServeHTTP(w, r)
	})
}
