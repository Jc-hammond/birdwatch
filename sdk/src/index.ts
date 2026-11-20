import { DeliveryQueue } from "./queue.js";
import type {
  CatalogShape,
  ClientOptions,
  EventCatalog,
  ServerClient,
} from "./types.js";

export { createBrowserClient } from "./browser.js";
export { BirdwatchError } from "./types.js";
export type {
  BatchCounts,
  BrowserClient,
  BrowserOptions,
  CaptureArgs,
  CaptureOptions,
  ClientOptions,
  ErrorCode,
  EventCatalog,
  EventName,
  Lifecycle,
  Json,
  Properties,
  Receipt,
  ServerClient,
  ServerEvent,
} from "./types.js";

export function createServerClient<C extends CatalogShape<C> = EventCatalog>(
  options: ClientOptions
): ServerClient<C> {
  const queue = new DeliveryQueue(options);
  return {
    capture(input) {
      return queue.capture(
        input?.event,
        input?.distinctId,
        input?.properties,
        input ?? undefined
      );
    },
    flush: () => queue.flush(),
    shutdown: () => queue.shutdown(),
  };
}
