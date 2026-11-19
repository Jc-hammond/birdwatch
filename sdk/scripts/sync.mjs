import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const stage = await mkdtemp(join(tmpdir(), "birdwatch-sdk-"));
try {
  const [packed] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        stage,
      ],
      { encoding: "utf8" }
    )
  );
  for (const dir of ["../ui/public", "../static"]) {
    await mkdir(join(dir, "assets"), { recursive: true });
    await copyFile("dist/birdwatch.js", join(dir, "birdwatch.js"));
    await copyFile(
      join(stage, packed.filename),
      join(dir, "assets", packed.filename)
    );
  }
  console.log("Synced browser script and", packed.filename);
} finally {
  await rm(stage, { recursive: true, force: true });
}
