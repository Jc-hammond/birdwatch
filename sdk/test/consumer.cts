import sdk = require("@birdwatch/sdk");
const client = sdk.createServerClient({
  host: "http://127.0.0.1:8123",
  writeKey: "test",
});
client.capture({
  event: "hello",
  distinctId: "server",
  properties: { items: [1, null, true] },
});
client.capture({
  event: "hello",
  distinctId: "server",
  // @ts-expect-error Properties must be JSON-compatible.
  properties: { callback: () => {} },
});
