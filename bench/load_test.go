package main

import (
	"reflect"
	"testing"
	"time"
)

func TestRepeatableEvents(t *testing.T) {
	const count = 237
	anchor := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	var first []event
	for offset := 0; offset < count; offset += batchSize {
		first = append(first, batch(offset, count, anchor)...)
	}
	// Concurrent clients can request batches in a different order on the next run.
	second := make([]event, count)
	for offset := (count - 1) / batchSize * batchSize; offset >= 0; offset -= batchSize {
		copy(second[offset:], batch(offset, count, anchor))
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("event data changes with worker order")
	}
}
