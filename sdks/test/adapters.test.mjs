import test from "node:test";
import assert from "node:assert/strict";
import { createExactClient } from "../exact/dist/index.js";

const config = {
  host: "https://birdwatch.example/prefix/",
  writeKey: "sample",
};

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
