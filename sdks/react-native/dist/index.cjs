var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// react-native/index.ts
var index_exports = {};
__export(index_exports, {
  BirdwatchError: () => BirdwatchError,
  createReactNativeClient: () => createReactNativeClient
});
module.exports = __toCommonJS(index_exports);

// ../sdk/src/utf8.ts
function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}

// react-native/index.ts
var import_async_storage = __toESM(require("@react-native-async-storage/async-storage"), 1);

// ../sdk/src/types.ts
var BirdwatchError = class extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    __publicField(this, "code", code);
    __publicField(this, "status", status);
    __publicField(this, "name", "BirdwatchError");
  }
};

// react-native/outbox.ts
var writers = /* @__PURE__ */ new Map();
var maxBytes = 1024 * 1024;
var Outbox = class {
  constructor(storage, key, capacity) {
    __publicField(this, "storage", storage);
    __publicField(this, "key", key);
    __publicField(this, "capacity", capacity);
    __publicField(this, "memory", []);
  }
  run(fn) {
    const task = (writers.get(this.key) ?? Promise.resolve()).then(fn);
    const tail = task.then(
      () => {
      },
      () => {
      }
    );
    writers.set(this.key, tail);
    void tail.then(() => {
      if (writers.get(this.key) === tail) writers.delete(this.key);
    });
    return task;
  }
  async load() {
    if (!this.storage) return this.memory;
    const raw = await this.storage.getItem(this.key);
    if (raw === null) return [];
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(
      (row) => !row || typeof row.uuid !== "string" || typeof row.event !== "string" || typeof row.distinct_id !== "string" || typeof row.timestamp !== "string" || typeof row.properties !== "object" || row.properties === null
    ))
      throw new Error(
        "Unreadable Birdwatch outbox. The stored data was preserved."
      );
    return rows;
  }
  async save(rows) {
    if (!this.storage) {
      this.memory = rows;
      return;
    }
    const value = JSON.stringify(rows);
    if (utf8Length(value) > maxBytes)
      throw new BirdwatchError("queue_full", "Birdwatch outbox exceeds 1 MiB.");
    await this.storage.setItem(this.key, value);
  }
  list() {
    return this.run(() => this.load());
  }
  put(row) {
    return this.run(async () => {
      const rows = await this.load();
      const existing = rows.find((event) => event.uuid === row.uuid);
      if (existing) return existing;
      if (rows.length >= this.capacity)
        throw new BirdwatchError("queue_full", "Birdwatch outbox is full.");
      await this.save([...rows, row]);
      return row;
    });
  }
  remove(id) {
    return this.run(async () => {
      const rows = await this.load();
      const next = rows.filter((row) => row.uuid !== id);
      if (next.length !== rows.length) await this.save(next);
    });
  }
};

// ../sdk/src/event.ts
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
  return { id, json, bytes: utf8Length(json) };
}

