package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/Jc-hammond/birdwatch/internal/config"
	"github.com/Jc-hammond/birdwatch/internal/server"
	"github.com/Jc-hammond/birdwatch/internal/storage"
)

func run() error {
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := storage.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer db.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	srv := &http.Server{
		DisableGeneralOptionsHandler: true,
		Handler:                      server.New(log.Default(), db.Health),
		ReadTimeout:                  15 * time.Second,
		WriteTimeout:                 30 * time.Second,
	}
	fmt.Printf("Birdwatch listening at http://%s\n", listener.Addr())
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		deadline, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := srv.Shutdown(deadline)
		if errors.Is(err, context.DeadlineExceeded) {
			return srv.Close()
		}
		return err
	}
}

func main() {
	if err := run(); err != nil && !errors.Is(err, flag.ErrHelp) {
		log.Fatal(err)
	}
}
