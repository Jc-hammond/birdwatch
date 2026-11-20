import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { runScenario } from "./run.mjs";
import { WebDriver } from "./web-driver.mjs";

const scenarios = new URL("./scenarios/", import.meta.url);
const gaps = JSON.parse(await readFile(new URL("./web-gaps.json", import.meta.url)));

for (const file of (await readdir(scenarios)).filter(file => file.endsWith(".json")).sort()) {
  const name = file.slice(0,-5);
  const scenario = JSON.parse(await readFile(new URL(file,scenarios)));
  test(name + " — " + scenario.rule, async t => {
    const actual = await runScenario(scenario, (collector, config) => new WebDriver(collector, config));
    if (Object.hasOwn(gaps,name)) {
      assert.notDeepEqual(actual,scenario.expect, "Scenario now passes. Remove it from web-gaps.json.");
      t.diagnostic("Known gap: " + gaps[name]);
    } else {
      assert.deepEqual(actual, scenario.expect);
    }
  });
}
