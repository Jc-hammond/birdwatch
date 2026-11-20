import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Code2,
  Copy,
  Download,
  Package,
  FlaskConical,
  Plus,
  Terminal,
} from "lucide-react";
import versions from "./generated/sdk-versions.json";
import { api, DataState, Dialog, useData } from "./lib";

function Snippet({ code }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 2000);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }
  return (
    <div className="snippet">
      <button className="secondary small" onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{code}</pre>
      {failed && <p>Automatic copy failed. Select and copy the code below.</p>}
    </div>
  );
}
export function NewProject({ close, created }) {
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const p = await api("/api/projects", { name: name.trim() });
      created({ id: p.id, name: name.trim(), sample_as_of: null });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="Create project" close={close}>
      <p>
        Each project has its own write key and reports.
      </p>
      <form onSubmit={submit}>
        <label className="field">
          Project name
          <input
            autoFocus
            maxLength={60}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My app"
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
const methods = [
  ["Script tag", Code2],
  ["Browser SDK", Package],
  ["Node.js", Terminal],
  ["React Native", Package],
  ["Expo Exact", Code2],
  ["Swift", Package],
  ["Android", Package],
  ["HTTP API", Terminal],
];
function scriptTag(key) {
  return '<script src="' + location.origin + '/birdwatch.js" data-key="' + key + '" data-pageview="true"></script>';
}
export function FirstEvent({ project }) {
  const setup = useData("/api/projects/" + project.id + "/setup");
  if (setup.error || !setup.data) return <DataState state={setup} />;
  return (
    <section className="card setup-panel">
      <h2>Waiting for your first event</h2>
      <p>Add this script to your site and open a page to record a page view.</p>
      <Snippet code={scriptTag(setup.data.write_key)} />
    </section>
  );
}
export function Setup({ project, create, go, selected }) {
  const state = useData("/api/projects/" + project.id + "/setup");
  const tab = methods.some(([name]) => name === selected) ? selected : "Script tag";
  const [result, setResult] = useState(null),
    [sending, setSending] = useState(false);
  if (state.error || !state.data) return <DataState state={state} />;
  const p = state.data;
  if (p.sample_as_of)
    return (
      <section className="card setup-panel">
        <span className="feature-icon">
          <FlaskConical size={23} />
        </span>
        <h2>Start collecting your own events</h2>
        <p>
          This demo uses read-only sample data. Create a project to get a write
          key and send your own events.
        </p>
        <button className="primary" onClick={create}>
          <Plus size={16} /> Create project
        </button>
      </section>
    );
  const origin = location.origin;
  const tag = scriptTag(p.write_key);
  const curl =
    "curl -X POST '" +
    origin +
    "/api/capture' \\\n  -H 'Content-Type: application/json' \\\n  -d '" +
    JSON.stringify(
      {
        api_key: p.write_key,
        event: "sign_up",
        distinct_id: "user_42",
        properties: { plan: "free" },
      },
      null,
      2
    ) +
    "'";
  const archive = "birdwatch-sdk-" + versions.web + ".tgz";
  const packageTab = tab === "Browser SDK" || tab === "Node.js";
  const browserSdk = `import { createBrowserClient } from "@birdwatch/sdk";

type Events = { sign_up: { plan: "free" | "pro" } };
const analytics = createBrowserClient<Events>({
  host: ${JSON.stringify(origin)},
  writeKey: ${JSON.stringify(p.write_key)},
});

await analytics.page();
analytics.identify("user_42");
await analytics.capture("sign_up", { plan: "free" });`;
  const nodeSdk = `import { createServerClient } from "@birdwatch/sdk";

const analytics = createServerClient({
  host: ${JSON.stringify(origin)},
  writeKey: ${JSON.stringify(p.write_key)},
});

try {
  await analytics.capture({
    event: "sign_up",
    distinctId: "user_42",
    properties: { plan: "free" },
  });
} finally {
  await analytics.shutdown();
}`;
  const clientConfig = `host: ${JSON.stringify(
    origin
  )}, writeKey: ${JSON.stringify(p.write_key)}`;
  const androidHost = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(androidHost.hostname)) {
    androidHost.hostname = "10.0.2.2";
  }
  const native = {
    Android: {
      file: `birdwatch-android-${versions.android}.aar`,
      install: `dependencies {\n    implementation(files("libs/birdwatch-android-${versions.android}.aar"))\n}`,
      detail: "Save the AAR in app/libs and add the dependency to app/build.gradle.kts. The standard emulator reaches your computer at 10.0.2.2. For a physical device, use a reachable HTTPS collector.",
      example: `import dev.birdwatch.sdk.Birdwatch
import dev.birdwatch.sdk.Event

val client = Birdwatch.open(applicationContext, ${JSON.stringify(androidHost.origin)}, ${JSON.stringify(p.write_key)})
client.identify("user-42")
client.enqueue(Event("checkout_completed", mapOf("orderId" to "order-123"), "checkout:order-123"))`,
    },
    "React Native": {
      file: `birdwatch-react-native-${versions.reactNative}.tgz`,
      install:
        `npx expo install expo-crypto @react-native-async-storage/async-storage\nnpm install ./birdwatch-react-native-${versions.reactNative}.tgz`,
      detail:
        "Initialize once at startup. Await enqueue to save an event even while offline.",
      example: `import { createReactNativeClient } from "@birdwatch/react-native";
import { randomUUID } from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";

const client = await createReactNativeClient({
  ${clientConfig},
  storage: AsyncStorage, randomUUID,
});
await client.identify("user-42");
await client.enqueue("checkout_completed", { orderId: "order-123" }, { id: "checkout:order-123" });`,
    },
    "Expo Exact": {
      file: `birdwatch-exact-${versions.exact}.tgz`,
      install: `npm install ./birdwatch-exact-${versions.exact}.tgz`,
      detail:
        "The download includes a Contract app that commits locally, replays at launch, and retries while open. Replace its host and write key with these values.",
      example: `import { createExactClient } from "@birdwatch/exact";

export const grants = ${JSON.stringify("net.fetch " + origin + "\nsqlite.open app:/data/birdwatch.sqlite")};
const client = createExactClient({ ${clientConfig}, fetch });`,
    },
    Swift: {
      file: `birdwatch-swift-${versions.swift}.zip`,
      detail:
        "Unzip the package, choose Add Local in Xcode’s package dependencies, then add the Birdwatch product to your target.",
      example: `import Foundation
import Birdwatch

let client = try await BirdwatchClient(
    host: URL(string: ${JSON.stringify(origin)})!,
    writeKey: ${JSON.stringify(p.write_key)}
)
try await client.identify("user-42")
try await client.enqueue("checkout_completed", properties: ["orderId": "order-123"], id: "checkout:order-123")`,
    },
  }[tab];
  async function test() {
    setResult(null);
    setSending(true);
    try {
      const ack = await api("/api/capture", {
        api_key: p.write_key,
        distinct_id: "setup_test",
        event: "source_connected",
        properties: { source: "setup" },
      });
      if (ack?.accepted !== 1 || ack.duplicates !== 0 || (ack.rejected !== undefined &&
          (!Array.isArray(ack.rejected) || ack.rejected.length))) {
        throw new Error(typeof ack?.error === "string" ? ack.error : "Birdwatch did not acknowledge the test event.");
      }
      setResult({ ok: true, message: "Birdwatch received your test event." });
    } catch (e) {
      setResult({ ok: false, message: e.message });
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="setup-layout">
      <section className="card setup-panel">
        <h2>Connect a source</h2>
        <p>Choose how to send events to {p.name}. Each example includes this project’s write key.</p>
        <div className="tabs" role="group" aria-label="Integration method">
          {methods.map(([name, Icon]) => (
            <button
              key={name}
              aria-pressed={name === tab}
              className={name === tab ? "active" : ""}
              onClick={() => go("Setup", { tab: name })}
            >
              <Icon size={16} /> {name}
            </button>
          ))}
        </div>
        {native ? (
          <>
            <h3>Install the {tab} SDK</h3>
            <a
              className="secondary small sdk-download"
              href={"/assets/" + native.file}
              download={native.file}
            >
              <Download size={15} /> Download {tab} SDK
            </a>
            {native.install && <Snippet code={native.install} />}
            <p>{native.detail}</p>
            <Snippet key={tab} code={native.example} />
          </>
        ) : packageTab ? (
          <>
            <h3>Install the SDK</h3>
            <p>
              Download the package to your application directory and install it
              with npm.
            </p>
            <a
              className="secondary small sdk-download"
              href={"/assets/" + archive}
              download={archive}
            >
              <Download size={15} /> Download SDK · v{versions.web}
            </a>
            <Snippet code={"npm install ./" + archive} />
            <h3>
              {tab === "Node.js"
                ? "Capture from Node.js"
                : "Capture from TypeScript"}
            </h3>
            <p>
              {tab === "Node.js"
                ? "Reuse one client across requests. Include a user ID with each event and call shutdown() before your process exits."
                : "Define your event names and properties so TypeScript can check each capture call."}
            </p>
            <Snippet
              key={tab}
              code={tab === "Node.js" ? nodeSdk : browserSdk}
            />
          </>
        ) : (
          <>
            <h3>
              {tab === "Script tag"
                ? "Add the script to your site"
                : "Send an event with curl"}
            </h3>
            <p>
              {tab === "Script tag"
                ? "Paste this script into each page you want to track. It records a page view each time the page loads."
                : "Run this command in your terminal. Use the same user ID for each person’s events."}
            </p>
            <Snippet key={tab} code={tab === "Script tag" ? tag : curl} />
            {tab === "Script tag" && (
              <>
                <h3>Capture a custom event</h3>
                <p>
                  Use your app’s user ID after sign-in so future events appear under that ID.
                </p>
                <Snippet
                  code={
                    'birdwatch.identify("user_42");\nawait birdwatch.capture("sign_up", { plan: "free" });'
                  }
                />
              </>
            )}
          </>
        )}
        <p className="footnote">
          Use a Birdwatch URL your app can reach. On a phone, localhost
          points to the phone itself.
        </p>
      </section>
      <section className="card setup-panel">
        <h2>Test this project</h2>
        <p>
          Send a test event from this dashboard, then open Events to find it.
        </p>
        <button className="secondary" disabled={sending} onClick={test}>
          <FlaskConical size={16} />
          {sending ? "Sending…" : "Send test event"}
        </button>
        {result && (
          <div className={result.ok ? "test-result" : "notice error"} role={result.ok ? "status" : "alert"}>
            {result.message}{" "}
            {result.ok && <button className="text-link" onClick={() => go("Events")}>
              View events <ArrowRight size={14} />
            </button>}
          </div>
        )}
      </section>
    </div>
  );
}