// endpoint.ts
function captureEndpoint(host) {
  if (typeof host !== "string" || !/^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?(?:\/[^?#\\\s]*)?$/i.test(
    host
  )) {
    invalid(
      "host must be an HTTP(S) URL without credentials, a query, or a fragment."
    );
  }
  return host.replace(/\/+$/, "") + "/api/capture";
}

// react-native/index.ts
var import_react_native = require("react-native");

// ../sdk/src/transport.ts
function integer(value, initial, min, max, field) {
  if (value === void 0) return initial;
  if (!Number.isInteger(value) || value < min || value > max)
    invalid(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}
function browserEndpoint(host) {
  let url;
  try {
    url = new URL(host);
  } catch {
    return invalid("host must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalid(
      "host must be an HTTP(S) URL without credentials, a query, or a fragment."
    );
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/capture";
  return url.href;
}
function configure(options, endpointFor = browserEndpoint) {
  if (!options || typeof options.host !== "string")
    invalid("Provide a host and project writeKey.");
  const endpoint = endpointFor(options.host);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function")
    invalid("A Fetch API implementation is required.");
  if (options.onError !== void 0 && typeof options.onError !== "function")
    invalid("onError must be a function.");
  return {
    onError: options.onError,
    endpoint,
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
    __publicField(this, "retryAfter", retryAfter);
  }
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

// ../sdk/src/queue.ts
var DeliveryQueue = class {
  constructor(options, endpointFor) {
    __publicField(this, "config");
    __publicField(this, "prefix");
    __publicField(this, "overhead");
    __publicField(this, "waiting", []);
    __publicField(this, "pending", /* @__PURE__ */ new Set());
    __publicField(this, "timer");
    __publicField(this, "running", false);
    __publicField(this, "closing");
    this.config = configure(options, endpointFor);
    this.prefix = '{"api_key":' + JSON.stringify(this.config.key) + ',"batch":[';
    this.overhead = utf8Length(this.prefix) + 2;
  }
  capture(name, person, props, options) {
    return this.observe(
      this.enqueue(() => encodeEvent(name, person, props, options ?? {}))
    );
  }
  /** Deliver a previously validated snapshot without consulting the device clock again. */
  captureEncoded(event) {
    return this.observe(this.enqueue(() => event));
  }
  observe(delivery) {
    void delivery.catch(async (error) => {
      try {
        await this.config.onError?.(error);
      } catch {
      }
    });
    return delivery;
  }
  async enqueue(snapshot) {
    if (this.closing)
      throw new BirdwatchError("closed", "The client has been shut down.");
    if (this.pending.size >= this.config.maxQueue)
      throw new BirdwatchError(
        "queue_full",
        "The capture queue is full. Await delivery before capturing more events."
      );
    const event = snapshot();
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

// react-native/index.ts
async function createReactNativeClient(options) {
  const queue = new DeliveryQueue(options, captureEndpoint);
  const storage = options.storage === void 0 ? import_async_storage.default : options.storage;
  const scope = JSON.stringify([
    options.host.replace(/\/+$/, ""),
    options.writeKey
  ]);
  const outbox = new Outbox(
    storage,
    "birdwatch:outbox:v1:" + scope,
    options.maxQueueSize ?? 1e3
  );
  const key = "birdwatch:identity:" + scope;
  const id = () => {
    const raw = options.randomUUID ? options.randomUUID() : globalThis.crypto?.randomUUID?.();
    if (!raw)
      invalid("Pass a randomUUID function, such as Expo Crypto.randomUUID.");
    return stringField(raw, "generated ID", 128);
  };
  const stored = await storage?.getItem(key);
  let person = stored == null ? id() : stringField(stored, "stored identity", 256);
  if (stored == null) await storage?.setItem(key, person);
  let write = Promise.resolve();
  let closed = false;
  async function identify(value) {
    if (closed) throw new Error("The client has been shut down.");
    person = stringField(value, "distinctId", 256);
    if (storage)
      write = write.catch(() => {
      }).then(() => storage.setItem(key, value));
    await write;
  }
  let timer;
  let retryMs = 1e3;
  let retryAfter = 0;
  let replay;
  let closing;
  const active = /* @__PURE__ */ new Map();
  function schedule(ms) {
    if (closed || timer !== void 0) return;
    timer = setTimeout(() => {
      timer = void 0;
      void flush().catch(() => {
      });
    }, ms);
  }
  function retry() {
    schedule(Math.max(retryMs, Math.min(864e5, retryAfter - Date.now())));
    retryMs = Math.min(6e4, retryMs * 2);
  }
  function deliver(row) {
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
          bytes: utf8Length(json)
        });
        await outbox.remove(row.uuid);
        return receipt;
      } catch (error) {
        if (error instanceof BirdwatchError && (error.status === 400 || error.status === 413)) {
          await outbox.remove(row.uuid);
        } else {
          if (error instanceof BirdwatchError && "retryAfter" in error && typeof error.retryAfter === "number")
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
  function flush() {
    if (replay) return replay.then(flush);
    const run = async () => {
      const rows = await outbox.list();
      const size = options.batchSize ?? 20;
      for (let i = 0; i < rows.length; i += size) {
        const tasks = rows.slice(i, i + size).map(deliver);
        void queue.flush().catch(() => {
        });
        const results = await Promise.allSettled(tasks);
        const failed = results.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      retryMs = 1e3;
    };
    replay = run().catch((err) => {
      retry();
      throw err;
    }).finally(() => {
      replay = void 0;
    });
    return replay;
  }
  function wake() {
    if (closed) return;
    clearTimeout(timer);
    timer = void 0;
    void flush().catch(() => {
    });
  }
  async function stage(event, props, capture) {
    if (closed)
      throw new BirdwatchError("closed", "The client has been shut down.");
    const encoded = encodeEvent(event, person, props, {
      ...capture,
      id: capture?.id ?? id()
    });
    return outbox.put(JSON.parse(encoded.json));
  }
  function send(event, props, capture) {
    const task = stage(event, props, capture).then(deliver);
    void task.catch(() => {
    });
    return task;
  }
  const listener = import_react_native.AppState.addEventListener("change", (state) => {
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
    screen: (name, capture) => send(
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
            await replay?.catch(() => {
            });
            await flush();
          } finally {
            await Promise.all([queue.shutdown(), write]);
          }
        })();
      }
      return closing;
    }
  };
}
