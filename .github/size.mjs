import { execFileSync } from "node:child_process";
import { extname } from "node:path";

const areas = ["server", "dashboard", "sdk-web", "sdk-mobile", "tests"];
const source = new Set(".go .py .js .jsx .mjs .ts .tsx .mts .cts .css .html .swift .java .kt .gradle .xml .sql".split(" "));
const marker = "<!-- birdwatch-source-lines -->";
const run = (program, ...args) => execFileSync(program, args, {encoding: "utf8", maxBuffer: 32 * 1024 * 1024});

function area(path) {
  const parts = path.split("/");
  if (parts.some(p => ["dist","build",".build","node_modules","static","public"].includes(p))) return;
  if (path.startsWith("sdks/conformance/") && extname(path) === ".json") return "tests";
  if (!source.has(extname(path))) return;
  if (parts.some(p => ["test","tests","Tests","androidTest","contract","conformance"].includes(p)) || path.endsWith("_test.go")) return "tests";
  if (["server.py","birdwatch","cmd","internal"].includes(parts[0])) return "server";
  if (parts[0] === "ui") return "dashboard";
  if (parts[0] === "sdk" || path.startsWith("sdks/web/")) return "sdk-web";
  if (parts[0] === "sdks") return "sdk-mobile";
}

function counts(ref) {
  const totals = Object.fromEntries(areas.map(a => [a, 0]));
  for (const entry of run("git", "ls-tree", "-rz", ref).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    const group = area(entry.slice(tab + 1));
    if (!group || !["100644", "100755"].includes(mode)) continue;
    const blob = run("git", "cat-file", "blob", oid);
    totals[group] += blob.split("\n").length - (blob.endsWith("\n") || !blob ? 1 : 0);
  }
  return totals;
}

function report(repo, pr) {
  if (!/^\d+$/.test(String(pr))) throw new Error("Expected a numeric pull request");
  run("git", "fetch", "--no-tags", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main", `+refs/pull/${pr}/head:refs/remotes/origin/size-pr`);
  const main = counts("origin/main"), head = counts("origin/size-pr");
  const rows = [marker, "### Source lines", "", "| Area | main | PR | Change |", "| --- | ---: | ---: | ---: |"];
  for (const a of areas) {
    const delta = head[a] - main[a];
    rows.push(`| ${a} | ${main[a]} | ${head[a]} | ${delta >= 0 ? "+" : ""}${delta} |`);
  }
  const path = `repos/${repo}/issues/${pr}/comments`;
  const existing = JSON.parse(run("gh", "api", "--paginate", "--slurp", path)).flat()
    .find(c => c.user.login === "github-actions[bot]" && c.body.startsWith(marker));
  run("gh", "api", "--silent", "-X", existing ? "PATCH" : "POST",
    existing ? `repos/${repo}/issues/comments/${existing.id}` : path, "-f", "body=" + rows.join("\n"));
}

const { GITHUB_REPOSITORY: repo, PR, HEAD_SHA } = process.env;
if (PR) report(repo, PR);
else {
  const pulls = JSON.parse(run("gh", "api", `repos/${repo}/commits/${HEAD_SHA}/pulls`));
  for (const pr of pulls) if (pr.state === "open" && pr.head.sha === HEAD_SHA) report(repo, pr.number);
}
