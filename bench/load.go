package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"sync"
	"time"
)

const batchSize = 100

type event struct {
	Name       string         `json:"event"`
	Person     string         `json:"distinct_id"`
	Timestamp  time.Time      `json:"timestamp"`
	Properties map[string]int `json:"properties"`
}

func batch(first, count int, anchor time.Time) []event {
	// Each batch owns its seed so worker scheduling cannot change the data.
	rng := rand.New(rand.NewSource(int64(first) + 42))
	rows := make([]event, min(batchSize, count-first))
	for i := range rows {
		name := rng.Intn(20)
		eventName := "event_" + strconv.Itoa(name)
		if name == 0 {
			eventName = "page_view"
		}
		// Today is represented by midnight, which is already inside the live window at any hour.
		day := rng.Intn(30)
		ts := anchor.AddDate(0, 0, -day)
		if day != 0 {
			ts = ts.Add(time.Duration(rng.Intn(86400)) * time.Second)
		}
		rows[i] = event{eventName, "person_" + strconv.Itoa(rng.Intn(max(1, count/10))), ts, map[string]int{"screen": rng.Intn(8)}}
	}
	return rows
}

func ingest(ctx context.Context, url, key string, count int, anchor time.Time) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	var once sync.Once
	var failure error
	const workers = 4
	for worker := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for first := worker * batchSize; first < count && ctx.Err() == nil; first += workers * batchSize {
				rows := batch(first, count, anchor)
				body, err := json.Marshal(struct {
					Key   string  `json:"api_key"`
					Batch []event `json:"batch"`
				}{key, rows})
				var ack struct{ Accepted int }
				if err == nil {
					err = request(ctx, "POST", url+"/api/capture", body, 200, &ack)
				}
				if err == nil && ack.Accepted != len(rows) {
					err = fmt.Errorf("capture acknowledged %d of %d events", ack.Accepted, len(rows))
				}
				if err != nil {
					once.Do(func() { failure = err; cancel() })
					return
				}
			}
		}()
	}
	wg.Wait()
	if failure != nil {
		return failure
	}
	return ctx.Err()
}
