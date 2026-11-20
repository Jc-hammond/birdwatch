import { utf8Length } from "./utf8.js";
import { encodeEvent, type EncodedEvent } from "./event.js";
import { configure, DeliveryFailure, payload, retryDelay, send } from "./transport.js";
import { browserOutbox } from "./outbox.js";
import { BirdwatchError } from "./types.js";
import type { CaptureOptions, BrowserOptions, Receipt } from "./types.js";

interface Pending extends EncodedEvent {
  slot?: string;
  acknowledged: Promise<Receipt>;
  resolve: (receipt: Receipt) => void;
  reject: (error: unknown) => void;
}

export class DeliveryQueue {
  private readonly config;
  private readonly overhead;
  private readonly outbox?: ReturnType<typeof browserOutbox>;
  private readonly pending = new Set<Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private paused?: BirdwatchError;
  private readonly unloading = new Set<Pending>();
  private retryAt = 0;
  private overflow = false;
  private failures = 0;
  private closing?: Promise<void>;

  constructor(
    options: BrowserOptions,
    private readonly browser = false
  ) {
    this.config = configure(options);
    this.overhead = utf8Length(payload(this.config.key, []));
    if (browser && options.persist) {
      this.outbox = browserOutbox(this.config.endpoint, this.config.key, () =>
        this.config.report(
          new BirdwatchError(
            "storage",
            "Browser queue storage is unavailable or corrupt."
          )
        )
      );
      this.outbox.restore((event, slot) => this.admit(event, slot));
    }
  }

  capture(
    name: unknown,
    person: unknown,
    props: unknown,
    options?: CaptureOptions
  ): Promise<Receipt> {
    try {
      const event = encodeEvent(name, person, props, options ?? {});
      if (this.closing)
        throw new BirdwatchError("closed", "The client has been shut down.");
      return this.admit(event);
    } catch (error) {
      return this.failed(error as BirdwatchError);
    }
  }
  private failed(error: BirdwatchError) {
    this.config.report(error);
    const rejected = Promise.reject<Receipt>(error);
    void rejected.catch(() => {});
    return rejected;
  }
  private admit(event: EncodedEvent, slot?: string) {
    if (this.pending.size >= this.config.maxQueue) {
      const oldest = this.pending.values().next().value!;
      const error = new BirdwatchError(
        "queue_full",
        "Dropped the oldest queued event."
      );
      this.remove(oldest);
      oldest.reject(error);
      if (!this.overflow) this.config.report(error);
      this.overflow = true;
    }
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const acknowledged = new Promise<Receipt>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    void acknowledged.catch(() => {});
    this.pending.add({
      ...event,
      slot: slot ?? this.outbox?.save(event.json),
      acknowledged,
      resolve,
      reject,
    });
    if (this.paused) reject(this.paused);
    if (this.pending.size >= this.config.batchSize) void this.drain();
    else if (!this.running && !this.paused && this.timer === undefined)
      this.schedule(this.config.flushInterval);
    return acknowledged;
  }

  private schedule(ms: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, ms);
  }
  private remove(item: Pending) {
    this.pending.delete(item);
    if (item.slot) this.outbox?.remove(item.slot);
  }
  private take(rows: Pending[]) {
    let bytes = this.overhead,
      n = 0;
    for (const row of rows) {
      if (
        n === this.config.batchSize ||
        (n && bytes + 1 + row.bytes > (this.browser ? 49152 : 1048576))
      )
        break;
      bytes += row.bytes + 1;
      n++;
    }
    return rows.splice(0, n);
  }
  private drop(rows: Pending[], error: BirdwatchError) {
    for (const item of rows) {
      if (!this.pending.has(item)) continue;
      this.remove(item);
      item.reject(error);
    }
    this.config.report(error);
  }
  private async deliver(rows: Pending[], keepalive = false) {
    let result;
    try {
      result = await send(
        this.config,
        payload(this.config.key, rows),
        rows.length,
        this.browser,
        keepalive
      );
    } catch (error) {
      if (!rows.some((item) => this.pending.has(item))) return;
      if (error instanceof DeliveryFailure) {
        if (error.outcome === "drop") {
          this.drop(rows, error);
          return;
        }
        if (error.outcome === "pause") {
          if (!this.paused) {
            this.paused = error;
            for (const item of this.pending) item.reject(error);
            this.config.report(error);
          }
          return;
        }
      }
      throw error;
    }
    rows.forEach((item, index) => {
      if (!this.pending.has(item)) return;
      this.remove(item);
      const error = result.rejected.get(index);
      if (error) {
        item.reject(error);
        this.config.report(error);
      } else item.resolve({ id: item.id, batch: result.counts });
    });
    this.overflow = false;
    this.failures = 0;
  }
  private retry(ms: number) {
    this.retryAt = Math.max(this.retryAt, Date.now() + ms);
    clearTimeout(this.timer);
    this.schedule(this.retryAt - Date.now());
  }
  private available() {
    return Array.from(this.pending).filter((item) => !this.unloading.has(item));
  }
  private async drain() {
    if (this.running || this.paused || Date.now() < this.retryAt) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    try {
      while (this.pending.size && !this.paused && Date.now() >= this.retryAt) {
        let rows = this.take(this.available());
        if (!rows.length) break;
        while (rows.length && !this.paused) {
          try {
            await this.deliver(rows);
            break;
          } catch (error) {
            const failure = error as DeliveryFailure;
            this.retryAt = Math.max(
              this.retryAt,
              Date.now() + retryDelay(failure, this.failures++)
            );
            while (Date.now() < this.retryAt) {
              await new Promise((resolve) =>
                setTimeout(resolve, this.retryAt - Date.now())
              );
            }
            rows = rows.filter((item) => this.pending.has(item));
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  unload() {
    if (this.paused || Date.now() < this.retryAt) return;
    const all = this.available();
    while (all.length) {
      const rows = this.take(all);
      rows.forEach((item) => this.unloading.add(item));
      void this.deliver(rows, true)
        .catch((error) => {
          if (error.code === "network" || error.code === "timeout") {
            try {
              window.navigator.sendBeacon(
                this.config.endpoint,
                payload(this.config.key, rows)
              );
            } catch {
              /* Keep the rows until an acknowledgement arrives. */
            }
          }
          this.retry(retryDelay(error, this.failures++));
        })
        .finally(() => {
          rows.forEach((item) => this.unloading.delete(item));
          if (
            !this.running &&
            !this.paused &&
            this.pending.size &&
            this.timer === undefined
          )
            void this.drain();
        });
    }
  }

  flush(): Promise<void> {
    if (this.paused) return Promise.reject(this.paused);
    const outstanding = Array.from(this.pending, (item) => item.acknowledged);
    void this.drain();
    return Promise.allSettled(outstanding).then((results) => {
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    });
  }
  shutdown(): Promise<void> {
    if (!this.closing) {
      const drain = Promise.resolve().then(() => this.flush());
      this.closing = drain;
    }
    return this.closing;
  }
}
