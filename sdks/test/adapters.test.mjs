import test from "node:test";
import assert from "node:assert/strict";
import { ExactDriver } from "../conformance/exact-driver.mjs";
import { createExactClient } from "../exact/dist/index.js";

test("Exact passes the host deadline and scoped network grant to the collector", async (t) => {
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
  const fixture = await ExactDriver.create({ host: "https://birdwatch.example" }, {});
  t.after(() => fixture.close());
  const ctx = { storage: fixture.storage, at: Date.UTC(2026, 0, 1) };
  await client.capture(ctx, "example", {}, { id: "one" });
  await client.flush({ storage: ctx.storage, sendTime: () => ctx.at });
  assert.equal(calls, 1);
});
