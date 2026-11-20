import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { startCollector } from "./collector.mjs";
import { WebDriver } from "./web-driver.mjs";

const scenarios = new URL("./scenarios/", import.meta.url);
const gaps = JSON.parse(await readFile(new URL("./web-gaps.json", import.meta.url)));


async function run(scenario) {
  const collector = await startCollector(scenario.collector);
  try {
    const driver = new WebDriver(collector, scenario.config);
    for (const step of scenario.steps) await driver.step(step);
    const {expect} = scenario;
    const aliases = new Map();
    if (scenario.config?.generatedIds) {
      for (const batch of collector.requests) {
        for (const event of batch?.batch ?? []) aliases.set(event.uuid,event.event);
      }
    }
    const label = id => aliases.get(id) ?? id;
    const ids = body => Array.isArray(body?.batch) ? body.batch.map(event => label(event?.uuid)) : [];
    const actual = {
      requests: collector.requests.map(ids),
      stored: [...collector.stored].map(label),
    };
    if ("errors" in expect) actual.errors = driver.errors.length;
    if ("duplicates" in expect) actual.duplicates = collector.duplicates;
    if ("stableRetries" in expect) {
      const copies = collector.requests.flatMap(body => body.batch);
      actual.stableRetries = copies.length > 1 && copies.every(event => isDeepStrictEqual(event, copies[0]));
    }
    if ("retryDelaysMs" in expect) {
      actual.retryDelaysMs = driver.requests.slice(1).map(({sent}, i) => sent - driver.requests[i].sent);
    }
    if ("clockAgeMs" in expect) {
      const body = collector.requests[0];
      const sent = Date.parse(body?.sent_at);
      actual.clockAgeMs = sent === driver.requests[0]?.sent ? sent - Date.parse(body.batch[0].timestamp) : null;
    }
    if ("freshSendTimes" in expect) {
      actual.freshSendTimes = collector.requests.every((body, i) => Date.parse(body.sent_at) === driver.requests[i]?.sent);
    }
    if ("quarantined" in expect) {
      actual.quarantined = driver.storage.get(driver.corruptKey) !== "{corrupt fixture" &&
        [...driver.storage].some(([k,v]) => k !== driver.corruptKey && v.includes("{corrupt fixture"));
    }
    if ("unloadDelivery" in expect) actual.unloadDelivery = driver.unloadDelivery;

    // Observe the remaining outbox through delivery, including persisted rows recovered on restart.
    const before = collector.requests.length;
    collector.beginProbe();
    if (scenario.config?.persist) await driver.step("restart");
    await driver.step("online");
    await driver.step("flush");
    await driver.advance(300000);
    actual.outbox = collector.requests.slice(before).flatMap(ids);
    return actual;
  } finally {
    await collector.close();
  }
}

for (const file of (await readdir(scenarios)).filter(file => file.endsWith(".json")).sort()) {
  const name = file.slice(0,-5);
  const scenario = JSON.parse(await readFile(new URL(file,scenarios)));
  test(name + " — " + scenario.rule, async t => {
    const actual = await run(scenario);
    if (Object.hasOwn(gaps,name)) {
      assert.notDeepEqual(actual,scenario.expect, "Scenario now passes. Remove it from web-gaps.json.");
      t.diagnostic("Known gap: " + gaps[name]);
    } else {
      assert.deepEqual(actual, scenario.expect);
    }
  });
}
