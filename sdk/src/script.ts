import { createBrowserClient } from "./browser.js";
import type { BrowserClient } from "./types.js";

const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.key) {
  const client = createBrowserClient({
    host: new URL(".", script.src).href,
    writeKey: script.dataset.key,
    batchSize: 1,
  });
  const globals = window as Window & { birdwatch?: BrowserClient };
  void globals.birdwatch?.close().catch(() => {});
  globals.birdwatch = client;
  if (script.dataset.pageview === "true")
    void client.capture("page_view", { path: window.location.pathname }).catch(() => {});
} else if (script) {
  console.warn("Birdwatch requires a data-key on its script tag.");
}
