import { utf8Length } from "./utf8.js";
import { encodeEvent, type EncodedEvent } from "./event.js";
import { configure, MAX_BODY_BYTES, transmit } from "./transport.js";
import { BirdwatchError } from "./types.js";
import type { CaptureOptions, ClientOptions, Receipt } from "./types.js";

interface Pending extends EncodedEvent {
  acknowledged: Promise<Receipt>;
  resolve: (receipt: Receipt) => void;
  reject: (error: unknown) => void;
}

export class DeliveryQueue {
  private readonly config;
  private readonly prefix;
  private readonly overhead;
  private readonly waiting: Pending[] = [];
  private readonly pending = new Set<Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private closing?: Promise<void>;

  constructor(options: ClientOptions, endpointFor?: (host: string) => string) {
    this.config = configure(options, endpointFor);
    this.prefix =
      '{"api_key":' + JSON.stringify(this.config.key) + ',"batch":[';
    this.overhead = utf8Length(this.prefix) + 2;
  }

  capture(
    name: unknown,
    person: unknown,
    props: unknown,
    options?: CaptureOptions
  ): Promise<Receipt> {
    return this.observe(
      this.enqueue(() => encodeEvent(name, person, props, options ?? {}))
    );
  }

  /** Deliver a previously validated snapshot without consulting the device clock again. */
  captureEncoded(event: EncodedEvent): Promise<Receipt> {
    return this.observe(this.enqueue(() => event));
  }

  private observe(delivery: Promise<Receipt>) {
    // A caller may intentionally leave analytics in the background. The original
    // promise still rejects for callers that await it.
    void delivery.catch(async (error) => {
      try {
        await this.config.onError?.(error);
      } catch {
        /* Observer failures do not interrupt delivery. */
      }
    });
    return delivery;
  }

  private async enqueue(snapshot: () => EncodedEvent): Promise<Receipt> {
    if (this.closing)
      throw new BirdwatchError("closed", "The client has been shut down.");
    if (this.pending.size >= this.config.maxQueue)
      throw new BirdwatchError(
        "queue_full",
        "The capture queue is full. Await delivery before capturing more events."
      );
    const event = snapshot();
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const acknowledged = new Promise<Receipt>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const item: Pending = { ...event, acknowledged, resolve, reject };
    this.waiting.push(item);
    this.pending.add(item);
    if (this.waiting.length >= this.config.batchSize) {
      void this.drain();
    } else if (!this.running && this.timer === undefined) {
      this.timer = setTimeout(() => {
        void this.drain();
      }, this.config.flushInterval);
    }
    return acknowledged;
  }

  flush(): Promise<void> {
    // New captures cannot delay this barrier, even on a continuously busy server.
    const outstanding = Array.from(this.pending, (item) => item.acknowledged);
    void this.drain();
    return Promise.allSettled(outstanding).then((results) => {
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    });
  }

  shutdown(): Promise<void> {
    if (!this.closing) {
      // Close admission before a custom fetch implementation gets control in drain().
      let resolve!: () => void, reject!: (error: unknown) => void;
      this.closing = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      this.flush().then(resolve, reject);
    }
    return this.closing;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    try {
      while (this.waiting.length) {
        let bytes = this.overhead;
        let size = 0;
        for (const item of this.waiting) {
          if (
            size === this.config.batchSize ||
            (size && bytes + 1 + item.bytes > MAX_BODY_BYTES)
          )
            break;
          bytes += item.bytes + (size ? 1 : 0);
          size++;
        }
        await this.deliver(this.waiting.splice(0, size));
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(items: Pending[]): Promise<void> {
    const body = this.prefix + items.map((item) => item.json).join(",") + "]}";
    try {
      const batch = await transmit(this.config, body, items.length);
      for (const item of items) {
        this.pending.delete(item);
        item.resolve({ id: item.id, batch });
      }
    } catch (error) {
      // The collector validates a batch atomically. Split input/size rejections so a
      // single bad event cannot discard its valid neighbors.
      if (
        items.length > 1 &&
        error instanceof BirdwatchError &&
        (error.status === 400 || error.status === 413)
      ) {
        const split = Math.ceil(items.length / 2);
        await this.deliver(items.slice(0, split));
        await this.deliver(items.slice(split));
        return;
      }
      for (const item of items) {
        this.pending.delete(item);
        item.reject(error);
      }
    }
  }
}
