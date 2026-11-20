import { newId, stringField } from "./event.js";
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
  let person = newId();
  return {
    identify(id) { person = stringField(id, "distinctId", 256); },
    reset() { person = newId(); },
    capture(name, ...[properties, options]) {
      return queue.capture(name, options?.distinctId ?? person, properties, options);
    },
    flush: () => queue.flush(),
    close: () => queue.close(),
    onError: queue.onError,
  };
}
