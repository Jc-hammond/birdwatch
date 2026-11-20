import sdk = require("@birdwatch/sdk");
const client = sdk.createServerClient({
  host: "http://127.0.0.1:8123",
  writeKey: "test",
});
client.capture("hello", { items: [1, null, true] }, { distinctId: "server" });
// @ts-expect-error Properties must be JSON-compatible.
client.capture("hello", { callback: () => {} });
