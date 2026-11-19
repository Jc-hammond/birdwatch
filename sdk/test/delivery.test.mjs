import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServerClient, BirdwatchError } from "@birdwatch/sdk";

const input = (id, properties = {}) => ({
  event: "clicked",
  distinctId: "person",
  id,
  properties,
});
const ack = (accepted, duplicates = 0) =>
  Response.json({ accepted, duplicates });
function harness(options = {}, transport) {
  const requests = [];
  const client = createServerClient({
    host: "https://collector.example/prefix/",
    writeKey: "sn_test",
    flushIntervalMs: 60000,
    maxRetries: 0,
    ...options,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      return transport
        ? transport(body, init, requests.length)
        : ack(body.batch.length);
    },
  });
  return { client, requests };
}
function gate() {
  let open;
  const wait = new Promise((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
const code = (expected) => (error) =>
  error instanceof BirdwatchError && error.code === expected;

test("imports with require and ESM without browser globals", () => {
  const require = createRequire(import.meta.url);
  assert.equal(
    typeof require("@birdwatch/sdk").createBrowserClient,
    "function"
  );
  assert.throws(
    () =>
      createServerClient({
        host: "https://name:secret@collector.test",
        writeKey: "key",
      }),
    code("invalid_input")
  );
});
test("snapshots properties, identity, event time and exact batch receipts", async () => {
  const { client, requests } = harness({ batchSize: 2 });
  const props = { plan: "free", flags: [true] };
  const one = client.capture({
    ...input("one", props),
    timestamp: "2025-01-01T03:00:00.123456+03:00",
  });
  props.flags[0] = false;
  const two = client.capture({ ...input("two"), distinctId: "other" });
  assert.deepEqual(await Promise.all([one, two]), [
    { id: "one", batch: { accepted: 2, duplicates: 0 } },
    { id: "two", batch: { accepted: 2, duplicates: 0 } },
  ]);
  const [{ url, init, body }] = requests;
  assert.equal(url, "https://collector.example/prefix/api/capture");
  assert.equal(init.credentials, "omit");
  assert.equal(body.batch[0].timestamp, "2025-01-01T00:00:00.123456Z");
  assert.deepEqual(body.batch[0].properties, { plan: "free", flags: [true] });
  assert.deepEqual(
    body.batch.map((e) => e.distinct_id),
    ["person", "other"]
  );
});
test("timer delivers a single low-volume event", async () => {
  const { client, requests } = harness({ flushIntervalMs: 5 });
  await client.capture(input("timer"));
  assert.equal(requests.length, 1);
});
test("ambiguous network failure retries identical bytes and IDs", async () => {
  const { client, requests } = harness(
    { batchSize: 1, maxRetries: 1 },
    (_, init, i) => {
      if (i === 1) throw new TypeError("Response lost after commit");
      return ack(0, 1);
    }
  );
  const result = await client.capture({ event: "purchase", distinctId: "p" });
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.equal(result.id, requests[0].body.batch[0].uuid);
  assert.deepEqual(result.batch, { accepted: 0, duplicates: 1 });
});
test("transient HTTP errors retry; permanent credentials errors surface once", async () => {
  for (const status of [429, 503, 401]) {
    const observed = [];
    const { client, requests } = harness(
      { batchSize: 1, maxRetries: 1, onError: (e) => observed.push(e) },
      (_, init, i) =>
        i === 1 || status === 401 ? new Response("failure", { status }) : ack(1)
    );
    const sent = client.capture(input("http"));
    if (status === 401) {
      await assert.rejects(sent, (e) => e.status === 401 && e.code === "http");
      assert.equal(requests.length, 1);
      assert.equal(observed.length, 1);
    } else {
      await sent;
      assert.equal(requests.length, 2);
    }
  }
});
test("honors a long Retry-After without retrying early", async () => {
  const { client, requests } = harness(
    { batchSize: 1, maxRetries: 3 },
    () => new Response("", { status: 429, headers: { "Retry-After": "60" } })
  );
  await assert.rejects(client.capture(input("rate")), (e) => e.status === 429);
  assert.equal(requests.length, 1);
});
test("rejects malformed acknowledgements and request timeouts", async () => {
  const bad = harness({ batchSize: 1 }, () => ack(0, 0));
  await assert.rejects(
    bad.client.capture(input("bad")),
    code("invalid_response")
  );
  const slow = harness(
    { timeoutMs: 10, batchSize: 1 },
    (_, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("abort")),
          { once: true }
        );
      })
  );
  await assert.rejects(slow.client.capture(input("slow")), code("timeout"));
});
test("queue capacity includes the in-flight batch; flush is a finite barrier", async () => {
  const first = gate(),
    second = gate();
  const { client } = harness(
    { batchSize: 1, maxQueueSize: 2 },
    async (_, init, i) => {
      await (i === 1 ? first : second).wait;
      return ack(1);
    }
  );
  const a = client.capture(input("one"));
  const flushed = client.flush();
  const b = client.capture(input("two"));
  await assert.rejects(client.capture(input("overflow")), code("queue_full"));
  first.open();
  await flushed;
  await a;
  const shutdown = client.shutdown();
  assert.equal(shutdown, client.shutdown());
  await assert.rejects(client.capture(input("closed")), code("closed"));
  second.open();
  await b;
  await shutdown;
});
test("splits bounded HTTP bodies while preserving event order", async () => {
  const { client, requests } = harness({ batchSize: 100 });
  const events = Array.from({ length: 8 }, (_, i) =>
    client.capture(input(String(i), { large: "x".repeat(20000) }))
  );
  await client.flush();
  await Promise.all(events);
  assert.ok(requests.length > 1);
  assert.ok(requests.every((r) => Buffer.byteLength(r.init.body) <= 48 * 1024));
  assert.deepEqual(
    requests.flatMap((r) => r.body.batch.map((e) => e.uuid)),
    Array.from({ length: 8 }, (_, i) => String(i))
  );
});
test("isolates an atomically rejected event and drains healthy neighbors", async () => {
  const { client } = harness({}, (body) =>
    body.batch.some((e) => e.uuid === "reject")
      ? Response.json({ error: "invalid event" }, { status: 400 })
      : ack(body.batch.length)
  );
  const settled = Promise.allSettled(
    ["one", "reject", "three"].map((id) => client.capture(input(id)))
  );
  await assert.rejects(client.flush(), (e) => e.status === 400);
  assert.deepEqual(
    (await settled).map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled"]
  );
});
test("checks inputs before enqueue, including Python's ASCII-escaped properties limit", async () => {
  const cycles = {};
  cycles.self = cycles;
  const { client, requests } = harness();
  const invalid = [
    input("x", { n: NaN }),
    input("x", { n: 1n }),
    input("x", { n: undefined }),
    input("x", { n: new Date() }),
    input("x", cycles),
    input("x", { emoji: "🦔".repeat(2800) }),
    { ...input("x"), timestamp: "2025-02-30T12:00:00Z" },
    { ...input("x"), timestamp: "2025-01-01" },
    { ...input("x"), distinctId: "\ud800" },
    { ...input("x"), event: "" },
    { event: "x" },
  ];
  for (const e of invalid)
    await assert.rejects(client.capture(e), code("invalid_input"));
  assert.equal(requests.length, 0);
});

test("a failing async observer does not replace a delivery error", async () => {
  const { client } = harness({
    onError: async () => { throw new Error("observer failed"); }
  });
  await assert.rejects(client.capture({event:"missing identity"}), code("invalid_input"));
});
