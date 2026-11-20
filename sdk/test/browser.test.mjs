import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "@birdwatch/sdk";

function browser(t, deny = false) {
  const win = new EventTarget(),
    doc = new EventTarget(),
    data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
  Object.defineProperty(win, "localStorage", {
    get() {
      if (deny) throw new Error("Storage denied");
      return storage;
    },
  });
  win.location = new URL("https://app.test/inside?secret=private#fragment");
  for (const [key, value] of [
    ["window", win],
    ["document", doc],
  ]) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, key, before);
      else delete globalThis[key];
    });
  }
  const batches = [];
  function client(options = {}) {
    return createBrowserClient({
      host: "http://127.0.0.1:8123",
      writeKey: "key",
      flushIntervalMs: 60000,
      fetch: async (url, init) => {
        const batch = JSON.parse(init.body).batch;
        batches.push(batch);
        return Response.json({ accepted: batch.length, duplicates: 0 });
      },
      ...options,
    });
  }
  return { win, doc, storage, client, batches };
}

test("the script tag exposes one Birdwatch global and restores the project identity", async (t) => {
  const { win, doc, storage } = browser(t);
  doc.currentScript = { src: "https://collector.test/birdwatch.js", dataset: { key: "key" } };
  storage.setItem("birdwatch.id.key", "visitor");
  const before = new Set(Object.keys(win));
  await import("../dist/birdwatch.js");
  assert.deepEqual(Object.keys(win).filter((key) => !before.has(key)), ["birdwatch"]);
  assert.deepEqual(Object.keys(win.birdwatch).sort(), ["capture", "close", "flush", "identify", "onError", "reset"]);
  await win.birdwatch.close();
});

test("restores the stored Birdwatch identity and preserves attribution across identify and reset", async (t) => {
  const env = browser(t);
  env.storage.setItem("birdwatch.id.key", "existing");
  const c = env.client();
  const one = c.capture("page_view", { path: env.win.location.pathname });
  c.identify("member");
  const two = c.capture("signed_in");
  c.reset();
  const anon = env.storage.getItem("birdwatch.id.key");
  const three = c.capture("signed_out");
  assert.notEqual(anon, "member");
  env.win.dispatchEvent(new Event("pagehide"));
  await Promise.all([one, two, three]);
  const events = env.batches.flat();
  assert.deepEqual(
    events.map((e) => e.distinct_id),
    ["existing", "member", anon]
  );
  assert.deepEqual(events[0].properties, { path: "/inside" });
  assert.equal(env.storage.getItem("birdwatch.id.key"), anon);
  await c.close();
});
test("memory persistence avoids touching stored identities", async (t) => {
  const env = browser(t);
  env.storage.setItem("birdwatch.id.key", "existing");
  const c = env.client({ persistence: "memory" });
  c.identify("temporary");
  assert.equal(env.storage.getItem("birdwatch.id.key"), "existing");
  await c.close();
});
test("storage-denied browsers still deliver and flush on visibility changes", async (t) => {
  const env = browser(t, true);
  const c = env.client();
  const pending = c.capture("viewed");
  env.doc.visibilityState = "hidden";
  env.doc.dispatchEvent(new Event("visibilitychange"));
  await pending;
  assert.ok(env.batches.flat()[0].distinct_id);
  await c.close();
});
