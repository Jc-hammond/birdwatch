import { invalid } from "../sdk/src/event.js";

// Exact and React Native both run on hosts with partial WHATWG URL support.
export function captureEndpoint(host: string): string {
  if (
    typeof host !== "string" ||
    !/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^?#\\\s]*)?$/i.test(
      host
    )
  ) {
    invalid(
      "host must be an HTTP(S) URL without credentials, a query, or a fragment."
    );
  }
  return host.replace(/\/+$/, "") + "/api/capture";
}
