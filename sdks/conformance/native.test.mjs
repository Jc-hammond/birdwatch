import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { runScenario } from "./run.mjs";
import { WebDriver } from "./web-driver.mjs";

const bundle = await readFile(
  new URL("../react-native/dist/index.cjs", import.meta.url),
  "utf8",
);
const scenarios = new URL("./scenarios/", import.meta.url);
for (const file of (await readdir(scenarios))
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const scenario = JSON.parse(await readFile(new URL(file, scenarios)));
  test(file + " – " + scenario.rule, async () => {
    const actual = await runScenario(
      scenario,
      (collector, config) => new WebDriver(collector, config, bundle),
    );
    assert.deepEqual(actual, scenario.expect);
  });
}
