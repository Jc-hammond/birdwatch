/*! Birdwatch SDK | MIT */

// src/types.ts
var BirdwatchError = class extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
  code;
  status;
  name = "BirdwatchError";
};

// src/event.ts
function invalid(message) {
  throw new BirdwatchError("invalid_input", message);
}
function stringField(value, field, limit) {
  if (typeof value !== "string" || !value.trim() || [...value].length > limit || /[\u0000\uD800-\uDFFF]/u.test(value)) {
    invalid(
      `${field} must be a nonempty Unicode string of at most ${limit} characters.`
    );
  }
  return value;
}
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}
function plainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}
function snapshotProperties(value) {
  if (!plainObject(value)) invalid("properties must be a plain JSON object.");
  try {
    const json = JSON.stringify(value, function(key, item) {
      const original = this[key];
      if (typeof original === "object" && original !== null && !Array.isArray(original) && !plainObject(original)) {
        invalid(
          "properties must contain only JSON values. Convert dates to strings."
        );
      }
      if (typeof original?.toJSON === "function" || item === void 0 || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || typeof item === "number" && !Number.isFinite(item)) {
        invalid(
          "properties must contain only finite numbers, strings, booleans, null, arrays, or objects."
        );
      }
      return item;
    });
    const asciiLength = json.length + 5 * (json.match(/[^\x00-\x7e]/g)?.length ?? 0);
    if (asciiLength > 32768)
      invalid("Encoded properties exceed the collector's 32 KiB limit.");
    return json;
  } catch (error) {
    if (error instanceof BirdwatchError) throw error;
    throw new BirdwatchError(
      "invalid_input",
      "properties must be an acyclic JSON object.",
      void 0,
      { cause: error }
    );
  }
}
function occurrenceTime(value) {
  if (value === void 0) return (/* @__PURE__ */ new Date()).toISOString();
  let time;
  let micros = "";
  if (value instanceof Date) {
    time = value.getTime();
  } else {
    const parts = typeof value === "string" && /^(\d{4}-\d\d-\d\d)T(\d\d):\d\d(?::\d\d(?:\.(\d{1,6}))?)?(Z|[+-]\d\d:\d\d)$/.exec(
      value
    );
    if (!parts || Number(parts[2]) > 23)
      invalid(
        "timestamp must be a Date or an ISO 8601 timestamp with a time zone."
      );
    const day = /* @__PURE__ */ new Date(parts[1] + "T00:00:00Z");
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== parts[1])
      invalid("timestamp contains an invalid calendar date.");
    time = Date.parse(value);
    micros = (parts[3] ?? "").slice(3);
  }
  if (!Number.isFinite(time) || time > Date.now() + 3e5)
    invalid("Invalid or future timestamp (maximum clock skew 5 minutes).");
  const iso = new Date(time).toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith("0000-"))
    invalid("timestamp year must be between 1 and 9999.");
  return micros ? iso.slice(0, -1) + micros.padEnd(3, "0") + "Z" : iso;
}
var encoder = new TextEncoder();
function encodeEvent(name, person, props, options) {
  if (!plainObject(options)) invalid("Capture options must be an object.");
  const id = options.id === void 0 ? newId() : stringField(options.id, "id", 128);
  const metadata = {
    uuid: id,
    event: stringField(name, "event", 128),
    distinct_id: stringField(person, "distinctId", 256),
    timestamp: occurrenceTime(options.timestamp)
  };
  const properties = snapshotProperties(props === void 0 ? {} : props);
  const json = JSON.stringify(metadata).slice(0, -1) + ',"properties":' + properties + "}";
  return { id, json, bytes: encoder.encode(json).length };
}

