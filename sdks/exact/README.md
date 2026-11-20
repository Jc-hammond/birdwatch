# Birdwatch for Expo Exact

Download the Expo Exact SDK from **Setup**. Save the archive next to your Exact app’s `package.json` and install it.

```sh
npm install ./birdwatch-exact-0.2.0.tgz
```

Copy the manifest, Contract and TypeScript answers from the packaged example into your Exact app and replace the collector host and write key. **Record completion** commits an event to SQLite. The example grants network access to the collector and file access to the outbox, its SQLite journals and the quarantine directory. [Runnable example](example/)

## Save and send events

Pass the action’s occurrence time from Contract to the data answer. The sample uses `time.epochAtZero + performanceNow()`. `capture(context, name, properties?, options?)` returns the event ID once SQLite commits. The action supplies `context = { storage, at }` with its storage grant and epoch milliseconds. Pass a stable ID in `options.id`. Retrying the same pending ID preserves its first payload. Each collector and write key has a separate 1,000-event limit. Overflow drops the oldest entries and reports once through `onError`. Storage failures reject capture.

`flush({ storage, sendTime, background, retryToken })` drains the foreground snapshot in batches of up to 100. `sendTime` supplies a fresh Contract clock sample for each HTTP request. Page-hide delivery sends a single keepalive batch. Accepted, duplicate and individually rejected events leave the outbox after acknowledgement. A transient failure returns a retry token with a relative delay or absolute HTTP retry date. The example schedules both from response time, applies the five-minute cap and passes fresh Contract time on replay. Launch, reconnect and page-hidden calls use token zero. An unknown key pauses delivery until the client restarts. Unreadable rows and damaged SQLite files are moved aside and reported through `onError`.

Use `identify(context, id)` and `reset(context)` to update the project identity. Register a background handler with `onError(handler)`. Pass the same delivery context to `close` to attempt delivery and stop this client.

The example targets [Expo Exact at bb3c00b](https://github.com/expo/exact/tree/bb3c00b957ce6d547665ec8f4b79cfe2def72b08).
