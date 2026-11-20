# Birdwatch roadmap

Last decided 2026-11-18. Work is tracked in Linear (team `BIR`); every item below has one issue with the same ID in its title. Working rules for contributors and agents are in [AGENTS.md](../AGENTS.md).

## What Birdwatch is

A free, MIT-licensed, self-hosted analytics platform for developers and small teams who work with AI coding agents.

**The four opinions.** Each is a constraint on what gets built.

1. **Self-hosted, one process, one file.** A single binary and a single SQLite database. Nothing phones home.
2. **Light and fast.** Runs on the smallest server you can rent, with published numbers enforced in CI.
3. **Easy by default, flexible in the data.** Few settings and one right way to set things up. The flexibility is schemaless events and direct SQL access, not configuration.
4. **Agent-native.** An AI agent can install it, instrument an app with it, and answer questions from it with no human translating.

**The three claims.** These go on the homepage and each is checked automatically.

| Claim | Check |
| --- | --- |
| Install to first event in under two minutes, with one command | Browser end-to-end test (R6) |
| 10M events on a small server, every report under 300 ms | Benchmark (F3), raised only when measured |
| An agent can install it, instrument an app and answer a product question unaided | Agent check, run locally weekly and before each release (A10) |

Feature count is deliberately not a claim.

## Decisions

| Topic | Decision |
| --- | --- |
| First user | A solo developer or small team already using an AI coding agent |
| Business | Free and MIT. A sponsorship link at most. No paid features, no hosted service |
| Server language | Go. Ported from the current Python server, which is deleted once the Go server passes the same checks |
| Dependencies | Go standard library plus two exceptions: a SQLite driver and Go's extended crypto package. SDKs have no runtime dependencies. Build and test tooling is unrestricted. Anything else needs the maintainer's approval |
| Install | Download one binary and run it, or use the Docker image. Built-in automatic HTTPS with `--domain` |
| Breaking changes | Free until the maintainer says otherwise |
| Batch wire format | Valid events are stored and rejected ones reported individually |
| Website identity | Cookieless by default, one attribute switches to a stored ID |
| SDKs | All five (web/Node, React Native, Swift, Android, Exact) are maintained to the same standard |
| Reports | The full set is built, in release order, without waiting for demand |
| Teams | One admin login, scoped tokens and share links. Multi-user is deferred |
| Agent permissions | A capability list per token and project, with three presets. Deletion is off in every preset |
| Tests | Slim. See AGENTS.md for the rule |
| Releases | 0.5 Foundation, 0.8 Agent-native and web, 1.0 Product analytics and flags |
| Session replay | Deferred |
| Name and namespaces | Birdwatch stays. npm scope `@birdwatch` if it can be claimed, otherwise `@birdwatch-analytics`. Maven group `io.github.jc-hammond`. Docker image `ghcr.io/jc-hammond/birdwatch` |
| Specifications | Written by the maintainer with Claude in a session, one release at a time. All of 0.5 is specified |
| Full SDK queue | Drops the oldest events and reports it once through `onError` |
| Old databases | No migration from databases made by the Python server |
| Website | A hand-written static site with no build step, in `website/`. The maintainer publishes it as a Codex Site; agents never publish it |
| Starting work | The maintainer starts one session per issue |
| Cost | Everything runs on free tiers for a public repository. Nothing bills per use |
| Dates | None. After the first four issues land, review pace and the scope of 0.5 |

## How to read the items

Each item has an ID, a size (**S** under a day, **M** a few days, **L** a week or more), and a short statement of what done means. Items marked **review** change data handling or security and wait for the maintainer before merging. Items get a full specification in their Linear issue when they move to Todo.

SDK file references are from the audit at commit `2ee2bb3` and must be re-located before use.

---

# Release 0.5: Foundation

Nothing loses data, the server is the Go binary, all five SDKs obey one contract, and it installs from the places people look.

## Contract and checks

These come first. Unattended agents are only as reliable as what checks them.

### F1 · Protocol document (S, review)

`docs/protocol.md`, one page, the single source for the server and every SDK.

