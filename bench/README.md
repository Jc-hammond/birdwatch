# Benchmark Birdwatch

From the repository root, build the dashboard with `make build`, then run the benchmark against the reference server.

```sh
BIRDWATCH_SERVER_CMD="python3 server.py" go run ./bench --events 100000
```

Set `BIRDWATCH_SERVER_CMD` to the built server binary to benchmark Go. Use the server executable or its interpreter directly so peak memory is attributed to the serving process. Each run creates a temporary database and a fresh project. Four clients send batches of up to 100 events. The event count and printed UTC date determine the dataset.

Use `--json` for machine-readable results and `--budget-ms 300` to enforce a report median. Each report runs five times with a 60-second deadline per attempt. The table prints “timed out” and JSON uses null when a deadline prevents measuring the median or slowest result. After a timeout the benchmark restarts the server on the same database before taking another sample. The database size and its live write-ahead log are reported separately in bytes.
