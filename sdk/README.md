# Birdwatch SDK for JavaScript and TypeScript

Use `@birdwatch/sdk` to send events from a browser or Node.js 20+ to your Birdwatch server. The package includes TypeScript types, ES modules, CommonJS, and a standalone browser script, with zero runtime dependencies.

## Install

Open your project in Birdwatch and select **Setup** → **Browser SDK** or **Node.js** → **Download SDK**. Save the archive in your app directory, then install it.

```sh
npm install ./birdwatch-sdk-0.1.0.tgz
```

Each example in **Setup** includes your server URL and project write key. The key lets clients send events. Running `make build` from the repository root generates the same archive at `ui/public/assets/birdwatch-sdk-0.1.0.tgz`.

## Browser

Create one client when your application starts. In TypeScript, pass an optional type with your event names and properties. In JavaScript, call `createBrowserClient()` with the configuration alone.

```ts
import { createBrowserClient } from "@birdwatch/sdk";

type Events = {
  sign_up: { plan: "free" | "pro" };
  search_submitted: { resultCount: number };
};

const analytics = createBrowserClient<Events>({
  host: "http://127.0.0.1:8123",
  writeKey: "YOUR_PROJECT_WRITE_KEY",
});

await analytics.page();
analytics.identify("user_42");
const receipt = await analytics.capture("sign_up", { plan: "pro" });
console.log(receipt.id);
```

- **Identity.** The first visit gets a random anonymous ID. Read it with `analytics.distinctId`. `identify(id)` sets the identity for subsequent events, including across page loads. Call `reset()` at logout to create a new anonymous identity. Previous events retain the identity they had at capture time. Historical identities are separate in the collector.
- **Page views.** Call `page()` after a committed route change to record the current pathname. The module sends events only when called. The event contains the pathname. It omits query parameters, fragments, referrers and cookies.
- **Persistence.** The browser client stores identity in local storage per Birdwatch project and observes changes from other tabs. Choose `persistence: "memory"` for a page-lifetime identity. If storage is unavailable, it falls back to memory.
- **Consent.** Where your app requires consent, create the client after consent is granted. Creating the default browser client initializes its local identity.
- **SSR.** Importing the package is side-effect free. Create the browser client after the browser environment is available.

### Script tag

For a site without a build step, copy the HTML snippet from **Setup** → **Script tag**.

```html
<script src="http://127.0.0.1:8123/birdwatch.js"
        data-key="YOUR_PROJECT_WRITE_KEY" data-pageview="true"></script>
<script>
  birdwatch.identify("user_42");
  birdwatch.capture("sign_up", { plan: "pro" }).catch(console.error);
</script>
```

`data-pageview="true"` sends one page view on load. The script exposes `window.birdwatch` and its `capture()` method returns `{ accepted, duplicates }`. It uses the same delivery implementation with a batch size of one. The global also exposes `page()`, `distinctId`, `reset()`, `flush()`, and `shutdown()`.

## Node.js

Share one client across requests. Each event carries its own distinct ID.

```js
import { createServerClient } from "@birdwatch/sdk";

const analytics = createServerClient({
  host: process.env.BIRDWATCH_HOST,
  writeKey: process.env.BIRDWATCH_WRITE_KEY,
  onError(error) {
    console.warn("Analytics delivery failed", error.code, error.status);
  },
});

try {
  await analytics.capture({
    distinctId: "user_42",
    event: "payment_captured",
    id: "payment_8391",
    properties: { amountCents: 2400, currency: "USD" },
  });
} finally {
  await analytics.shutdown();
}
```

In a long-running service, call `shutdown()` from your application's shutdown handler. In a short-lived worker, await `capture()` or `flush()` before returning control to the host. CommonJS callers can use `const { createServerClient } = require("@birdwatch/sdk")`. Server clients support the same optional event catalog as browser clients.

## Delivery and retries

| Method | What completion means |
| --- | --- |
| `capture(...)` | Resolves with `{ id, batch: { accepted, duplicates } }` after the collector acknowledges the event. Birdwatch acknowledges new events and events it already recorded. The counts cover the whole request. |
| `flush()` | Starts delivery immediately and waits for all events outstanding at the time of the call. It rejects after those events settle if any failed. Events captured later have their own receipts. |
| `shutdown()` | Stops accepting new events, waits for pending delivery, and removes browser listeners. Repeated calls return the same promise. |

The SDK saves the identity, properties, timestamp, and ID at the time you call `capture()`. It sends queued events in capture order. A closing page can resend unacknowledged events while a request is in flight. To let the SDK batch events, call `capture()` for each event and then await the promises together.

Retries preserve the original events and IDs and update the batch’s `sent_at` time, so Birdwatch counts an event once even if the original response was lost. If your app retries an event itself, pass the same `id` each time. Use a separate ID for each new event in a project.

Browser capture accepts `{ id, timestamp }` as its third argument. Server capture accepts the same fields on the event object. A timestamp can be a valid `Date` or a zoned ISO 8601 string. The default is the event's capture time. Properties must be plain JSON objects and fit the collector's 32 KiB encoded limit.

### Failures

Invalid input and terminal delivery errors reject the capture promise. A successful response resolves accepted and duplicate events and reports each rejected event through `onError`. Overflow drops the oldest pending events and reports the overflow once. An unknown key pauses the queue and reports the failure once. A new client can resume delivery from browser storage.

Transient failures and unrecognized responses keep their events queued. The retry ceiling starts at one second and doubles to 60 seconds, with a random delay between zero and the ceiling. A valid `Retry-After` overrides the delay up to five minutes.

The queue uses memory by default. Set `persist: true` on a browser client to retain unacknowledged events across reloads. A storage failure reports once and delivery continues from memory. On page hide, the SDK attempts keepalive delivery and falls back to a beacon if the fetch fails. The browser applies its own referrer and cookie policies to beacon requests.

| Option | Default | Behavior |
| --- | --- | --- |
| `host` | required | Absolute HTTP(S) collector URL, optionally with a reverse-proxy prefix. Use an address reachable from the sending device. |
| `writeKey` | required | Project write key from Setup. |
| `batchSize` | 20 | Send when this many events are queued. Range 1–100. Browser requests are capped at 48 KiB and Node requests at 1 MiB. |
| `flushIntervalMs` | 150 | Maximum batching delay when idle. Range 0–60,000 ms. |
| `maxQueueSize` | 1,000 | Maximum outstanding events, including in-flight events. Range 1–100,000. |
| `timeoutMs` | 5,000 | Per-attempt deadline through response-body consumption. Range 1–120,000 ms. |
| `persist` | `false` | Browser only. Keep unacknowledged events in local storage. |
| `fetch` | runtime fetch | Custom Fetch-compatible implementation. It must respect the supplied AbortSignal. |
| `onError` | unset | Optional observer for capture failures. |
| `persistence` | `"localStorage"` | Browser identity only. Set to `"memory"` for page-lifetime identity. |

## Build and test the SDK

Run `make test-js` from the repository root to build both module formats and run the type checks, shared delivery scenarios and adapter tests.

`make build` regenerates the dashboard's hosted script and offline SDK archives.
