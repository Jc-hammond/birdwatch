package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"syscall"
	"text/tabwriter"
	"time"
)

type timing struct {
	Name     string   `json:"report"`
	Median   *float64 `json:"median_ms"`
	Slowest  *float64 `json:"slowest_ms"`
	Timeouts int      `json:"timeouts"`
}

type result struct {
	Anchor   string   `json:"anchor_utc"`
	Events   int      `json:"events"`
	Rate     float64  `json:"events_per_second"`
	Peak     int64    `json:"peak_memory_bytes"`
	Database int64    `json:"database_bytes"`
	WAL      int64    `json:"wal_bytes"`
	Reports  []timing `json:"reports"`
}

func milliseconds(d time.Duration) *float64 {
	ms := float64(d) / float64(time.Millisecond)
	return &ms
}

func benchmark(ctx context.Context, count int) (r result, err error) {
	dir, err := os.MkdirTemp("", "birdwatch-bench-")
	if err != nil {
		return r, err
	}
	defer os.RemoveAll(dir)
	db := filepath.Join(dir, "benchmark.sqlite3")
	s, err := launch(ctx, db)
	if err != nil {
		return r, err
	}
	closeServer := func() error {
		if s == nil {
			return nil
		}
		peak, err := stop(s.cmd)
		s = nil
		r.Peak = max(r.Peak, peak)
		return err
	}
	defer func() {
		if stopErr := closeServer(); err == nil {
			err = stopErr
		}
	}()
	path, key, err := project(ctx, s.url)
	if err != nil {
		return r, err
	}
	anchor := time.Now().UTC().Truncate(24 * time.Hour)
	r.Anchor, r.Events = anchor.Format(time.DateOnly), count
	start := time.Now()
	if err = ingest(ctx, s.url, key, count, anchor); err != nil {
		return r, fmt.Errorf("ingestion: %w", err)
	}
	r.Rate = float64(count) / time.Since(start).Seconds()
	for _, report := range []struct{ name, query string }{
		{"overview", "overview?days=30"}, {"events", "events?days=30&include_total=1"}, {"people", "people?days=30&include_total=1"},
		{"event names", "names?days=30"}, {"funnel", "funnel?days=30&first=page_view&second=event_1"},
	} {
		var samples []time.Duration
		for range 5 {
			if s == nil {
				s, err = launch(ctx, db)
				if err != nil {
					return r, err
				}
			}
			start := time.Now()
			var overview struct{ Current []float64 }
			var response any
			if report.name == "overview" {
				response = &overview
			}
			err = request(ctx, "GET", s.url+path+report.query, nil, 200, response)
			elapsed := time.Since(start)
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				// Python can continue a SQLite query after the client times out.
				// Reopen the same database before measuring another query.
				if err = closeServer(); err != nil {
					return r, err
				}
				continue
			}
			if err != nil {
				return r, fmt.Errorf("%s: %w", report.name, err)
			}
			if response != nil && (len(overview.Current) == 0 || overview.Current[0] != float64(count)) {
				return r, errors.New("overview count differs from the acknowledged events in the 30-day window")
			}
			samples = append(samples, elapsed)
		}
		slices.Sort(samples)
		t := timing{Name: report.name, Timeouts: 5 - len(samples)}
		if len(samples) >= 3 {
			t.Median = milliseconds(samples[2])
		}
		if len(samples) == 5 {
			t.Slowest = milliseconds(samples[4])
		}
		r.Reports = append(r.Reports, t)
	}
	info, err := os.Stat(db)
	if err != nil {
		return r, err
	}
	r.Database = info.Size()
	if wal, e := os.Stat(db + "-wal"); e == nil {
		r.WAL = wal.Size()
	} else if !errors.Is(e, os.ErrNotExist) {
		return r, e
	}
	if time.Now().UTC().Format(time.DateOnly) != r.Anchor {
		return r, errors.New("UTC day changed during the benchmark; rerun to measure a single reporting window")
	}
	return r, nil
}

func display(ms *float64) string {
	if ms == nil {
		return "timed out"
	}
	return fmt.Sprintf("%.2f", *ms)
}

func run() error {
	count := flag.Int("events", 100000, "number of events to ingest")
	asJSON := flag.Bool("json", false, "print results as JSON (null timing means timed out)")
	budget := flag.Float64("budget-ms", 0, "maximum report median in milliseconds (omitted by default)")
	flag.Parse()
	enforce := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "budget-ms" {
			enforce = true
		}
	})
	if *count <= 0 || *budget < 0 || math.IsNaN(*budget) || math.IsInf(*budget, 0) || flag.NArg() != 0 {
		return errors.New("use a positive event count and a non-negative budget")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	r, err := benchmark(ctx, *count)
	if err != nil {
		return err
	}
	if *asJSON {
		if err = json.NewEncoder(os.Stdout).Encode(r); err != nil {
			return err
		}
	} else {
		fmt.Printf("UTC anchor %s\n%d events at %.0f events/s\nPeak server memory %d bytes\nDatabase %d bytes (WAL %d bytes)\n", r.Anchor, r.Events, r.Rate, r.Peak, r.Database, r.WAL)
		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "report\tmedian ms\tslowest ms\ttimed out / 5")
		for _, t := range r.Reports {
			fmt.Fprintf(w, "%s\t%s\t%s\t%d\n", t.Name, display(t.Median), display(t.Slowest), t.Timeouts)
		}
		if err = w.Flush(); err != nil {
			return err
		}
	}
	for _, t := range r.Reports {
		if enforce && (t.Median == nil || *t.Median > *budget) {
			return fmt.Errorf("%s median %s exceeds the %.2f ms budget or timed out", t.Name, display(t.Median), *budget)
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
