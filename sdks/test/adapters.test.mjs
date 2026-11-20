import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createExactClient } from "../exact/dist/index.js";

// Load the actual Metro-compatible bundle with a controlled AppState event source.
function nativeAdapter() {
  const module = { exports: {} };
  let listener;
  let removed = 0;
  const AppState = {
    addEventListener(type, fn) {
      assert.equal(type, "change");
      listener = fn;
      return {
        remove() {
          removed++;
          listener = undefined;
        },
      };
    },
  };
  const source = readFileSync(
    new URL("../react-native/dist/index.cjs", import.meta.url),
    "utf8"
  );
  Function(
    "module",
    "exports",
    "require",
    source
  )(module, module.exports, (name) => {
    if (name === "@react-native-async-storage/async-storage")
      return { getItem: async () => null, setItem: async () => {} };
    if (name === "@birdwatch/sdk/internal") return createRequire(import.meta.url)(name);
    assert.equal(name, "react-native");
    return { AppState };
  });
  return {
    create: module.exports.createReactNativeClient,
    background: () => listener("background"),
    removed: () => removed,
  };
}
const config = {
  host: "https://birdwatch.example/prefix/",
  writeKey: "sample",
};

test("native background flush preserves the identity at capture and removes the listener", async () => {
  const host = nativeAdapter();
  const values = new Map();
  let serial = 0;
  const sent = [];
  const opts = {
    ...config,
    randomUUID: () => String(++serial),
    flushIntervalMs: 60000,
    storage: {
      async getItem(k) {
        return values.get(k) ?? null;
      },
      async setItem(k, v) {
        values.set(k, v);
      },
    },
    fetch: async (url, init) => {
      assert.equal(url, "https://birdwatch.example/prefix/api/capture");
      const { batch } = JSON.parse(init.body);
      sent.push(...batch);
      return Response.json({ accepted: batch.length, duplicates: 0 });
    },
  };
  const client = await host.create(opts);
  const anonymous = client.distinctId;
  const one = client.screen("Home");
  await client.identify("alex");
  const two = client.capture("checkout", { total: 42 });
  host.background();
  await Promise.all([one, two]);
  assert.deepEqual(
    sent.map((x) => x.distinct_id),
    [anonymous, "alex"]
  );
  await Promise.all([client.shutdown(), client.shutdown()]);
  assert.equal(host.removed(), 1);
  const next = await host.create(opts);
  assert.equal(next.distinctId, "alex");
  await next.reset();
  assert.notEqual(next.distinctId, "alex");
  await next.shutdown();
});

test("Exact passes its host deadline, preserves stable IDs, and validates acknowledgement totals", async () => {
  const calls = [];
  const client = createExactClient({
    ...config,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ accepted: 0, duplicates: 2 });
    },
  });
  const input = {
    event: "view",
    distinctId: "alex",
    id: "view:12",
    properties: { page: "home" },
  };
  assert.deepEqual(
    await client.captureBatch([input, { ...input, id: "view:13" }]),
    { accepted: 0, duplicates: 2 }
  );
  assert.equal(calls[0].init.exactTimeout, 5000);
  const batch = JSON.parse(calls[0].init.body).batch;
  assert.equal(batch[0].uuid, "view:12");
  assert.equal("timestamp" in batch[0], false);
  await assert.rejects(client.capture(input), { code: "invalid_response" });
  await assert.rejects(client.captureBatch([]), { code: "invalid_input" });
  await assert.rejects(client.capture({ ...input, id: " " }), {
    code: "invalid_input",
  });
  await assert.rejects(client.capture({ ...input, properties: { bad: NaN } }), {
    code: "invalid_input",
  });
  assert.equal(calls.length, 2);
});
test("Exact surfaces a rejected grant and permanent HTTP errors after one attempt", async () => {
  const e = { event: "read", distinctId: "x", id: "read:1" };
  const denied = new Error("denied by host");
  await assert.rejects(
    createExactClient({
      ...config,
      fetch: async () => {
        throw denied;
      },
    }).capture(e),
    (x) => x === denied
  );
  let requests = 0;
  await assert.rejects(
    createExactClient({
      ...config,
      fetch: async () => {
        requests++;
        return new Response(null, { status: 401 });
      },
    }).capture(e),
    { code: "http", status: 401 }
  );
  assert.equal(requests, 1);
});

