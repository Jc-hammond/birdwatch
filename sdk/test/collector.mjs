import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@birdwatch/sdk";

async function start(db) {
  const server = fileURLToPath(new URL("../../server.py", import.meta.url));
  const child = spawn(
    process.env.PYTHON || "python3",
    ["-B", server, "--port", "0", "--db", db, "--no-demo"],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const exit = once(child, "exit");
  const output = createInterface({ input: child.stdout });
  let host;
  try {
    const line = await Promise.race([
      once(output, "line").then(([line]) => line),
      exit.then(([code]) => {
        throw new Error("Server exited with " + code);
      }),
    ]);
    assert.match(line, /^Birdwatch listening at http:\/\/127\.0\.0\.1:\d+$/);
    host = line.split(" ").at(-1);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    output.close();
  }
  return {
    host,
    close: async () => {
      child.kill();
      await exit;
    },
  };
}

test("delivered events survive a lost acknowledgement, retry, and collector restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "birdwatch-sdk-"));
  const db = join(dir, "test.sqlite3");
  let service;
  try {
    service = await start(db);
    const setup = await (
      await fetch(service.host + "/api/projects/1/setup")
    ).json();
    let attempts = 0;
    const client = createServerClient({
      host: service.host,
      writeKey: setup.write_key,
      batchSize: 3,
      maxRetries: 1,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (++attempts === 1) {
          assert.ok(response.ok);
          await response.text();
          throw new TypeError("Lost acknowledgement");
        }
        return response;
      },
    });
    const captured = await Promise.all([
      client.capture({ event: "page_view", distinctId: "a" }),
      client.capture({ event: "page_view", distinctId: "b" }),
      client.capture({
        event: "sign_up",
        distinctId: "a",
        properties: { plan: "pro" },
      }),
    ]);
    await client.shutdown();
    assert.equal(attempts, 2);
    assert.ok(captured.every((r) => r.batch.duplicates === 3));
    await service.close();
    service = undefined;
    service = await start(db);
    const query = async (path) =>
      (await fetch(service.host + "/api/projects/1/" + path)).json();
    assert.deepEqual((await query("overview")).current, [3, 2, 2, 1.5]);
    assert.deepEqual(await query("funnel?first=page_view&second=sign_up"), {
      entered: 2,
      converted: 1,
    });
    assert.deepEqual((await query("events?name=sign_up")).rows[0].properties, {
      plan: "pro",
    });
  } finally {
    if (service) await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
