# @birdwatch/sdk

Capture events in browsers and Node.js 20+ and send them directly to your Birdwatch instance. The SDK includes TypeScript declarations, ES modules, CommonJS, and a standalone browser script. It has zero runtime dependencies.

## Install

In Birdwatch, open a writable project's **Setup** page, select **Browser SDK** or **Node.js**, and choose **Download SDK**. Place the archive in your app directory and install it locally.

```sh
npm install ./birdwatch-sdk-0.1.0.tgz
```

The same archive is bundled with the Birdwatch source release at `ui/public/assets/birdwatch-sdk-0.1.0.tgz`. The dashboard provides a host and a project-specific write key in each example. A browser write key is public and grants ingestion only.

## Browser

Create one client when your application starts. The optional type argument describes your own event vocabulary. JavaScript callers use the same API without the type argument.

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
- **Page views.** Call `page()` after a committed route change to record the current pathname. The module sends events only when called. Query parameters, fragments, referrers, and cookies are excluded.
- **Persistence.** The browser client stores identity in local storage per Birdwatch project and observes changes from other tabs. Choose `persistence: "memory"` for a page-lifetime identity. If storage is unavailable, it falls back to memory.
- **Consent.** Where your app requires consent, create the client after consent is granted. Creating the default browser client initializes its local identity.
- **SSR.** Importing the package is side-effect free. Create the browser client after the browser environment is available.

### Script tag

For a site without a build step, use **Setup → Script tag**. This works with the existing snippet.

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

## Delivery contract

| Method | What completion means |
| --- | --- |
| `capture(...)` | Resolves with `{ id, batch: { accepted, duplicates } }` after the collector acknowledges the event. Both a new insert and an existing ID are successful delivery. The counts describe the whole request. |
| `flush()` | Starts delivery immediately and waits for all events outstanding at the time of the call. It rejects after those events settle if any failed. Events captured later have their own receipts. |
| `shutdown()` | Closes admission, drains pending events, and detaches browser listeners. Repeated calls share the same completion promise. |

The SDK snapshots identity, properties, timestamp, and ID when you call `capture`. It sends batches in capture order, with one request in flight per client. Capture a burst of events first and await their promises together to take advantage of batching. Awaiting each capture in a loop sends them sequentially.

If a connection fails after the collector commits, retries reuse the identical request body and event IDs. The collector's unique project-and-ID constraint deduplicates retries. A caller-supplied `id` extends deduplication to retries initiated by your application. Pair one ID with one logical event and one project.

Browser capture accepts `{ id, timestamp }` as its third argument. Server capture accepts the same fields on the event object. A timestamp can be a valid `Date` or a zoned ISO 8601 string. The default is the event's capture time. Properties must be plain JSON objects and fit the collector's 32 KiB encoded limit.

### Failures

`capture()` rejects with a `BirdwatchError`. The optional `onError` observer receives each failed capture once, including when the caller leaves its promise in the background. Observer errors are isolated from delivery. Configuration and invalid calls to `identify()` throw synchronously.

| Code | Meaning |
| --- | --- |
| `invalid_input` | A setting, identifier, timestamp, or property value is invalid. |
| `queue_full` | The pending-event limit has been reached. The new event was declined. |
| `closed` | Capture was called after shutdown began. |
| `network`, `timeout` | A network failure or request deadline exhausted the retry budget. |
| `http` | The collector or proxy rejected the request. `error.status` contains the HTTP status. |
| `invalid_response` | The response did not acknowledge the expected number of events. |

Timeouts, network failures, invalid acknowledgements, HTTP 408, 429, and 5xx responses are retried with exponential backoff and jitter. The SDK observes `Retry-After`. If the requested wait exceeds 30 seconds it returns the error to the caller. On an atomic HTTP 400 or 413 batch rejection, it splits the batch to isolate the failing events.

The queue lives in memory. On tab hide or page exit, the SDK attempts a keepalive flush. Tab termination, process crashes, browser keepalive limits, or exhausted retries can prevent delivery. For business-critical records, persist the event and its ID in your application's outbox and replay it from there.

## Configuration

| Option | Default | Behavior |
| --- | --- | --- |
| `host` | required | Absolute HTTP(S) collector URL, optionally with a reverse-proxy prefix. Use an address reachable from the sending device. |
| `writeKey` | required | Project write key from Setup. |
| `batchSize` | 20 | Send when this many events are queued. Range 1–100. Requests are also capped at 48 KiB. |
| `flushIntervalMs` | 150 | Maximum batching delay when idle. Range 0–60,000 ms. |
| `maxQueueSize` | 1,000 | Maximum outstanding events, including in-flight events. Range 1–100,000. |
| `timeoutMs` | 5,000 | Per-attempt deadline through response-body consumption. Range 1–120,000 ms. |
| `maxRetries` | 2 | Additional attempts per transient failure. Range 0–5. |
| `fetch` | runtime fetch | Custom Fetch-compatible implementation. It must respect the supplied AbortSignal. |
| `onError` | unset | Optional observer for capture failures. |
| `persistence` | `"localStorage"` | Browser identity only. Set to `"memory"` for page-lifetime identity. |

## Develop from the source release

Inside `sdk/`, run `npm ci` and `npm test` to build both module formats and run the type and behavior tests. Run `npm run test:integration` to exercise a real Python collector with a temporary database. Set `PYTHON` to select a Python interpreter.

Run `npm run sync` after SDK changes to regenerate the hosted script and installable archive. The Python server can serve these immediately. Rebuild the dashboard from `ui/` after editing setup-page code.
