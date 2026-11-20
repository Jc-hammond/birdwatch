# Birdwatch for Expo Exact

Download the Expo Exact SDK from **Setup**. Save the archive next to your Exact app’s `package.json` and install it.

```sh
npm install ./birdwatch-exact-0.2.0.tgz
```

Copy the manifest, Contract and TypeScript answers from the packaged example into your Exact app and replace the collector host and write key. **Record completion** commits an event to SQLite. The example grants network access to the collector and file access to the outbox, its SQLite journals and the quarantine directory. [Runnable example](example/)

## Save and send events

Pass the action’s occurrence time from Contract to the data answer. The sample uses `time.epochAtZero + performanceNow()`. `enqueue` takes a stable occurrence ID and returns `{ id }` once SQLite commits. Retrying the same pending ID preserves its first payload. Each collector and write key has a separate 1,000-event limit. Overflow drops the oldest entries and reports once through `onError`. Storage failures reject the enqueue.

`flush(storage, at, background, retryToken)` sends up to 100 queued events per call. Accepted, duplicate and individually rejected events leave the outbox after acknowledgement. A transient failure returns `retryAfterMs` and a `retryToken`. Start the wait when the answer arrives, then pass the token and fresh Contract time to the next replay. Launch, reconnect and page-hidden calls use token zero. An unknown key pauses delivery until the client restarts. Unreadable rows and damaged SQLite files are moved aside and reported through `onError`.

The direct APIs remain available. `capture` sends one event and `captureBatch` sends 1–100 events in one request. Pass the current epoch milliseconds as the final argument to either call. They return collector counts and use the collector clock when no event timestamp is supplied. Use `enqueue` for durable offline collection.

The example targets [Expo Exact at bb3c00b](https://github.com/expo/exact/tree/bb3c00b957ce6d547665ec8f4b79cfe2def72b08).
