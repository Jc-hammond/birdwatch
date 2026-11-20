import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const manifests = {};
const versions = {};
for (const [name, dir] of Object.entries({ web: "sdk", exact: "sdks/exact", reactNative: "sdks/react-native" })) {
  manifests[name] = JSON.parse(await readFile(dir + "/package.json", "utf8"));
  versions[name] = manifests[name].version;
}
versions.android = (await readFile("sdks/android/build.gradle", "utf8")).match(/^version\s*=\s*'([^']+)'/m)[1];
versions.swift = (await readFile("sdks/swift/VERSION", "utf8")).trim();
await mkdir("ui/src/generated", { recursive: true });
await writeFile("ui/src/generated/sdk-versions.json", JSON.stringify(versions, null, 2) + "\n");

if (process.argv.includes("--pack")) {
  const stage = await mkdtemp(join(tmpdir(), "birdwatch-sdk-archives-"));
  const assets = join(stage, "assets");
  try {
    await mkdir(assets);
    function pack(cwd) {
      const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", assets], {
        cwd, encoding: "utf8",
      });
      return join(assets, JSON.parse(output)[0].filename);
    }
    const core = pack("sdk");
    for (const [name, dir] of [["exact", "sdks/exact"], ["reactNative", "sdks/react-native"]]) {
      const pkg = manifests[name];
      const offline = join(stage, name);
      const dependency = join(offline, "node_modules/@birdwatch/sdk");
      await mkdir(dependency, { recursive: true });
      execFileSync("tar", ["-xzf", core, "--strip-components=1", "-C", dependency]);
      for (const file of pkg.files) await cp(join(dir, file), join(offline, file), { recursive: true });
      await writeFile(join(offline, "package.json"), JSON.stringify({ ...pkg, bundleDependencies: ["@birdwatch/sdk"] }));
      pack(offline);
    }
    await cp("sdks/android/build/outputs/aar/birdwatch-android-release.aar", join(assets, `birdwatch-android-${versions.android}.aar`));
    execFileSync("zip", ["-qr", join(assets, `birdwatch-swift-${versions.swift}.zip`), "Package.swift", "Sources", "Tests", "LICENSE", "README.md"], { cwd: "sdks/swift" });
    await rm("ui/public/assets", { recursive: true, force: true });
    await cp(assets, "ui/public/assets", { recursive: true });
    await cp("sdk/dist/birdwatch.js", "ui/public/birdwatch.js");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