- **Capture:** `POST /api/capture` with a single event or `{api_key, sent_at, batch: [...]}`; up to 100 events and 1 MiB per request; 32 KiB of encoded properties per event. `Content-Type` may be `application/json` or `text/plain` (so browsers skip the preflight and `sendBeacon` works).
- **Per-event results:** `{"accepted": n, "duplicates": n, "rejected": [{"index", "code", "message"}]}`. Valid events are stored. `"atomic": true` restores all-or-nothing for callers that want it.
- **Error codes:** `invalid_event`, `unknown_key`, `too_large`, `rate_limited`, `unavailable`, `internal`. Every error body has `code` and a message that says what to change.
- **Retry classes:** retry on network errors, 408, 429, 5xx, and any response that is not the expected JSON. Terminal: `invalid_event`, `too_large`. Pause without deleting: `unknown_key`.
- **Backoff:** exponential from 1 s, doubling, capped at 60 s, full jitter. Honour `Retry-After` up to 5 minutes.
- **Clocks:** the server never rejects a timestamp for being in the future. With `sent_at`, it shifts event times by `received_at - sent_at`; without it, future times are clamped to receipt time.
- **Idempotency:** `uuid` is unique per project; a repeat is counted as a duplicate.

### F2 · HTTP contract tests (M, review)

Language-neutral tests that talk to a running server over HTTP, given a base URL. They are the definition of "the server works" for both the Python reference and the Go server.

- Port the existing eight Python tests (capture, batch, deduplication, UTC windows, funnels, search and pagination, access control, demo project).
- Add the audit's cases: 500 events from 40 concurrent clients all stored; a future timestamp is accepted; unknown methods and internal errors return JSON; per-event batch results; each error code.
- Cases the Python reference fails are marked expected-fail for Python only.

### F3 · Benchmark (M)

A script in `bench/` that generates N events and reports ingestion rate, per-report latency, memory and database size.

- CI runs it at 2M events with a latency budget on every pull request to the server.
- A nightly run at 10M backs the homepage claim.
- Reference numbers from the audit of the Python server at 2M events, 30-day range: funnel did not finish in 60 s, overview 9.4 s, people 3.1 s. With two extra indexes: 0.8–2.0 s, 2.0 s, 0.7 s.

### F4 · Continuous integration (S)

Four jobs: server (contract tests and benchmark), JavaScript (SDK and adapter tests, dashboard build), native SDKs (Swift, Android JVM), end-to-end (R6). Each pull request also gets a comment with line counts per area and the change from `main`.

### F5 · Branch protection (S)

`main` requires a pull request and passing CI. Applied once F4 exists.

## Go server

The Python server (`server.py`, `birdwatch/`) is the reference until G11. Nothing is fixed in Python.

### G1 · Skeleton (M)

Go module, package layout, configuration by flag and environment (`BIRDWATCH_HOST`, `_PORT`, `_DB`, `_PASSWORD`), a route table, JSON errors for every failure including panics and unknown methods, a privacy-preserving access log with route and duration, `/healthz`, graceful shutdown on `SIGTERM`, and a cap on concurrent requests.

### G2 · Storage (M, review)

- **Driver:** choose the SQLite driver by benchmark. Prefer pure Go (no C compiler needed); it must support what A1 needs to sandbox queries.
- **Schema v1** with the indexes the audit proved necessary: `(project_id, distinct_id, event, timestamp, id)` and `(project_id, timestamp, event, distinct_id)`.
- **Migrations** by `PRAGMA user_version`: ordered, transactional, refusing to open a newer database, and backing the file up automatically before migrating.
- WAL mode; one writer connection; read connections opened read-only with a query deadline.

### G3 · Capture (M, review)

`POST /api/capture` exactly as F1 specifies, including CORS with a 24-hour preflight cache.

### G4 · Access control (M, review)

Loopback access without a password; a password required to bind elsewhere; Host and Origin checks; security headers. Behaviour matches the Python reference and the contract tests.

### G5 · Read API (M)

Projects, overview, events, people, event names, funnel and setup, each bounded by the query deadline (503 with `Retry-After` when exceeded). Events and people paginate by cursor, not offset.

### G6 · Dashboard serving (S)

