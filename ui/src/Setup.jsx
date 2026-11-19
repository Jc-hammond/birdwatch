import React, { useState } from "react";
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
import sdkPackage from "../../sdk/package.json";
import { api, DataState, Dialog, useData } from "./lib";

function Snippet({ code }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setFailed(false);
    } catch {
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
      {failed && <p>Select the snippet to copy it manually.</p>}
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
        Give your event stream a name. Each project has its own write key and
        dashboard.
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
export function Setup({ project, create, go }) {
  const state = useData("/api/projects/" + project.id + "/setup");
  const [tab, setTab] = useState("Script tag"),
    [result, setResult] = useState(""),
    [sending, setSending] = useState(false);
  if (!state.data) return <DataState state={state} />;
  const p = state.data;
  if (p.sample_as_of)
    return (
      <section className="card setup-panel">
        <span className="feature-icon">
          <FlaskConical size={23} />
        </span>
        <h2>Connect your own project</h2>
        <p>
          You’re exploring a read-only sample captured on{" "}
          {new Date(p.sample_as_of).toLocaleDateString()}. Create a project to
          get a write key and start collecting your own events.
        </p>
        <button className="primary" onClick={create}>
          <Plus size={16} /> Create project
        </button>
      </section>
    );
  const origin = location.origin;
  const tag =
    '<script src="' +
    origin +
    '/birdwatch.js" data-key="' +
    p.write_key +
    '" data-pageview="true"></script>';
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
  const archive = "birdwatch-sdk-" + sdkPackage.version + ".tgz";
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
      file: "birdwatch-android-0.2.0.aar",
      install: 'dependencies {\n    implementation(files("libs/birdwatch-android-0.2.0.aar"))\n}',
      detail: "Save the AAR in app/libs and add the dependency to app/build.gradle.kts. The standard emulator reaches your computer at 10.0.2.2. For a physical device, use a reachable HTTPS collector.",
      example: `import dev.birdwatch.sdk.Birdwatch
import dev.birdwatch.sdk.Event

val client = Birdwatch.open(applicationContext, ${JSON.stringify(androidHost.origin)}, ${JSON.stringify(p.write_key)})
client.identify("user-42")
client.enqueue(Event("checkout_completed", mapOf("orderId" to "order-123"), "checkout:order-123"))`,
    },
    "React Native": {
      file: "birdwatch-react-native-0.2.0.tgz",
      install:
        "npx expo install expo-crypto @react-native-async-storage/async-storage\nnpm install ./birdwatch-react-native-0.2.0.tgz",
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
      file: "birdwatch-exact-0.2.0.tgz",
      install: "npm install ./birdwatch-exact-0.2.0.tgz",
      detail:
        "The download includes a Contract app that commits locally, replays at launch, and retries while open. Replace its host and write key with these values.",
      example: `import { createExactClient } from "@birdwatch/exact";

export const grants = ${JSON.stringify("net.fetch " + origin + "\nsqlite.open app:/data/birdwatch.sqlite")};
const client = createExactClient({ ${clientConfig}, fetch });`,
    },
    Swift: {
      file: "birdwatch-swift-0.2.0.zip",
      detail:
        "Unzip the package, choose Add Local in Xcode’s package dependencies, then add the Birdwatch product to your target.",
      example: `import Foundation
import Birdwatch

let client = try BirdwatchClient(
    host: URL(string: ${JSON.stringify(origin)})!,
    writeKey: ${JSON.stringify(p.write_key)}
)
try await client.identify("user-42")
try await client.enqueue("checkout_completed", properties: ["orderId": "order-123"], id: "checkout:order-123")`,
    },
  }[tab];
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
  async function test() {
    setSending(true);
    try {
      await api("/api/capture", {
        api_key: p.write_key,
        distinct_id: "setup_test",
        event: "source_connected",
        properties: { source: "setup" },
      });
      setResult("Test event received.");
    } catch (e) {
      setResult(e.message);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="setup-layout">
      <section className="card setup-panel">
        <h2>Connect a source</h2>
        <p>Send events to {p.name} from your app or the HTTP API.</p>
        <div className="tabs" role="group" aria-label="Integration method">
          {methods.map(([name, Icon]) => (
            <button
              key={name}
              aria-pressed={name === tab}
              className={name === tab ? "active" : ""}
              onClick={() => setTab(name)}
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
              <Download size={15} /> Download SDK · v{sdkPackage.version}
            </a>
            <Snippet code={"npm install ./" + archive} />
            <h3>
              {tab === "Node.js"
                ? "Capture from Node.js"
                : "Capture from TypeScript"}
            </h3>
            <p>
              {tab === "Node.js"
                ? "Reuse one client across requests. Pass a distinct ID with each event and drain the client when your process exits."
                : "Define your events and properties once to get type checking at each capture call."}
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
                ? "Install the browser client"
                : "Send an event with curl"}
            </h3>
            <p>
              {tab === "Script tag"
                ? "Place this script in the page you want to track. It captures one page_view on load."
                : "Run this request from your terminal. Use a stable distinct_id for each person."}
            </p>
            <Snippet key={tab} code={tab === "Script tag" ? tag : curl} />
            {tab === "Script tag" && (
              <>
                <h3>Capture a custom event</h3>
                <p>
                  After the script loads, identify a person and record an
                  action.
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
          Use a collector URL reachable from your app. On a physical device,
          localhost points to that device.
        </p>
      </section>
      <section className="card setup-panel">
        <h2>Check ingestion</h2>
        <p>
          Send a real test event to this project to confirm capture is working.
        </p>
        <button className="secondary" disabled={sending} onClick={test}>
          <FlaskConical size={16} />
          {sending ? "Sending…" : "Send test event"}
        </button>
        {result && (
          <div className="test-result" role="status">
            {result}{" "}
            <button className="text-link" onClick={() => go("Events")}>
              View events <ArrowRight size={14} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
