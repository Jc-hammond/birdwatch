# Birdwatch

Birdwatch is open-source product analytics you run on your own server. Track actions like sign-ups and checkouts, inspect the events behind a user’s activity, and see how many people go from one action to the next.

One Python process serves the dashboard, browser script, and HTTP API. Events live in a SQLite database on your machine or server.

[Try the browser demo](https://birdwatch.connor-hammond.chatgpt.site/#demo)

![Birdwatch dashboard showing daily event counts, top events, and recent activity](docs/overview.jpg)

## Run locally

Build the source checkout with `make build` once using the tools listed under Develop. Start the Python reference server from the project directory.

```sh
python3 server.py
```

Open [Birdwatch on localhost](http://127.0.0.1:8123).

1. Explore the read-only demo project, then select **Connect source** → **Create project**.
2. On **Setup**, select **Send test event** to check that the server can receive events.
3. Select **View events** to find the `source_connected` event. Return to **Setup** for a code example with your project’s write key.

Birdwatch saves data to `data/birdwatch.sqlite3` by default. To start with one empty project, pass `--no-demo` when initializing a new database.

## Capture events

| Where events come from | Where to start |
| --- | --- |
| Website with a script tag | **Setup** → **Script tag** |
| Browser app or Node.js 20+ | [JavaScript and TypeScript SDK](sdk/README.md) |
| React Native, Expo Exact, Swift, or Android | [Mobile and Exact SDKs](sdks/README.md) |
| Backend or another runtime | **Setup** → **HTTP API** |

### Website script

Copy the snippet from **Setup** into each page you want to track. Use a Birdwatch URL reachable from the visitor’s browser.

```html
<script src="http://127.0.0.1:8123/birdwatch.js"
        data-key="YOUR_PROJECT_WRITE_KEY" data-pageview="true"></script>
```

With `data-pageview="true"`, the script records the URL path once per full page load. In a single-page app, call `birdwatch.page()` after a route change. The script keeps an anonymous ID in local storage for each project.

Call `identify()` after sign-in to associate future events with your app’s user ID. Call `reset()` at sign-out to start a new anonymous identity.

```js
birdwatch.identify("user_42");
await birdwatch.capture("sign_up", { plan: "free" });
```

### HTTP API

Send a JSON request to `POST /api/capture`. Use a stable `distinct_id` to group events from the same person.

```sh
curl http://127.0.0.1:8123/api/capture \
  -H 'Content-Type: application/json' \
  -d '{
    "api_key": "YOUR_PROJECT_WRITE_KEY",
    "event": "sign_up",
    "distinct_id": "user_42",
    "properties": {"plan": "free"},
    "uuid": "signup-user42-1"
  }'
```

A new event returns `{"accepted":1,"duplicates":0}`. Reuse the same optional `uuid` when retrying that event so Birdwatch counts it once. The optional `timestamp` accepts ISO 8601 with a time zone and defaults to when the server receives the event.

To send up to 100 events in one request, use a top-level `api_key` and a `batch` array of event objects. If any item is invalid, Birdwatch rejects the whole batch. The request limit is 1 MiB and the JSON-encoded properties limit is 32 KiB per event.

## Read the reports

- **Overview** shows event counts, active users, page views, and events per user. Select a top event to see its matching rows. Hover over a day’s bars or focus them with the keyboard to see its counts.
- **Events** lets you search by event name or person ID and open an event to see its timestamp and properties.
- **People** lists the IDs active in the selected period, along with their event counts and first and last activity. Select an ID to see its events.
- **Funnels** shows how many people complete a second event after the first within the selected period. Each ID counts once per step. You can select the same event for both steps to measure repeat use. Events with matching timestamps use insertion order.

Reports use UTC calendar days. Overview compares the selected period with the same elapsed span one period earlier. A dash marks a previous value of zero. Each distinct ID counts as one active user, and both `page_view` and `$pageview` count as page views. Live reports refresh every five seconds. Older pages in the Events list stay fixed while you browse. The demo uses a fixed date.

## Docker Compose

Run `make build` to prepare the dashboard and SDK downloads for the image. With Docker and its Compose plugin installed, run these commands from the project directory.

```sh
export BIRDWATCH_PASSWORD="$(openssl rand -hex 24)"
docker compose up --build -d
```

Open [Birdwatch on localhost](http://127.0.0.1:8123) and sign in as `admin` with the password you set. Run `printenv BIRDWATCH_PASSWORD` in the same shell to retrieve it. Keep the variable set for future Compose commands or save it in a local `.env` file.

Compose binds the published port to loopback and stores the database in the `events` volume. Use `docker compose down` to stop the service and keep its data. If you also run the Python server directly, give the two instances different ports. Each uses its own database by default.

## Hosting and storage

| Setting | Default | Purpose |
| --- | --- | --- |
| `BIRDWATCH_HOST` or `--host` | `127.0.0.1` | IPv4 address to listen on |
| `BIRDWATCH_PORT` or `--port` | `8123` | HTTP port |
| `BIRDWATCH_DB` or `--db` | `data/birdwatch.sqlite3` | Database path, relative to `server.py` by default |
| `BIRDWATCH_PASSWORD` | unset | HTTP Basic password for the dashboard user `admin` |

Set a dashboard password before exposing Birdwatch to a network. Serve it over HTTPS through a reverse proxy and preserve the original `Host` header. Use the public HTTPS URL in your app’s integration. If your site uses Content Security Policy, allow the Birdwatch origin in `script-src` and `connect-src`.

A project write key lets clients send events. The dashboard administrator can read every project. For a public capture endpoint, apply request and traffic limits at your reverse proxy. Birdwatch is designed for one operator on one host.

With the Go binary, run `build/birdwatch backup --db data/birdwatch.sqlite3 snapshot.sqlite3`. The source defaults to `BIRDWATCH_DB` or `data/birdwatch.sqlite3`. Choose a new destination path for each copy. The command copies committed data, including the write-ahead log, while the server stays online.

Start the Go server with `--backup-dir ./backups` or set `BIRDWATCH_BACKUP_DIR` to take a backup on startup and each UTC day. It keeps the newest seven dated backups in that directory. To restore, stop all processes using the live database, move the existing database and any matching `-wal`, `-shm` or `-journal` files to a separate location, copy the backup to the configured database path with owner-only permissions, then restart the server.

For the Python reference, use SQLite’s online backup command to copy a running database. For Compose, make an online backup inside the container or stop the service before taking a volume snapshot.

```sh
sqlite3 data/birdwatch.sqlite3 ".backup 'birdwatch-backup.sqlite3'"
```

## Develop

Install Make, Go 1.26+, Node.js 24 with npm, Python 3.9+ with SQLite 3.25+, JDK 17, Android SDK Platform 35, tar and zip. Set `JAVA_HOME` and `ANDROID_HOME` to their installation paths. The Swift tests require macOS with the Swift 5.9+ toolchain.

```sh
make build    # build SDK archives, dashboard, and build/birdwatch
make test     # build and run the server, JavaScript and native checks
make lint     # Go vet, SDK types and whitespace
```

The npm workspace installs its pinned tools from the root lockfile. The dashboard and offline downloads are generated into `static/`. The Go binary embeds the dashboard and its SDK downloads, so it can run from any directory. If invoking `go build` directly, run `make dashboard` first. The Python reference provides the full analytics API during the port.

Birdwatch is available under the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.txt) for bundled dependencies.