The built dashboard is embedded in the binary. Hashed assets are served immutable; everything else has an ETag; files are pre-compressed at build time.

### G7 · Demo project (S)

The frozen, read-only sample project, seeded deterministically, and `--no-demo`.

### G8 · Rollups (M, review)

`daily_events(project_id, day, event, count)` and `daily_people(project_id, day, distinct_id, count, first_ts, last_ts)`, maintained in the capture transaction. Overview, top events, event names and the people list read from them. A `rebuild-rollups` command recomputes both; one test asserts rollups equal a recomputation after random inserts.

### G9 · Retention and deletion (M, review)

Per-project `retention_days` (default unlimited) enforced by a background task that deletes in chunks and keeps rollups. An endpoint that erases one person's events and rollup rows.

### G10 · Built-in HTTPS (M, review)

`birdwatch --domain analytics.example.com` obtains and renews its own certificate. Without `--domain` it serves plain HTTP for loopback or a proxy.

### G11 · Cutover (S)

When the Go server passes F2 and meets the F3 budget: delete `server.py`, `birdwatch/` and `tests/`, replace the Dockerfile, and update the README.

## SDKs

### S1 · Conformance suite (M)

Scenario files in `sdks/conformance/`: a scripted collector plus the expected requests and final outbox state. Each SDK runs every scenario against a local fake collector (extend `sdk/test/collector.mjs`). This is the only SDK delivery test; SDKs do not carry their own hand-written delivery tests.

Scenarios: happy path, lost acknowledgement, 503 then success, `Retry-After`, one invalid event in a batch, a proxy's HTML 400, fast device clock, corrupt outbox, queue full, restart mid-flush, page unload during an in-flight request.

### S2 · Web and Node SDK (M, review)

- Requeue on retryable failure instead of rejecting after about half a second (`transport.ts:62`, `queue.ts:155`).
- On `pagehide` and hidden, send everything unacknowledged with `keepalive`, falling back to `sendBeacon`, even while a request is in flight (`queue.ts:110`).
- Optional `persist: true` durable queue in `localStorage`.
- On a cross-tab storage clear, re-read before generating a new ID (`browser.ts:55`).
- Apply the 48 KiB cap and `keepalive` only in the browser (`transport.ts:67,99`).
- Log once when the script tag has no `data-key` (`script.ts:18`). Export `Lifecycle`, `CaptureArgs`, `EventName`.

### S3 · React Native SDK (M, review)

- Quarantine a corrupt outbox instead of failing every call (`outbox.ts:43`).
- One storage key per event with batch reads and removes, replacing the whole-queue rewrite (`outbox.ts:75`).
- Double the backoff once per failed flush, not per row (`index.ts:101`).
- Send batches. Throw `BirdwatchError` everywhere (`index.ts:81`). Justify or lower the `react-native >=0.83.0` floor.

### S4 · Swift SDK (M, review)

- Recover from a corrupt outbox by moving the file aside (`Outbox.swift:26`).
- Schedule the retry in one place so backoff does not double twice (`Birdwatch.swift:124,189`); delete the inner retry loop (`:203-235`).
- Send batches; page the outbox read (`Outbox.swift:87`).
- Add `onError` and `close()`. Validate the 32 KiB cap and non-finite numbers locally as `BirdwatchError`.
- Flush when the app enters the background. Run SQLite on a dedicated queue. Rename `Persistence.userDefaults`.

### S5 · Android SDK (L, review)

- Never throw on the caller's thread; report through `onError` and the returned future (`Event.java:97,118`, `Birdwatch.java:196-209`).
- Send batches and reuse connections (`Collector.java:88`).
- Make `Collector` injectable so the conformance suite runs as plain JVM tests.
- Reduce the delivery pump (`Birdwatch.java:316-414`) to: take up to 100, send, delete acknowledged, reschedule. A failed flush fails only the events it attempted.
- Add nullability annotations. Flush when the app stops.

### S6 · Exact SDK (M, review)

Use the core transport instead of the duplicated acknowledgement check (`index.ts:94-106`); replace `sdks/endpoint.ts` with the core host validator; replay in batches and open the database once per flush (`outbox.ts:82-109`).

### S7 · One API shape (M)

