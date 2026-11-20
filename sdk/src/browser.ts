import { checkTraits, invalid, newId, stringField } from "./event.js";
import { DeliveryQueue } from "./queue.js";
import type {
  BrowserClient,
  BrowserOptions,
  CatalogShape,
  EventCatalog,
  Properties,
} from "./types.js";

export function createBrowserClient<C extends CatalogShape<C> = EventCatalog>(
  options: BrowserOptions
): BrowserClient<C> {
  if (typeof window === "undefined" || typeof document === "undefined")
    invalid(
      "createBrowserClient requires a browser."
    );
  const queue = new DeliveryQueue(options, true);
  const persistence = options.persistence ?? "localStorage";
  if (!["memory", "localStorage"].includes(persistence))
    invalid("Unknown identity persistence mode.");
  const key = "birdwatch.id." + options.writeKey;
  let storage: Storage | undefined;
  if (persistence === "localStorage") {
    try {
      storage = window.localStorage;
    } catch {
      /* Sandboxed frames may deny access. */
    }
  }
  function readStored(): string | undefined {
    try {
      const id = storage?.getItem(key);
      if (id) return stringField(id, "distinctId", 256);
    } catch {
      /* Missing or invalid stored identities start a new anonymous session. */
    }
  }
  let person = readStored() ?? newId();
  function identify(id: string, traits?: Properties) {
    checkTraits(traits);
    person = stringField(id, "distinctId", 256);
    try {
      storage?.setItem(key, person);
    } catch {
      /* Continue with an in-memory identity. */
    }
  }
  identify(person);
  function onStorage(event: StorageEvent) {
    if (
      storage &&
      event.storageArea === storage &&
      (event.key === key || event.key === null)
    ) {
      const stored = readStored();
      if (stored) person = stored;
      else identify(newId());
    }
  }
  function flushPage() {
    // Individual capture promises still report any failure to their caller.
    queue.unload();
  }
  function onVisibility() {
    if (document.visibilityState === "hidden") flushPage();
  }
  window.addEventListener("pagehide", flushPage);
  if (storage) window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibility);
  return {
    identify,
    reset() {
      identify(newId());
    },
    capture(event, ...args) {
      return queue.capture(event, person, args[0], args[1]);
    },
    flush: () => queue.flush(),
    onError: queue.onError,
    close() {
      window.removeEventListener("pagehide", flushPage);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      return queue.close();
    },
  };
}
