import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp, mkdir, writeFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
for (const name of ["exact", "react-native"]) {
  const root = name + "/dist/";
  await mkdir(root, { recursive: true });
  for (const [format, file] of [
    ["esm", "index.js"],
    ["cjs", "index.cjs"],
  ]) {
    await build({
      absWorkingDir: process.cwd(),
      entryPoints: [name + "/index.ts"],
      outfile: root + file,
      format,
      platform: "neutral",
      bundle: true,
      target: "es2020",
      external: ["@birdwatch/sdk/internal", "react-native", "@react-native-async-storage/async-storage"],
      legalComments: "none",
    });
  }
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--declaration",
      "--emitDeclarationOnly",
      "--rootDir",
      "..",
      "--outDir",
      root + "types",
      "native-module.d.ts",
      name + "/index.ts",
    ],
    { stdio: "inherit" }
  );
  // Re-export types from one package-relative entry, for both module systems.
  const entry = "./types/sdks/" + name + "/index.js";
  await writeFile(root + "index.d.ts", 'export * from "' + entry + '";\n');
  await cp(root + "types", root + "common-types", { recursive: true });
  await writeFile(root + "common-types/package.json", '{"type":"commonjs"}\n');
  await writeFile(
    root + "index.d.cts",
    'export * from "' + entry.replace("/types/", "/common-types/") + '";\n'
  );
}