Every SDK exposes the same six calls, differing only where the language forces it:

```text
capture(name, properties?, options?)   options: id, timestamp, distinctId (server only)
identify(distinctId, traits?)
reset()
flush()
close()
onError(handler)
```

`capture` resolves when the event is durably queued (or acknowledged where there is no durable queue) and returns the event ID.

## Repository and release

### R1 · One build, no build output in git (M)

Remove committed build output: `static/`, `ui/public/assets/`, every SDK `dist/` and superseded archives. The website folder is source, not build output, and is left to R4. One `Makefile` with `build`, `test`, `lint`, `release`. The JavaScript packages become one npm workspace; adapters depend on the core package instead of importing its source by relative path and borrowing its `node_modules`. The dashboard reads SDK versions from one generated file.

### R2 · Release pipeline (M)

A tag builds binaries for Linux, macOS and Windows on amd64 and arm64 with checksums, and a Docker image on GHCR that runs as a non-root user with a health check. Upgrade is one command. One version number for server and SDKs, with a changelog.

### R3 · SDK publishing (M)

npm for the JavaScript packages, Maven Central for Android under the group `io.github.jc-hammond` (changed from `dev.birdwatch`, which would need a domain), a tagged repository for SwiftPM. Confirm the `@birdwatch` npm scope can be claimed first; fall back to `@birdwatch-analytics`. The dashboard's Setup page shows registry installs and keeps the bundled downloads as the offline option.

### R4 · Website docs from Markdown (M)

The website's documentation pages are generated from the Markdown in `docs/` and committed, with CI failing when they are out of date. Links to bundled SDK archives become registry installs and GitHub release links, and the archives are removed. Publishing stays a manual step for the maintainer.

### R5 · Project scaffolding (S)

`CONTRIBUTING.md`, `SECURITY.md`, issue and pull-request templates, `CHANGELOG.md`, and a sponsorship link.

### R6 · End-to-end install test (M)

From a clean machine: install with the documented command, open the dashboard, create a project, send a page view with the script tag, and see it. The test records the elapsed time against the two-minute claim.

### R7 · Install and deployment guides (S)

An install script and two tested guides, each ending with a verification step: local (loopback) and public server (`--domain`, a generated password, scheduled backups on through O4).

### R8 · Dashboard fixes (M)

- Pin later pages to the first page's snapshot (resolved by cursor pagination in G5).
- Show totals in table footers.
- Keep search text and the Setup tab in the URL.
- Reset "Copied" after two seconds.
- Style a failed test event as an error and hide "View events".
- Pause polling in hidden tabs.
- Handle non-JSON error responses.
- Add an error boundary around the routed view.
- New projects show "waiting for your first event" with the snippet inline, switching to the live view when one arrives.

### R9 · Light theme (S)

A light theme that follows the system setting, with a manual switch.

### O4 · Backups (S)

`birdwatch backup <path>` using SQLite's online backup, and an optional schedule with rotation (`--backup-dir`, daily, newest seven kept). Moved here from release 1.0 because the public server guide (R7) turns backups on.

---

# Release 0.8: Agent-native and web analytics

The differentiator ships, and Birdwatch becomes a credible replacement for the simple web-analytics tools.

## Agent core

### A1 · Read-only SQL endpoint (M, review)

`POST /api/projects/{id}/query` with `{"sql", "params"}` returns columns and rows. Safety comes from SQLite, not from parsing SQL: a read-only connection, access limited to per-project views (`events`, `people`, `sessions`, the rollups), no attach or pragmas, the query deadline, and a row cap with explicit truncation. The views are the stable contract; tables behind them may change. Tests: reading another project, writing, attaching a file and running past the deadline are each rejected.

### A2 · Scoped tokens (M, review)

Per-project tokens, shown once, stored hashed, revocable, with last-used time. Each carries a set of capabilities: read data, run SQL, edit descriptions, manage flags, manage projects, delete data. Three presets (Read only, Read and flags, Full) cover most uses. Delete is off in every preset and requires typed confirmation to enable. Every change made with a token is recorded with the token's name.

### A3 · Self-describing schema (M)

