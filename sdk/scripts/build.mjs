import { execFileSync } from "node:child_process";
import { cp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
  { stdio: "inherit" }
);
await cp("dist/types", "dist/types-cjs", { recursive: true });
await writeFile("dist/types-cjs/package.json", '{"type":"commonjs"}\n');
const common = {
  bundle: true,
  target: "es2022",
  banner: { js: "/*! Birdwatch SDK | MIT */" },
};
await Promise.all([
  build({
    ...common,
    entryPoints: ["src/index.ts"],
    format: "esm",
    outfile: "dist/index.js",
    sourcemap: true,
  }),
  build({
    ...common,
    entryPoints: ["src/index.ts"],
    format: "cjs",
    outfile: "dist/index.cjs",
    sourcemap: true,
  }),
  build({
    ...common,
    entryPoints: ["src/script.ts"],
    format: "iife",
    outfile: "dist/birdwatch.js",
    minify: true,
  }),
]);
