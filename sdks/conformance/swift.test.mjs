import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const build = await mkdtemp(join(tmpdir(), "birdwatch-swift-driver-"));
after(() => rm(build, { recursive: true, force: true }));
const binary = join(build, "driver");
const src = join(root, "sdks/swift/Sources/Birdwatch");
execFileSync("swiftc", [
  "-parse-as-library",
  ...(await readdir(src))
    .filter((x) => x.endsWith(".swift"))
    .map((x) => join(src, x)),
  join(root, "sdks/conformance/SwiftDriver.swift"),
  "-o",
  binary,
]);

class SwiftDriver {
  constructor(collector, config, dir) {
    this.collector = collector;
    this.config = config;
    this.dir = dir;
    this.requests = [];
    this.errors = [];
    this.pending = new Map();
    this.inflight = new Set();
    this.id = 0;
    this.now = Date.UTC(2026, 0, 1);
    this.online = true;
  }
  async start() {
    this.proc = spawn(binary, [this.collector.host, this.dir], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const child = this.proc;
    this.exited = once(child, "exit");
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.sent !== undefined) {
        this.requests.push({ sent: message.sent });
        return;
      }
      if (message.errorEvent) {
        this.errors.push(message.errorEvent);
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.failure) pending?.reject(Error(message.failure));
      else pending?.resolve(message);
    });
    await this.send("open", { config: this.config });
  }
  send(op, fields = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        JSON.stringify({ id, op, now: this.now, ...fields }) + "\n"
      );
    });
  }
  async stop() {
    this.proc.kill("SIGKILL");
    await this.exited;
    for (const p of this.pending.values()) p.resolve({});
    this.pending.clear();
  }
  async close() {
    await this.stop();
    await rm(this.dir, { recursive: true, force: true });
  }
  async delivery(op) {
    const before = this.collector.requests.length;
    let settled = false;
    const sent = this.send(op).finally(() => {
      settled = true;
      this.inflight.delete(sent);
    });
    this.inflight.add(sent);
    const deadline = Date.now() + 8000;
    while (!settled) {
      if (this.collector.requests.length > before && this.collector.held)
        return;
      if (Date.now() > deadline) throw Error("Swift delivery did not settle");
      await sleep(2);
    }
    await sent;
  }
  async advance(ms) {
    const end = this.now + ms;
    for (let i = 0; i < 1000; i++) {
      const { due } = await this.send("due");
      if (due === undefined || due > end) {
        this.now = end;
        return;
      }
      this.now = Math.max(this.now, due);
      await this.delivery("tick");
    }
    throw Error("Swift delivery repeatedly scheduled an immediate retry");
  }
  async quarantined() {
    for (const file of await readdir(this.dir)) {
      if (
        file !== "outbox.sqlite3" &&
        (await readFile(join(this.dir, file))).includes("{corrupt fixture")
      )
        return true;
    }
    return false;
  }
  async step(step) {
    if (step.capture) {
      for (const id of step.capture)
        await this.send("capture", {
          event: this.config.generatedIds ? id : "example",
          uuid: this.config.generatedIds ? undefined : id,
        });
    } else if (step.advanceMs !== undefined) await this.advance(step.advanceMs);
    else if (step.clockAheadMs !== undefined) this.now += step.clockAheadMs;
    else
      switch (step) {
        case "flush":
          await this.delivery("flush");
          break;
        case "release":
          this.collector.release();
          await Promise.all([...this.inflight]);
          break;
        case "restart":
          await this.stop();
          this.collector.release();
          await this.start();
          break;
        case "online":
        case "offline":
          await this.send(step);
          break;
        case "corruptOutbox":
          await this.send("close");
          await writeFile(join(this.dir, "outbox.sqlite3"), "{corrupt fixture");
          break;
        case "hide":
          {
            const before = this.collector.requests.length;
            await this.send("hide");
            this.unloadDelivery =
              this.collector.held > 0 &&
              this.collector.requests.length > before;
          }
          break;
      }
  }
}

const scenarios = new URL("./scenarios/", import.meta.url);
for (const file of (await readdir(scenarios))
  .filter((x) => x.endsWith(".json"))
  .sort()) {
  const scenario = JSON.parse(await readFile(new URL(file, scenarios)));
  test(file + " — " + scenario.rule, { timeout: 30000 }, async () => {
    const actual = await runScenario(scenario, async (collector, config) => {
      const driver = new SwiftDriver(
        collector,
        config,
        await mkdtemp(join(build, "case-"))
      );
      await driver.start();
      return driver;
    });
    assert.deepEqual(actual, scenario.expect);
  });
}