A per-project catalogue of events and properties (name, type, example values, volume) maintained on ingest, with human-written descriptions editable in the dashboard and through the API. `GET /api/projects/{id}/schema` returns all of it in one document.

### A4 · Tracking plan as a file (M)

`birdwatch.events.json` in the user's repository declares events and property types. SDK types are generated from it. `birdwatch plan push` and `plan check` sync it with the server and report events arriving that are not in the plan.

### A5 · MCP server (M, review)

`birdwatch mcp` over stdio, and the same tools over HTTP at `/mcp` with a scoped token. Tools: `list_projects`, `get_schema`, `query_sql`, `get_overview`, `run_funnel`, `get_person`, and with the right capability `list_flags` and `set_flag`. Results carry units, the time range used, the row count and whether they were truncated. Every tool is annotated read-only or mutating.

Event data is untrusted input: property values are written by anyone who can reach the public capture endpoint. Tool output presents them as data, and the documentation says so plainly.

### A6 · Command line (S)

`birdwatch query`, `funnel`, `schema`, `projects`, `tokens`, `flags`, `backup`. Every command has `--json`, stable exit codes, no prompts, and plain output when not attached to a terminal.

### A7 · Docs agents can act on (S)

`llms.txt`, a single-file Markdown version of the docs, every docs page available as Markdown, an OpenAPI file generated from the route table, and an `AGENTS.md` in each SDK package covering install, the six calls and common mistakes.

### A8 · Install with an agent (S)

A Setup tab with a copyable prompt containing the host, the write key, the SDK to use and a verification step. A `verify` endpoint reports whether the project has received an event from a given SDK recently.

### A9 · Claude plugin (M)

A plugin repository bundling the MCP configuration and skills ("instrument this app", "weekly product review", "investigate a funnel drop"), asking for the user's instance URL and token, and running the stdio server against a local install in Claude Code. Submitted to the Claude directory. Check the current submission requirements first.

### A10 · Agent check (M)

One command the maintainer runs locally, weekly and before each release: one sample app, one agent in headless mode, three fixed tasks with known answers (install, instrument, answer a question). It reports pass or fail. It uses the maintainer's existing plan, so there is no API key and no CI secret. Pull-request CI covers the MCP tools and CLI directly without a model.

## Web analytics

### W1 · Automatic context (M)

Sent by the script tag and browser SDK as reserved `$` properties: path, referrer host, UTM parameters, screen width class, language, SDK name and version. Derived by the server: browser, operating system and device class from a small built-in parser. The IP address is never stored.

### W2 · Sessions (M, review)

A session ID with a 30-minute idle timeout and a `sessions` rollup maintained on ingest: start, end, event count, entry and exit path, referrer. Gives visits, bounce rate and visit duration.

### W3 · Single-page-app page views (S)

`data-pageview="auto"` follows `pushState`, `replaceState` and `popstate`.

### W4 · Cookieless by default (M, review)

With no stored ID, the server derives a visitor ID from a daily rotating salt, the project, the client address and the user agent. `data-identity="stored"` switches to a persistent anonymous ID. The trade-off (no cross-day identity) is documented.

### W5 · Bot and noise filtering (S)

Drop known crawlers and automated browsers, honour excluded addresses and a browser opt-out flag, and count what was dropped.

### W6 · Web reports (L)

Top pages, entry and exit pages, referrers and sources, campaigns, browsers, operating systems and devices. Every table row is a filter; filters stack and live in the URL.

### W7 · Time controls (M)

Custom date ranges, a comparison toggle, a per-project time zone, and a live count of visitors in the last five minutes.

### W8 · Goals (M)

Named conversions (an event with an optional property match, or a path) with a conversion rate against visitors.

## Funnels

### P1 · Property filters and breakdowns (M)

Filters and one breakdown on any report, using SQLite's JSON functions, with autocomplete from the catalogue (A3) and on-demand indexes for hot properties.

### P2 · Multi-step funnels (M)

Any number of steps, a conversion window, strict or loose order, a breakdown, time to convert, and a list of the people who dropped at each step. One pass per person over the person index, not a subquery per step.

---

# Release 1.0: Product analytics and flags

## Reports

