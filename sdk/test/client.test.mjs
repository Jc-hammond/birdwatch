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
    writeKey: "bw_test",
    flushIntervalMs: 60000,
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
const code = (expected) => (error) =>
  error instanceof BirdwatchError && error.code === expected;

test("imports with require and ESM without browser globals", () => {
  const require = createRequire(import.meta.url);
  assert.equal(
    typeof require("@birdwatch/sdk").createBrowserClient,
    "function",
  );
  assert.throws(
    () =>
      createServerClient({
        host: "https://name:secret@collector.test",
        writeKey: "key",
      }),
    code("invalid_input"),
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
    onError: async () => {
      throw new Error("observer failed");
    },
  });
  await assert.rejects(
    client.capture({ event: "missing identity" }),
    code("invalid_input"),
  );
});
