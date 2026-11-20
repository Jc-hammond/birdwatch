package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Jc-hammond/birdwatch/internal/config"
	"github.com/Jc-hammond/birdwatch/internal/server"
	"github.com/Jc-hammond/birdwatch/internal/storage"
)

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	if cfg.BackupDir != "" {
		done := make(chan struct{})
		go func() {
			defer close(done)
			db.ScheduleBackups(ctx, cfg.BackupDir, log.Default())
		}()
		defer func() { stop(); <-done }()
	}
	return serve(ctx, cfg, server.New(log.Default(), cfg.Password, db.Health))
}

func main() {
	if err := run(); err != nil && !errors.Is(err, flag.ErrHelp) {
		log.Fatal(err)
	}
}
