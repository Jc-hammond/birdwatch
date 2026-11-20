import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Outbox,
  storageError,
  type IdentityStorage,
  type Row,
} from "./outbox.js";
export type { IdentityStorage } from "./outbox.js";
import {
  configure,
  payload,
  send,
  DeliveryFailure,
} from "../../sdk/src/transport.js";
import { AppState } from "react-native";
import {
  BirdwatchError,
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
} from "../../sdk/src/internal.js";
export { BirdwatchError };
export type {
  Receipt,
  CaptureOptions,
  Properties,
} from "../../sdk/src/internal.js";

export interface NativeOptions extends ClientOptions {
  maxRetries?: number;
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
  C extends CatalogShape<C> = EventCatalog,
>(options: NativeOptions): Promise<NativeClient<C>> {
  const config = configure(options);
  const retries = options.maxRetries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5)
    invalid("maxRetries must be an integer from 0 to 5.");
  const storage =
    options.storage === undefined ? AsyncStorage : options.storage;
  const scope = JSON.stringify([options.host.replace(/\/+$/, ""), config.key]);
  const identityKey = "birdwatch:identity:" + scope;
  const id = () =>
    stringField(
      options.randomUUID?.() ?? globalThis.crypto?.randomUUID?.(),
      "generated ID",
      128,
    );
  function report(error: BirdwatchError) {
    try {
      void Promise.resolve(config.onError?.(error)).catch(() => {});
    } catch {
      /* observer */
    }
  }
  const box = new Outbox(
    storage,
    "birdwatch:outbox:v1:" + scope,
    config.maxQueue,
    id,
    report,
  );
  let person: string;
  try {
    const stored = await storage?.getItem(identityKey);
    person =
      stored == null ? id() : stringField(stored, "stored identity", 256);
    if (stored == null) await storage?.setItem(identityKey, person);
    await box.open();
  } catch (cause) {
    const error = storageError(cause);
    report(error);
    throw error;
  }

  type Waiter = {
    resolve: (r: Receipt) => void;
    reject: (e: BirdwatchError) => void;
    failures: number;
  };
  const token = (r: Row) => JSON.stringify([r.epoch, r.sequence, r.id]);
  const waiting = new Map<string, { row: Row; calls: Waiter[] }>();
  const flights = new Set<Set<string>>();
  let writes = Promise.resolve(),
    identityWrite = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | undefined;
  let backgroundRun: Promise<void> | undefined;
  let closing: Promise<void> | undefined,
    closed = false,
    overflow = false,
    online = true;
  let paused: BirdwatchError | undefined,
    lastFailure: BirdwatchError | undefined;
  let ceiling = 1000,
    retryAt = 0;
  let retry: Row[] = [];
  const budget = 1048576 - utf8Length(payload(config.key, []));

