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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) > 1 && os.Args[1] == "rebuild-rollups" {
		flags := flag.NewFlagSet("birdwatch rebuild-rollups", flag.ContinueOnError)
		path := flags.String("db", config.DatabasePath(), "SQLite database to rebuild")
		if err := flags.Parse(os.Args[2:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return errors.New("usage: birdwatch rebuild-rollups [--db path]")
		}
		return storage.RebuildRollups(ctx, *path)
	}
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		flags := flag.NewFlagSet("birdwatch backup", flag.ContinueOnError)
		source := flags.String("db", config.DatabasePath(), "SQLite database to back up")
		if err := flags.Parse(os.Args[2:]); err != nil {
			return err
		}
		if flags.NArg() != 1 {
			return errors.New("usage: birdwatch backup [--db source] <destination>")
		}
		return storage.Backup(ctx, *source, flags.Arg(0))
	}
	cfg, err := config.Parse(os.Args[1:])
	if err != nil {
		return err
	}
	db, err := storage.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.Seed(ctx, !cfg.NoDemo); err != nil {
		return err
	}
	if cfg.BackupDir != "" {
		done := make(chan struct{})
		go func() {
			defer close(done)
			db.ScheduleBackups(ctx, cfg.BackupDir, log.Default())
		}()
		defer func() { stop(); <-done }()
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	srv := &http.Server{
		DisableGeneralOptionsHandler: true,
		Handler:                      server.New(log.Default(), cfg.Password, db),
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
