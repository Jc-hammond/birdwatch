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
  // A script-tag capture returns the collector's counts for one event.
  const client = createBrowserClient({
    host: new URL(".", script.src).href,
    writeKey: script.dataset.key,
    batchSize: 1,
  });
  const globals = window as Window & { birdwatch?: ScriptClient };
  if (globals.birdwatch?.shutdown)
    void globals.birdwatch.shutdown().catch(() => {});
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
  globals.birdwatch = api;
  if (script.dataset.pageview === "true") void client.page().catch(() => {});
} else if (script) {
  console.warn("Birdwatch requires a data-key on its script tag.");
}