test("offline capture survives a new client, preserves identity and occurrence time, and retries a lost acknowledgement", async () => {
  const host = nativeAdapter();
  const values = new Map();
  let online = false,
    lose = true,
    signal;
  const committed = new Map(),
    acknowledgements = [];
  const options = {
    ...config,
    randomUUID: () => "anonymous",
    maxRetries: 0,
    batchSize: 1,
    storage: {
      async getItem(key) {
        return values.get(key) ?? null;
      },
      async setItem(key, value) {
        values.set(key, value);
      },
    },
    subscribeConnectivity(update) {
      signal = update;
      return () => {
        signal = undefined;
      };
    },
    async fetch(_url, init) {
      if (!online) throw new TypeError("offline");
      const event = JSON.parse(init.body).batch[0];
      const duplicate = committed.has(event.uuid);
      committed.set(event.uuid, event);
      if (lose) {
        lose = false;
        throw new TypeError("response lost");
      }
      acknowledgements.push(duplicate);
      return Response.json({
        accepted: duplicate ? 0 : 1,
        duplicates: duplicate ? 1 : 0,
      });
    },
  };
  const a = await host.create(options);
  await a.identify("original-user");
  const timestamp = "2025-01-02T03:04:05.000Z";
  assert.deepEqual(
    await a.enqueue("paid", { total: 19 }, { id: "order", timestamp }),
    { id: "order" }
  );
  await a.reset();
  await assert.rejects(a.shutdown());
  const b = await host.create(options);
  assert.equal(b.distinctId, "anonymous");
  online = true;
  await assert.rejects(b.flush());
  signal(true);
  await b.flush();
  await b.shutdown();
  assert.deepEqual(
    [...committed.values()].map((e) => [
      e.distinct_id,
      e.timestamp,
      e.properties.total,
    ]),
    [["original-user", timestamp, 19]]
  );
  assert.deepEqual(acknowledgements, [true]);
  assert.equal(
    [...values.entries()].find(([k]) => k.startsWith("birdwatch:outbox"))[1],
    "[]"
  );
});

test("full queues and failed disk writes reject new events without evicting saved events", async () => {
  const values = new Map();
  let broken = false;
  const storage = {
    async getItem(k) {
      return values.get(k) ?? null;
    },
    async setItem(k, v) {
      if (broken) throw new Error("storage full");
      values.set(k, v);
    },
  };
  const client = await nativeAdapter().create({
    ...config,
    storage,
    randomUUID: () => "anon",
    maxQueueSize: 1,
    maxRetries: 0,
    fetch: async () => {
      throw Error("offline");
    },
  });
  broken = true;
  await assert.rejects(client.enqueue("a", {}, { id: "a" }), /storage full/);
  broken = false;
  await client.enqueue("b", {}, { id: "b" });
  await assert.rejects(client.enqueue("c", {}, { id: "c" }), {
    code: "queue_full",
  });
  await assert.rejects(client.shutdown());
  const rows = JSON.parse(
    [...values.entries()].find(([k]) => k.startsWith("birdwatch:outbox"))[1]
  );
  assert.deepEqual(
    rows.map((e) => e.uuid),
    ["b"]
  );
});

test("Exact serializes SQLite access and replays the original occurrence after a lost response", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite)
    return t.skip(
      "node:sqlite is required to run the real SQLite adapter test"
    );
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "birdwatch-exact-"));
  const file = join(dir, "events.db");
  let busy = false;
  const storage = {
    async open() {
      assert.equal(
        busy,
        false,
        "An open handle still owns the Exact storage lock"
      );
      busy = true;
      const db = new sqlite.DatabaseSync(file);
      db.exec("PRAGMA journal_mode=DELETE");
      return {
        async execute(sql, params = []) {
          return db.prepare(sql).run(...params);
        },
        async query(sql, params = []) {
          return {
            rows: db
              .prepare(sql)
              .all(...params)
              .map(Object.values),
          };
        },
        async close() {
          db.close();
          busy = false;
        },
      };
    },
  };
  const seen = new Map();
  let lose = true;
  const options = {
    ...config,
    fetch: async (_url, init) => {
      const event = JSON.parse(init.body).batch[0];
      const duplicate = seen.has(event.uuid);
      seen.set(event.uuid, event);
      if (lose) {
        lose = false;
        throw new Error("lost response");
      }
      return Response.json({
        accepted: duplicate ? 0 : 1,
        duplicates: duplicate ? 1 : 0,
      });
    },
  };
  try {
    const first = createExactClient(options);
    const event = {
      id: "a",
      event: "purchase",
      distinctId: "before-reset",
      timestamp: "2026-01-01T00:00:00Z",
    };
    await Promise.all([
      first.enqueue(event, storage),
      first.enqueue({ ...event, id: "b" }, storage),
    ]);
    const restored = createExactClient(options);
    assert.deepEqual(
      await createExactClient({ ...options, writeKey: "other" }).flush(storage),
      { accepted: 0, duplicates: 0 }
    );
    await assert.rejects(restored.flush(storage), /lost response/);
    assert.deepEqual(await restored.flush(storage), {
      accepted: 1,
      duplicates: 1,
    });
    assert.deepEqual(await restored.flush(storage), {
      accepted: 0,
      duplicates: 0,
    });
    assert.equal(seen.get("a").timestamp, event.timestamp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
