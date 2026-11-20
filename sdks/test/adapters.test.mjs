import test from "node:test";
import assert from "node:assert/strict";
import { createExactClient } from "../exact/dist/index.js";

test("Exact passes the host deadline and scoped network grant to the collector", async () => {
  let calls = 0;
  const client = createExactClient({
    host: "https://birdwatch.example/prefix/",
    writeKey: "fixture",
    timeoutMs: 1200,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://birdwatch.example/prefix/api/capture");
      assert.equal(init.exactTimeout, 1200);
      return Response.json({ accepted: 1, duplicates: 0, rejected: [] });
    },
  });
  await client.capture({ id: "one", event: "example", distinctId: "fixture" }, Date.UTC(2026, 0, 1));
  assert.equal(calls, 1);
});