### P3 · Trends (L)

A chart builder: one or more events, counted as totals, unique people or per-person average, by day, week or month, with filters and one breakdown.

### P4 · Retention (M)

The cohort grid: people who did A in one week and returned to do B in later weeks.

### P5 · Identity and traits (M, review)

`identify` from an anonymous ID records a link so earlier activity belongs to the same person. `alias` for server-side merges. Person traits are stored and usable in filters and breakdowns.

### P6 · Saved insights, dashboards and cohorts (L)

Save any report, compose dashboards from saved reports, and save people filters as cohorts usable in any report.

### P7 · Reports as files (S)

Saved insights and dashboards export to and import from JSON so they can live in a repository and be created by an agent.

### P8 · Export (S)

Events as CSV or NDJSON, streamed, from the dashboard, the API and the CLI.

### P9 · Alerts and summaries (M)

Webhooks on event match, threshold alerts delivered by webhook or email, and scheduled email summaries when SMTP is configured.

### P10 · Importers (M)

Import from Plausible, Umami, Google Analytics 4 and PostHog exports, and a Segment-compatible batch endpoint so existing instrumentation can point at Birdwatch unchanged.

## Feature flags

### FL1 · Flags core (M, review)

- **Storage:** key, enabled, rollout percentage, variants and targeting rules against person traits.
- **Evaluation:** deterministic, from a hash of the flag key and the person's ID, so nothing is stored per person.
- **Endpoint:** `POST /api/flags` with the write key returns every flag's value for a person.
- **Dashboard:** a Flags page with a toggle, rollout slider, variant weights, rules, and a change history showing whether the admin or a named token made each change.

### FL2 · Flags in the SDKs (L)

`isEnabled`, `variant` and `onFlagsChange` in all five SDKs. Client SDKs cache the last response on disk and accept bootstrapped values. The Node SDK evaluates locally from definitions polled with a secret server key. The first check per session captures an exposure event.

### FL3 · Experiments (M)

A multi-variant flag plus a goal (W8). The report shows conversion per variant from exposure events with a confidence interval, using one well-explained method.

## Operate

### O1 · Admin login (M, review)

A login page and a server-side session cookie replace the browser's password prompt. The password is stored hashed. Failed logins are throttled per address. The password header remains for API use.

### O2 · Project management (M, review)

Rename, delete with typed confirmation, rotate the write key with an overlap period, set retention and time zone, restrict capture to listed origins, and remove the demo project.

### O3 · Share links (M, review)

A read-only link per dashboard, optionally password-protected, and an embeddable view.

### O5 · Published numbers (S)

The 10M benchmark results and the machine they ran on, in the README and on the website, updated by the nightly run.

---

# Later

Postponed, not rejected.

| Item | Note |
| --- | --- |
| Session replay | Web only, using an existing open-source recorder, recordings stored as files beside the database, short retention and a disk quota. Needs sessions, deletion and the unload path first |
| Multiple users, roles, audit log, single sign-on | Until then: one admin, scoped tokens, share links |
| OAuth on the instance, a "Connect an assistant" page, ChatGPT and Grok guides | All three connect through remote MCP, so these are channels for A5. Directory listings expect one public URL per product, which does not fit self-hosting; custom connectors do |
| Group-commit writer, HTTP keep-alive tuning, built-in ingest rate limit | Only if the benchmark calls for them |
| Country lookup | From an optional local database file supplied by the operator |
| More deployment guides | Beyond the two in R7 |

# Order

```text
F1 → F2 → F4 → F5
        ↘ G1 → G2 → G3, G4, G5, G6, G7 → G8, G9, G10 → G11
F3 runs against the Python reference first, then gates G11
S1 → S2 … S6 → S7          (after F1)
R1 → R2 → R3, R6, R7       (R2 after G11; R7 after O4; R4 after R3)
0.5 released
A1, A2, A3 → A5, A6 → A4, A7, A8, A9, A10
W1 → W2, W3, W4, W5 → W6, W7, W8
P1 → P2
0.8 released
P3 … P10, FL1 → FL2 → FL3, O1, O2, O3, O5
1.0 released
```

At most three agents work at once, each in a different area.
