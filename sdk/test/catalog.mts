import {
  createBrowserClient,
  createServerClient,
  type Receipt,
} from "@birdwatch/sdk";
interface Catalog {
  sign_up: { plan: "free" | "pro"; seats?: number };
  help_opened: {};
}
const options = { host: "http://localhost:8123", writeKey: "project" };
const browser = createBrowserClient<Catalog>(options);
const receipt: Promise<Receipt> = browser.capture("sign_up", { plan: "pro" });
void receipt;
browser.capture("help_opened");
browser.page();
const server = createServerClient<Catalog>(options);
server.capture({
  event: "sign_up",
  distinctId: "alice",
  properties: { plan: "free" },
  id: "transaction-1",
});
server.capture({ event: "help_opened", distinctId: "bob" });
// @ts-expect-error Event name is outside the catalog.
browser.capture("signup");
// @ts-expect-error sign_up requires properties.
browser.capture("sign_up");
// @ts-expect-error Unsupported plan.
browser.capture("sign_up", { plan: "trial" });
// @ts-expect-error Server captures always require identity.
server.capture({ event: "help_opened" });
// @ts-expect-error Typed properties are required on the server too.
server.capture({ event: "sign_up", distinctId: "alice" });
// @ts-expect-error Unknown event.
server.capture({ event: "unknown", distinctId: "alice" });
// @ts-expect-error No mutable current user on a shared server client.
server.identify("alice");
