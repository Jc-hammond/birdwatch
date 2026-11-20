import {
  createBrowserClient,
  createServerClient,
} from "@birdwatch/sdk";
interface Catalog {
  sign_up: { plan: "free" | "pro"; seats?: number };
  help_opened: {};
}
const options = { host: "http://localhost:8123", writeKey: "project" };
const browser = createBrowserClient<Catalog>(options);
const receipt: Promise<string> = browser.capture("sign_up", { plan: "pro" });
void receipt;
browser.capture("help_opened");
browser.onError(() => {});
const server = createServerClient<Catalog>(options);
server.capture("sign_up", { plan: "free" }, { distinctId: "alice", id: "transaction-1" });
server.capture("help_opened", {}, { distinctId: "bob" });
// @ts-expect-error Event name is outside the catalog.
browser.capture("signup");
// @ts-expect-error sign_up requires properties.
browser.capture("sign_up");
// @ts-expect-error Unsupported plan.
browser.capture("sign_up", { plan: "trial" });
// @ts-expect-error Typed properties are required on the server too.
server.capture("sign_up");
// @ts-expect-error Unknown event.
server.capture("unknown");
server.identify("alice");
