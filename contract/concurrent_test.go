package contract_test

import (
	"encoding/json"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

func TestConcurrentCapture(t *testing.T) {
	s := startEmpty(t)
	p := s.createProject(t, "Concurrent")
	const clients, events = 40, 500
	start := make(chan struct{})
	var workers sync.WaitGroup
	var acknowledged atomic.Int32
	for worker := range clients {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for i := worker; i < events; i += clients {
				id := strconv.Itoa(i)
				fields := object{"api_key": p.key, "event": "page_view", "distinct_id": id, "uuid": id}
				r, err := s.request("POST", "/api/capture", fields, nil)
				var ack acknowledgement
				if err == nil && r.status == 200 && json.Unmarshal(r.body, &ack) == nil && ack.counts(1, 0) {
					acknowledged.Add(1)
				}
			}
		}()
	}
	close(start)
	workers.Wait()
	check(t, "acknowledged events", acknowledged.Load(), int32(events))
	// Each event has its own person, so replacement by a duplicate cannot hide a loss.
	check(t, "stored totals", s.overview(t, p, 7).Current, []float64{events, events, events, 1})
}
