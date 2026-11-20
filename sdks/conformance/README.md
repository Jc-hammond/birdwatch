# SDK delivery conformance

Run `node --test sdks/conformance/web.test.mjs` from the repository root after building the web SDK. Each JSON file drives a fresh SDK instance and a local HTTP collector.

- `collector` lists replies in request order. An acknowledgement counts stored and duplicate UUIDs. `loseAck` stores the batch and drops the connection. `holdAck` stores it and holds the response until release. Objects specify rejected indices or an HTTP error.
- `steps` control the SDK. Capture values are event UUIDs. Flush starts delivery, restart discards the client and its timers while retaining browser storage, and hide sends a browser visibility change. Time advances only through clock steps. The web driver fixes the jitter sample at 0.5.
- `expect` describes request batches, stored UUIDs and the final outbox. To observe queued events, the collector switches to success and the driver drains once more, restarting first for persisted queues. The probe is excluded from the scenario's request and storage totals. Delay values are milliseconds of SDK time.

The web driver uses the Node entry point for transport scenarios and the browser entry point for storage and page lifecycle scenarios. `web-gaps.json` names observed failures. A listed scenario still executes, and a newly passing scenario must leave the list.
