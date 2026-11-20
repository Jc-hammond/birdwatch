import { utf8Length } from "./utf8.js";
import { encodeEvent, type EncodedEvent } from "./event.js";
import { configure, DeliveryFailure, payload, send } from "./transport.js";
import type { browserOutbox } from "./outbox.js";
import { BirdwatchError } from "./types.js";
import type { CaptureOptions, ClientOptions, Receipt } from "./types.js";

interface Pending extends EncodedEvent {
  slot?: string;
  acknowledged: Promise<Receipt>;
  resolve: (receipt: Receipt) => void;
  reject: (error: unknown) => void;
}

export class DeliveryQueue {
  private readonly config;
  private readonly overhead;
  private readonly pending = new Set<Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private paused?: BirdwatchError;
  private unloading?: Promise<void>;
  private overflow = false;
  private ceiling = 1000;
  private closing?: Promise<void>;

  constructor(
    options: ClientOptions,
    endpointFor?: (host: string) => string,
    private readonly browser = false,
    private readonly outbox?: ReturnType<typeof browserOutbox>,
    private readonly retryLimit = Infinity
  ) {
    this.config = configure(options, endpointFor);
    this.overhead = utf8Length(payload(this.config.key, []));
    outbox?.restore((event, slot) => this.admit(event, slot));
  }

  private report(error: BirdwatchError) {
    try {
      void Promise.resolve(this.config.onError?.(error)).catch(() => {});
    } catch {
      /* Ignore observer errors. */
    }
  }

  capture(
    name: unknown,
    person: unknown,
    props: unknown,
    options?: CaptureOptions
  ): Promise<Receipt> {
    try {
      return this.captureEncoded(
        encodeEvent(name, person, props, options ?? {})
      );
    } catch (error) {
      return this.failed(error as BirdwatchError);
    }
  }
  private failed(error: BirdwatchError) {
    this.report(error);
    const rejected = Promise.reject<Receipt>(error);
    void rejected.catch(() => {});
    return rejected;
  }
  captureEncoded(event: EncodedEvent): Promise<Receipt> {
    if (this.closing)
      return this.failed(
        new BirdwatchError("closed", "The client has been shut down.")
      );
    return this.admit(event);
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
      if (!this.overflow) this.report(error);
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
    this.report(error);
  }
  private async deliver(rows: Pending[]) {
    let result;
    try {
      result = await send(
        this.config,
        payload(this.config.key, rows),
        rows.length,
        this.browser
      );
    } catch (error) {
      if (!rows.some((item) => this.pending.has(item))) return;
      if (error instanceof DeliveryFailure) {
        if (error.outcome === "drop") {
          this.drop(rows, error);
          return;
        }
        if (error.outcome === "pause" && !Number.isFinite(this.retryLimit)) {
          if (!this.paused) {
            this.paused = error;
            for (const item of this.pending) item.reject(error);
            this.report(error);
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
        this.report(error);
      } else item.resolve({ id: item.id, batch: result.counts });
    });
    this.overflow = false;
    this.ceiling = 1000;
  }
  private async drain() {
    if (
      this.running ||
      this.paused ||
      this.unloading ||
      (this.ceiling > 1000 && this.timer !== undefined)
    )
      return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    let attempts = 0;
    try {
      while (this.pending.size && !this.paused) {
        if (this.unloading) await this.unloading;
        if (!this.pending.size || this.paused) break;
        const rows = this.take(Array.from(this.pending));
        try {
          await this.deliver(rows);
          attempts = 0;
        } catch (error) {
          const failure = error as DeliveryFailure;
          if (attempts++ >= this.retryLimit) {
            this.drop(rows, failure);
            attempts = 0;
            continue;
          }
          const delay = failure.after ?? Math.random() * this.ceiling;
          this.ceiling = Math.min(60000, this.ceiling * 2);
          if (!Number.isFinite(this.retryLimit)) {
            this.schedule(delay);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } finally {
      this.running = false;
    }
  }

  unload() {
    if (this.paused || this.unloading || !this.pending.size) return;
    if (!this.running && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const all = Array.from(this.pending);
    const jobs = [];
    while (all.length) {
      const rows = this.take(all);
      jobs.push(
        this.deliver(rows).catch((error) => {
          if (error.code !== "network" && error.code !== "timeout") return;
          try {
            window.navigator.sendBeacon(
              this.config.endpoint,
              payload(this.config.key, rows)
            );
          } catch {
            /* The outbox retains unacknowledged rows. */
          }
        })
      );
    }
    this.unloading = Promise.all(jobs).then(() => {
      this.unloading = undefined;
      if (
        !this.paused &&
        !this.running &&
        this.pending.size &&
        this.timer === undefined
      )
        this.schedule(this.ceiling);
    });
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
