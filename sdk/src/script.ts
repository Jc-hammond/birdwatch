import { createBrowserClient } from "./browser.js";
import type {
  BatchCounts,
  BrowserClient,
  CaptureOptions,
  Properties,
} from "./types.js";

interface ScriptClient extends Omit<BrowserClient, "capture"> {
  capture(
    event: string,
    properties?: Properties,
    options?: CaptureOptions
  ): Promise<BatchCounts>;
}

const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.key) {
  // A legacy capture resolves with this individual event's exact accepted/duplicate counts.
  const client = createBrowserClient({
    host: new URL(".", script.src).href,
    writeKey: script.dataset.key,
    batchSize: 1,
  });
  const previous = (window as Window & { birdwatch?: ScriptClient })
    .birdwatch;
  if (previous?.shutdown) void previous.shutdown().catch(() => {});
  const api: ScriptClient = {
    get distinctId() {
      return client.distinctId;
    },
    identify: client.identify,
    reset: client.reset,
    page: client.page,
    flush: client.flush,
    shutdown: client.shutdown,
    async capture(event, properties, options) {
      return (await client.capture(event, properties, options)).batch;
    },
  };
  const globals = window as Window & { birdwatch?: ScriptClient; signalnest?: ScriptClient };
  globals.birdwatch = api;
  globals.signalnest = api;
  if (script.dataset.pageview === "true") void client.page().catch(() => {});
}
