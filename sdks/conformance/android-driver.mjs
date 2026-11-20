// The Gradle JVM test owns the Android process and answers each command over pipes.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { runScenario } from "./run.mjs";

const replies = createInterface({input: process.stdin})[Symbol.asyncIterator]();
async function command(op, fields = {}) {
  process.stdout.write(JSON.stringify({op, ...fields}) + "\n");
  const {value, done} = await replies.next();
  if (done) throw Error("Android test driver closed");
  const reply = JSON.parse(value);
  if (reply.failure) throw Error(reply.failure);
  return reply;
}

const scenarios = new URL("./scenarios/", import.meta.url);
for (const file of (await readdir(scenarios)).filter(f => f.endsWith(".json")).sort()) {
  const scenario = JSON.parse(await readFile(new URL(file, scenarios)));
  const actual = await runScenario(scenario, async (collector, config) => {
    let now = Date.UTC(2026, 0, 1);
    const open = () => command("open", {host:collector.host, config, now});
    await command("reset");
    await open();
    const driver = {
      requests: [], errors: [],
      async status() {
        const state = await command("status");
        driver.requests = state.sent.map(sent => ({sent}));
        driver.errors = state.errors;
        return state;
      },
      async settle() {
        const end = Date.now() + 8000;
        for (;;) {
          const {active} = await driver.status();
          if (active === collector.held) return;
          if (Date.now() >= end) throw Error(file + ": Android delivery did not settle");
          await sleep(2);
        }
      },
      async advance(ms) {
        const end = now + ms;
        for (let i = 0; i < 1000; i++) {
          const {due} = await driver.status();
          if (due === undefined || due > end) {
            now = end;
            await command("clock", {now});
            return;
          }
          now = Math.max(now, due);
          await command("tick", {now});
          await driver.settle();
        }
        throw Error("Android retry timer did not settle");
      },
      async step(step) {
        if (step.capture) {
          for (const id of step.capture) await command("enqueue", {id, generated:config.generatedIds === true});
        } else if (step.advanceMs !== undefined) await driver.advance(step.advanceMs);
        else if (step.clockAheadMs !== undefined) {
          now += step.clockAheadMs;
          await command("clock", {now, shift: step.clockAheadMs});
        } else if (step === "restart") {
          await command("close");
          collector.release();
          await open();
        } else if (step === "release") collector.release();
        else if (step === "hide") {
          const before = collector.requests.length;
          await command("hide");
          await driver.settle();
          driver.unloadDelivery = collector.held > 0 && collector.requests.length > before;
        } else await command(step);
        await driver.settle();
      },
      async quarantined() { return (await command("quarantined")).found; },
      async close() { await command("close"); },
    };
    return driver;
  });
  assert.deepEqual(actual, scenario.expect, file);
}
await command("done");
process.stdin.destroy();
