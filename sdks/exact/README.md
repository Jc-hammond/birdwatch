# Birdwatch for Expo Exact

Download the Expo Exact SDK from **Setup**. Save the archive next to your Exact app’s `package.json` and install it.

```sh
npm install ./birdwatch-exact-0.2.0.tgz
```

The included `example/` contains an app manifest, Contract view, and TypeScript answers. Copy the three files into your Exact app and replace the host and write key. The example grants access to the collector origin and one SQLite file. Pressing **Record completion** commits an event to the device. A launch task, a post-save action and a ten-second Contract task invoke replay while the app is running.

```ts
import { createExactClient } from "@birdwatch/exact";
import type { Sources } from "./app.contract.d.ts";

const host = "https://analytics.example.com";
export const grants = `net.fetch ${host}\nsqlite.open app:/data/birdwatch.sqlite`;
const analytics = createExactClient({ host, writeKey: "YOUR_PROJECT_WRITE_KEY", fetch });

const sources: Sources = {
  recordCompletion: ([distinctId, id, at], _store, storage) =>
    analytics.enqueue({
      id, distinctId, event: "onboarding_completed",
      timestamp: new Date(at).toISOString(),
    }, storage.sqlite),
  replay: ([at, background], _store, storage) => analytics.flush(storage.sqlite, at, background),
};
```

## Save and send events

Pass the action’s occurrence time from Contract to the data answer. The sample uses `time.epochAtZero + performanceNow()`. `enqueue` takes a stable occurrence ID and returns `{ id }` once SQLite commits. Retrying the same pending ID preserves its first payload. Each collector and write key has a separate 1,000-event limit. Overflow drops the oldest entries and reports once through `onError`. Storage failures reject the enqueue.

`flush` sends up to 100 pending events per call. Successful and duplicate acknowledgements remove their corresponding rows. An unrecognized response or transient failure retains the batch and returns `retryAfterMs`. Call replay after that delay from an active Contract answer. An unknown key pauses delivery until the client restarts. The SDK quarantines damaged stored entries. Call replay from your host's tasks on launch and periodically to resume after reconnection. The database survives a process restart. Pass the Contract clock (epoch milliseconds) on every attempt. The example also starts a scoped replay when the page becomes hidden.

The direct APIs remain available. `capture` sends one event and `captureBatch` sends 1–100 events in one request. Pass the current epoch milliseconds as the final argument to either call. They return collector counts and use the collector clock when no event timestamp is supplied. Use `enqueue` for durable offline collection.

The example targets [Expo Exact at bb3c00b](https://github.com/expo/exact/tree/bb3c00b957ce6d547665ec8f4b79cfe2def72b08).