// src/transport.ts
function integer(value, initial, min, max, field) {
  if (value === void 0) return initial;
  if (!Number.isInteger(value) || value < min || value > max)
    invalid(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}
function configure(options) {
  if (!options || typeof options.host !== "string")
    invalid("Provide a host and project writeKey.");
  let url;
  try {
    url = new URL(options.host);
  } catch {
    return invalid("host must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalid(
      "host must be an HTTP(S) URL without credentials, a query, or a fragment."
    );
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/capture";
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function")
    invalid("A Fetch API implementation is required.");
  if (options.onError !== void 0 && typeof options.onError !== "function")
    invalid("onError must be a function.");
  return {
    onError: options.onError,
    endpoint: url.href,
    key: stringField(options.writeKey, "writeKey", 128),
    fetch: fetcher,
    batchSize: integer(options.batchSize, 20, 1, 100, "batchSize"),
    flushInterval: integer(
      options.flushIntervalMs,
      150,
      0,
      6e4,
      "flushIntervalMs"
    ),
    maxQueue: integer(options.maxQueueSize, 1e3, 1, 1e5, "maxQueueSize"),
    timeout: integer(options.timeoutMs, 5e3, 1, 12e4, "timeoutMs"),
    retries: integer(options.maxRetries, 2, 0, 5, "maxRetries")
  };
}
var MAX_BODY_BYTES = 48 * 1024;
var HttpFailure = class extends BirdwatchError {
  constructor(status, message, retryAfter) {
    super("http", message, status);
    this.retryAfter = retryAfter;
  }
  retryAfter;
};
function retryDelay(header) {
  if (header === null) return 0;
  const ms = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1e3 : Date.parse(header) - Date.now();
  return Number.isNaN(ms) ? 0 : Math.max(0, ms);
}
async function attempt(config, body, count) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  try {
    const fetcher = config.fetch;
    const response = await fetcher(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
      redirect: "error"
    });
    if (!response.ok) {
      let detail;
      try {
        detail = (await response.json()).error;
      } catch {
      }
      throw new HttpFailure(
        response.status,
        typeof detail === "string" ? detail : `Collector returned HTTP ${response.status}.`,
        retryDelay(response.headers.get("Retry-After"))
      );
    }
    const ack = await response.json().catch(() => null);
    if (!ack || !Number.isSafeInteger(ack.accepted) || !Number.isSafeInteger(ack.duplicates) || ack.accepted < 0 || ack.duplicates < 0 || ack.accepted + ack.duplicates !== count) {
      throw new BirdwatchError(
        "invalid_response",
        "Collector returned an invalid acknowledgement."
      );
    }
    return Object.freeze({
      accepted: ack.accepted,
      duplicates: ack.duplicates
    });
  } catch (cause) {
    if (controller.signal.aborted)
      throw new BirdwatchError(
        "timeout",
        "Capture request timed out.",
        void 0,
        { cause }
      );
    if (cause instanceof BirdwatchError) throw cause;
    throw new BirdwatchError(
      "network",
      "Could not reach the Birdwatch collector.",
      void 0,
      { cause }
    );
  } finally {
    clearTimeout(timer);
  }
}
async function transmit(config, body, count) {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt(config, body, count);
    } catch (error) {
      const http = error instanceof HttpFailure;
      const transient = http ? error.status === 408 || error.status === 429 || error.status >= 500 : error instanceof BirdwatchError && ["network", "timeout", "invalid_response"].includes(error.code);
      if (!transient || retry === config.retries) throw error;
      const delay = Math.max(
        http ? error.retryAfter : 0,
        (0.5 + Math.random() / 2) * 200 * 2 ** retry
      );
      if (delay > 3e4) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// src/queue.ts
var DeliveryQueue = class {
  config;
  prefix;
  overhead;
  waiting = [];
  pending = /* @__PURE__ */ new Set();
  timer;
  running = false;
  closing;
  constructor(options) {
    this.config = configure(options);
    this.prefix = '{"api_key":' + JSON.stringify(this.config.key) + ',"batch":[';
    this.overhead = new TextEncoder().encode(this.prefix).length + 2;
  }
  capture(name, person, props, options) {
    const delivery = this.enqueue(name, person, props, options);
    void delivery.catch(async (error) => {
      try {
        await this.config.onError?.(error);
      } catch {
      }
    });
    return delivery;
  }
  async enqueue(name, person, props, options = {}) {
    if (this.closing)
      throw new BirdwatchError("closed", "The client has been shut down.");
    if (this.pending.size >= this.config.maxQueue)
      throw new BirdwatchError(
        "queue_full",
        "The capture queue is full. Await delivery before capturing more events."
      );
    const event = encodeEvent(name, person, props, options);
    let resolve, reject;
    const acknowledged = new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const item = { ...event, acknowledged, resolve, reject };
    this.waiting.push(item);
    this.pending.add(item);
    if (this.waiting.length >= this.config.batchSize) {
      void this.drain();
    } else if (!this.running && this.timer === void 0) {
      this.timer = setTimeout(() => {
        void this.drain();
      }, this.config.flushInterval);
    }
    return acknowledged;
  }
  flush() {
    const outstanding = Array.from(this.pending, (item) => item.acknowledged);
    void this.drain();
    return Promise.allSettled(outstanding).then((results) => {
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    });
  }
  shutdown() {
    if (!this.closing) {
      let resolve, reject;
      this.closing = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      this.flush().then(resolve, reject);
    }
    return this.closing;
  }
  async drain() {
    if (this.running) return;
    clearTimeout(this.timer);
    this.timer = void 0;
    this.running = true;
    try {
      while (this.waiting.length) {
        let bytes = this.overhead;
        let size = 0;
        for (const item of this.waiting) {
          if (size === this.config.batchSize || size && bytes + 1 + item.bytes > MAX_BODY_BYTES)
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
  async deliver(items) {
    const body = this.prefix + items.map((item) => item.json).join(",") + "]}";
    try {
      const batch = await transmit(this.config, body, items.length);
      for (const item of items) {
        this.pending.delete(item);
        item.resolve({ id: item.id, batch });
      }
    } catch (error) {
      if (items.length > 1 && error instanceof BirdwatchError && (error.status === 400 || error.status === 413)) {
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
};

// src/browser.ts
function createBrowserClient(options) {
  if (typeof window === "undefined" || typeof document === "undefined")
    invalid(
      "createBrowserClient requires a browser. Use createServerClient on the server."
    );
  const queue = new DeliveryQueue(options);
  const persistence = options.persistence ?? "localStorage";
  if (!["memory", "localStorage"].includes(persistence))
    invalid("Unknown identity persistence mode.");
  const key = "signalnest.id." + options.writeKey;
  let storage;
  if (persistence === "localStorage") {
    try {
      storage = window.localStorage;
    } catch {
    }
  }
  function readStored() {
    try {
      const id = storage?.getItem(key);
      if (id) return stringField(id, "distinctId", 256);
    } catch {
    }
  }
  let person = readStored() ?? newId();
  function identify(id) {
    person = stringField(id, "distinctId", 256);
    try {
      storage?.setItem(key, person);
    } catch {
    }
  }
  identify(person);
  function onStorage(event) {
    if (storage && event.storageArea === storage && (event.key === key || event.key === null)) {
      person = readStored() ?? newId();
    }
  }
  function flushPage() {
    void queue.flush().catch(() => {
    });
  }
  function onVisibility() {
    if (document.visibilityState === "hidden") flushPage();
  }
  window.addEventListener("pagehide", flushPage);
  if (storage) window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisibility);
  return {
    get distinctId() {
      return person;
    },
    identify,
    reset() {
      identify(newId());
    },
    capture(event, ...args) {
      return queue.capture(event, person, args[0], args[1]);
    },
    page(options2) {
      return queue.capture(
        "page_view",
        person,
        { path: window.location.pathname },
        options2
      );
    },
    flush: () => queue.flush(),
    shutdown() {
      window.removeEventListener("pagehide", flushPage);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
      return queue.shutdown();
    }
  };
}

// src/index.ts
function createServerClient(options) {
  const queue = new DeliveryQueue(options);
  return {
    capture(input) {
      return queue.capture(
        input?.event,
        input?.distinctId,
        input?.properties,
        input ?? void 0
      );
    },
    flush: () => queue.flush(),
    shutdown: () => queue.shutdown()
  };
}
export {
  BirdwatchError,
  createBrowserClient,
  createServerClient
};
//# sourceMappingURL=index.js.map