  function settle(row: Row, error?: BirdwatchError, receipt?: Receipt) {
    const key = token(row);
    const entry = waiting.get(key);
    waiting.delete(key);
    for (const call of entry?.calls ?? []) {
      if (error) call.reject(error);
      else call.resolve(receipt!);
    }
  }
  function forget(row: Row) {
    const key = token(row);
    for (const flight of flights) flight.delete(key);
    retry = retry.filter((item) => token(item) !== key);
  }
  function schedule(ms: number) {
    if (closed || paused || !online || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void flush().catch(() => {});
      },
      Math.max(0, Math.ceil(ms)),
    );
  }
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
  }
  function retryLater(rows: Row[], failure: BirdwatchError) {
    const kept = new Map(retry.map((row) => [token(row), row]));
    for (const row of rows) {
      const key = token(row);
      if ([...flights].some((f) => f.has(key))) continue;
      kept.set(key, row);
      const entry = waiting.get(key);
      if (entry) {
        entry.calls = entry.calls.filter((call) => {
          if (++call.failures <= retries) return true;
          report(failure);
          call.reject(failure);
          return false;
        });
        if (!entry.calls.length) waiting.delete(key);
      }
    }
    retry = [...kept.values()].sort((a, b) => a.sequence - b.sequence);
    if (!retry.length) return;
    const delay =
      (failure instanceof DeliveryFailure ? failure.retryAfter : undefined) ??
      Math.random() * ceiling;
    ceiling = Math.min(60000, ceiling * 2);
    retryAt = Date.now() + Math.ceil(delay);
    lastFailure = failure;
    cancel();
    schedule(delay);
  }
  async function deliver(rows: Row[], background: boolean) {
    const outstanding = new Set(rows.map(token));
    flights.add(outstanding);
    try {
      let ack;
      try {
        ack = await send(
          config,
          payload(config.key, rows),
          rows.length,
          false,
          background,
        );
      } catch (cause) {
        const failure = storageError(cause);
        const live = rows.filter((r) => outstanding.has(token(r)));
        if (!live.length) return;
        if (failure instanceof DeliveryFailure && failure.outcome === "pause") {
          if (!paused) report(failure);
          paused = failure;
          cancel();
          for (const [key, { row }] of waiting) {
            if (![...flights].some((f) => f !== outstanding && f.has(key)))
              settle(row, failure);
          }
        } else if (
          failure instanceof DeliveryFailure &&
          failure.outcome === "drop"
        ) {
          await box.acknowledge(live);
          for (const row of live) {
            forget(row);
            settle(row, failure);
          }
          report(failure);
          return failure;
        } else {
          flights.delete(outstanding);
          if (paused) {
            for (const row of live) settle(row, paused);
          } else retryLater(live, failure);
        }
        throw failure;
      }
      await box.acknowledge(rows);
      let firstRejection: BirdwatchError | undefined;
      rows.forEach((row, i) => {
        if (!outstanding.has(token(row))) return;
        const rejection = ack.rejected.get(i);
        forget(row);
        if (rejection) {
          firstRejection ??= rejection;
          report(rejection);
        }
        settle(row, rejection, { id: row.id, batch: ack.counts });
      });
      overflow = false;
      if (!retry.length) {
        ceiling = 1000;
        retryAt = 0;
      }
      return firstRejection;
    } finally {
      flights.delete(outstanding);
    }
  }
  async function next() {
    if (retry.length) return retry.slice();
    const rows = await box.take(config.batchSize, budget);
    // A second client can have removed a local receipt's row. Reuse its UUID to get a receipt.
    if (!rows.length && waiting.size)
      return [waiting.values().next().value!.row];
    return rows;
  }
  async function drain(background: boolean) {
    let rejected: BirdwatchError | undefined;
    do {
      if (paused) throw paused;
      if (!online || Date.now() < retryAt) {
        if (online) schedule(retryAt - Date.now());
        throw (
          lastFailure ??
          new BirdwatchError("network", "Delivery is waiting for connectivity.")
        );
      }
      const rows = await next();
      if (!rows.length) break;
      const error = await deliver(rows, background);
      rejected ??= error;
    } while (!background);
    if (rejected) throw rejected;
  }
  async function flush(background = false): Promise<void> {
    await writes;
    if (background && running) {
      backgroundRun ??= drain(true).finally(() => {
        backgroundRun = undefined;
      });
      return backgroundRun;
    }
    if (!running) {
      if (Date.now() >= retryAt) cancel();
      running = drain(false)
        .catch((cause) => {
          const error = storageError(cause);
          if (error.code === "storage") {
            report(error);
            schedule(1000);
          }
          throw error;
        })
        .finally(() => {
          running = undefined;
        });
    }
    return running;
  }
  function stage(event: string, props: unknown, opts?: CaptureOptions) {
    if (closed)
      throw new BirdwatchError("closed", "The client has been shut down.");
    const encoded = encodeEvent(event, person, props, {
      ...opts,
      id: opts?.id ?? id(),
    });
    const saved = box.put(encoded).then(({ row, dropped, size }) => {
      if (dropped.length) {
        const error = new BirdwatchError(
          "queue_full",
          "Dropped the oldest queued events.",
        );
        if (!overflow) report(error);
        overflow = true;
        for (const old of dropped) {
          forget(old);
          settle(old, error);
        }
      }
      if (
        size >= config.batchSize &&
        !running &&
        online &&
        !paused &&
        Date.now() >= retryAt
      )
        void flush().catch(() => {});
      else schedule(config.flushInterval);
      return row;
    });
    writes = saved.then(
      () => {},
      () => {},
    );
    return saved;
  }
  async function enqueue(event: string, props: unknown, opts?: CaptureOptions) {
    try {
      return { id: (await stage(event, props, opts)).id };
    } catch (cause) {
      const e = storageError(cause);
      report(e);
      throw e;
    }
  }
  function capture(
    event: string,
    props: unknown,
    opts?: CaptureOptions,
  ): Promise<Receipt> {
    const receipt = (async () => {
      let row: Row;
      try {
        row = await stage(event, props, opts);
      } catch (cause) {
        const e = storageError(cause);
        report(e);
        throw e;
      }
      if (paused) throw paused;
      return new Promise<Receipt>((resolve, reject) => {
        const key = token(row),
          entry = waiting.get(key) ?? { row, calls: [] as Waiter[] };
        entry.calls.push({ resolve, reject, failures: 0 });
        waiting.set(key, entry);
      });
    })();
    void receipt.catch(() => {});
    return receipt;
  }
  async function identify(value: string) {
    try {
      if (closed)
        throw new BirdwatchError("closed", "The client has been shut down.");
      person = stringField(value, "distinctId", 256);
      identityWrite = identityWrite
        .catch(() => {})
        .then(() => storage?.setItem(identityKey, value));
      await identityWrite;
    } catch (cause) {
      const e = storageError(cause);
      report(e);
      throw e;
    }
  }
  function wake(background = false) {
    if (!closed && online && !paused) void flush(background).catch(() => {});
  }
  let listener: { remove(): void } | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    listener = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") wake(true);
      else if (state === "active") wake();
    });
    unsubscribe = options.subscribeConnectivity?.((connected) => {
      online = connected;
      cancel();
      if (online) wake();
    });
  } catch (cause) {
    listener?.remove();
    const error = storageError(cause);
    report(error);
    throw error;
  }
  schedule(config.flushInterval);
  return {
    get distinctId() {
      return person;
    },
    identify,
    reset: async () => {
      let generated;
      try {
        generated = id();
      } catch (cause) {
        const error = storageError(cause);
        report(error);
        throw error;
      }
      await identify(generated);
    },
    enqueue: (name, ...args) => enqueue(name, args[0], args[1]),
    capture: (name, ...args) => capture(name, args[0], args[1]),
    screen: async (name, opts) => {
      let screen;
      try {
        screen = stringField(name, "screen", 256);
      } catch (cause) {
        const error = storageError(cause);
        report(error);
        throw error;
      }
      return capture("screen_view", { screen }, opts);
    },
    flush: () => flush(),
    shutdown() {
      if (!closing) {
        closed = true;
        cancel();
        try {
          listener?.remove();
        } catch (cause) {
          report(storageError(cause));
        }
        try {
          unsubscribe?.();
        } catch (cause) {
          report(storageError(cause));
        }
        closing = Promise.all([flush(), identityWrite])
          .then(
            () => {},
            (cause) => {
              throw storageError(cause);
            },
          )
          .finally(() => {
            const e = new BirdwatchError(
              "closed",
              "The client has been shut down.",
            );
            for (const { row } of waiting.values()) settle(row, e);
          });
      }
      return closing;
    },
  };
}
