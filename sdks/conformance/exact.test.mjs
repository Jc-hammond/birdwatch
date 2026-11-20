import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { ExactDriver } from "./exact-driver.mjs";
import { runScenario } from "./run.mjs";

const scenarios = new URL("./scenarios/", import.meta.url);
for (const file of (await readdir(scenarios)).filter((f) => f.endsWith(".json")).sort()) {
  const scenario = JSON.parse(await readFile(new URL(file, scenarios)));
  test(file + " – " + scenario.rule, async () => {
    assert.deepEqual(await runScenario(scenario, ExactDriver.create), scenario.expect);
  });
}
