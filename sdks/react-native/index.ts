import AsyncStorage from "@react-native-async-storage/async-storage";
import { Outbox, type IdentityStorage, type WireEvent } from "./outbox.js";
export type { IdentityStorage } from "./outbox.js";
import { captureEndpoint } from "../endpoint.js";
import { AppState } from "react-native";
import {
  BirdwatchError,
  DeliveryQueue,
  encodeEvent,
  invalid,
  stringField,
  utf8Length,
  type ClientOptions,
  type CatalogShape,
  type EventCatalog,
  type EventName,
  type CaptureArgs,
  type CaptureOptions,
  type Lifecycle,
  type Receipt,
} from "@birdwatch/sdk/internal";
export { BirdwatchError };
export type {
  Receipt,
  CaptureOptions,
  Properties,
} from "@birdwatch/sdk/internal";

export interface NativeOptions extends ClientOptions {
  /** Defaults to AsyncStorage. Pass null for memory-only collection. */
  storage?: IdentityStorage | null;
  /** Optionally notify the SDK immediately when network connectivity returns. */
  subscribeConnectivity?: (listener: (online: boolean) => void) => () => void;
  /** For example, Expo Crypto's randomUUID on hosts without Web Crypto. */
  randomUUID?: () => string;
}
export interface NativeClient<C extends CatalogShape<C>> extends Lifecycle {
  readonly distinctId: string;
  identify(distinctId: string): Promise<void>;
  reset(): Promise<void>;
  capture<N extends EventName<C>>(
    event: N,
    ...args: CaptureArgs<C[N]>
  ): Promise<Receipt>;
  /** Resolve on local commit, even when the collector is unreachable. */
  enqueue<N extends EventName<C>>(
    event: N,
    ...args: CaptureArgs<C[N]>
  ): Promise<{ id: string }>;
  screen(name: string, options?: CaptureOptions): Promise<Receipt>;
}
export async function createReactNativeClient<
  C extends CatalogShape<C> = EventCatalog
>(options: NativeOptions): Promise<NativeClient<C>> {
  const queue = new DeliveryQueue(options, captureEndpoint);
  const storage =
    options.storage === undefined ? AsyncStorage : options.storage;
  const scope = JSON.stringify([
    options.host.replace(/\/+$/, ""),
    options.writeKey,
  ]);
  const outbox = new Outbox(
    storage,
    "birdwatch:outbox:v1:" + scope,
    options.maxQueueSize ?? 1000
  );
  const key = "birdwatch:identity:" + scope;
  const id = () => {
    const raw = options.randomUUID
      ? options.randomUUID()
      : globalThis.crypto?.randomUUID?.();
    if (!raw)
      invalid("Pass a randomUUID function, such as Expo Crypto.randomUUID.");
    return stringField(raw, "generated ID", 128);
  };
  const stored = await storage?.getItem(key);
  let person =
    stored == null ? id() : stringField(stored, "stored identity", 256);
  if (stored == null) await storage?.setItem(key, person);
  let write: Promise<void> = Promise.resolve();
  let closed = false;
  async function identify(value: string) {
    if (closed) throw new Error("The client has been shut down.");
    person = stringField(value, "distinctId", 256);
    if (storage)
      write = write.catch(() => {}).then(() => storage.setItem(key, value));
    await write;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1000;
  let retryAfter = 0;
  let replay: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const active = new Map<string, Promise<Receipt>>();

  function schedule(ms: number) {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => {});
    }, ms);
  }
  function retry() {
    schedule(Math.max(retryMs, Math.min(86400000, retryAfter - Date.now())));
    retryMs = Math.min(60000, retryMs * 2);
  }
  function deliver(row: WireEvent): Promise<Receipt> {
    const pending = active.get(row.uuid);
    if (pending) return pending;
    const task = (async () => {
      try {
        if (Date.now() < retryAfter)
          throw new BirdwatchError(
            "http",
            "Collector requested a retry delay.",
            429
          );
        const json = JSON.stringify(row);
        const receipt = await queue.captureEncoded({
          id: row.uuid,
          json,
          bytes: utf8Length(json),
        });
        await outbox.remove(row.uuid);
        return receipt;
      } catch (error) {
        // Only a definitive per-event input rejection is terminal.
        if (
          error instanceof BirdwatchError &&
          (error.status === 400 || error.status === 413)
        ) {
          await outbox.remove(row.uuid);
        } else {
          if (
            error instanceof BirdwatchError &&
            "retryAfter" in error &&
            typeof error.retryAfter === "number"
          )
            retryAfter = Math.max(retryAfter, Date.now() + error.retryAfter);
          retry();
        }
        throw error;
      } finally {
        active.delete(row.uuid);
      }
    })();
    active.set(row.uuid, task);
    return task;
  }
  function flush(): Promise<void> {
    if (replay) return replay.then(flush);
    const run = async () => {
      const rows = await outbox.list();
      const size = options.batchSize ?? 20;
      for (let i = 0; i < rows.length; i += size) {
        const tasks = rows.slice(i, i + size).map(deliver);
        void queue.flush().catch(() => {});
        const results = await Promise.allSettled(tasks);
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      retryMs = 1000;
    };
    replay = run()
      .catch((err) => {
        retry();
        throw err;
      })
      .finally(() => {
        replay = undefined;
      });
    return replay;
  }
  function wake() {
    if (closed) return;
    clearTimeout(timer);
    timer = undefined;
    void flush().catch(() => {});
  }
  async function stage(
    event: string,
    props: unknown,
    capture?: CaptureOptions
  ) {
    if (closed)
      throw new BirdwatchError("closed", "The client has been shut down.");
    const encoded = encodeEvent(event, person, props, {
      ...capture,
      id: capture?.id ?? id(),
    });
    return outbox.put(JSON.parse(encoded.json));
  }
  function send(event: string, props: unknown, capture?: CaptureOptions) {
    const task = stage(event, props, capture).then(deliver);
    // Capture may intentionally run in the background.
    void task.catch(() => {});
    return task;
  }
  const listener = AppState.addEventListener("change", (state) => {
    if (state === "active" || state === "background" || state === "inactive")
      wake();
  });
  const unsubscribe = options.subscribeConnectivity?.((online) => {
    if (online) wake();
  });
  schedule(0);
  return {
    get distinctId() {
      return person;
    },
    identify,
    reset: () => identify(id()),
    capture: (name, ...args) => send(name, args[0], args[1]),
    enqueue: async (name, ...args) => {
      const row = await stage(name, args[0], args[1]);
      schedule(options.flushIntervalMs ?? 150);
      return { id: row.uuid };
    },
    screen: (name, capture) =>
      send(
        "screen_view",
        { screen: stringField(name, "screen", 256) },
        capture
      ),
    flush,
    shutdown() {
      if (!closing) {
        closed = true;
        clearTimeout(timer);
        listener.remove();
        unsubscribe?.();
        closing = (async () => {
          try {
            // A replay already in progress may have snapshotted before the last put.
            await replay?.catch(() => {});
            await flush();
          } finally {
            await Promise.all([queue.shutdown(), write]);
          }
        })();
      }
      return closing;
    },
  };
}
