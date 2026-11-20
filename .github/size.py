"""Count source in two Git trees and update Birdwatch's PR size comment."""
import json
import os
import subprocess
from pathlib import PurePosixPath

AREAS = ("server", "dashboard", "sdk-web", "sdk-mobile", "tests")
SOURCE = {".go", ".py", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts", ".cts",
          ".css", ".html", ".swift", ".java", ".kt", ".gradle", ".xml", ".sql"}
MARKER = "<!-- birdwatch-source-lines -->"


def area(path):
    parts = path.parts
    if {"dist", "build", ".build", "node_modules", "static", "public"}.intersection(parts):
        return None
    if parts[:2] == ("sdks", "conformance") and path.suffix == ".json":
        return "tests"
    if path.suffix not in SOURCE:
        return None
    if {"test", "tests", "Tests", "androidTest", "contract", "conformance"}.intersection(parts) or path.name.endswith("_test.go"):
        return "tests"
    if parts[0] in {"server.py", "birdwatch", "cmd", "internal"}:
        return "server"
    if parts[0] == "ui":
        return "dashboard"
    if parts[0] == "sdk" or parts[:2] == ("sdks", "web"):
        return "sdk-web"
    if parts[0] == "sdks":
        return "sdk-mobile"
    return None


def counts(revision):
    totals = dict.fromkeys(AREAS, 0)
    tree = subprocess.check_output(["git", "ls-tree", "-rz", revision])
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, filename = entry.split(b"\t", 1)
        mode, _, oid = metadata.split()
        group = area(PurePosixPath(os.fsdecode(filename)))
        if group and mode in {b"100644", b"100755"}:
            blob = subprocess.check_output(["git", "cat-file", "blob", oid])
            totals[group] += blob.count(b"\n") + int(bool(blob) and not blob.endswith(b"\n"))
    return totals


def report(repo, pr):
    subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin",
                    "+refs/heads/main:refs/remotes/origin/main",
                    f"+refs/pull/{pr}/head:refs/remotes/origin/size-pr"], check=True)
    base, head = counts("origin/main"), counts("origin/size-pr")
    rows = [MARKER, "### Source lines", "", "| Area | main | PR | Change |", "| --- | ---: | ---: | ---: |"]
    for key in AREAS:
        rows.append(f"| {key} | {base[key]} | {head[key]} | {head[key] - base[key]:+d} |")
    endpoint = f"repos/{repo}/issues/{pr}/comments"
    pages = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", endpoint]))
    method = "POST"
    for comment in (comment for page in pages for comment in page):
        if comment["user"]["login"] == "github-actions[bot]" and comment["body"].startswith(MARKER):
            endpoint = f"repos/{repo}/issues/comments/{comment['id']}"
            method = "PATCH"
            break
    subprocess.run(["gh", "api", "--silent", "-X", method, endpoint, "-f", "body=" + "\n".join(rows)], check=True)


if __name__ == "__main__":
    repo = os.environ["GITHUB_REPOSITORY"]
    if "PR" in os.environ:
        report(repo, int(os.environ["PR"]))
    else:
        # Fork workflow_run payloads may omit pull_requests. Resolve the tested commit through GitHub.
        sha = os.environ["HEAD_SHA"]
        pulls = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/commits/{sha}/pulls"]))
        for pull in pulls:
            if pull["state"] == "open" and pull["head"]["sha"] == sha:
                report(repo, pull["number"])
