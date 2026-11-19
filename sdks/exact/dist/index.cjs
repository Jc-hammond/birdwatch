var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// exact/index.ts
var index_exports = {};
__export(index_exports, {
  BirdwatchError: () => BirdwatchError,
  createExactClient: () => createExactClient,
  exactOutboxPath: () => exactOutboxPath
});
module.exports = __toCommonJS(index_exports);

// ../sdk/src/types.ts
var BirdwatchError = class extends Error {
  constructor(code, message, status, options) {
    super(message, options);
    __publicField(this, "code", code);
    __publicField(this, "status", status);
    __publicField(this, "name", "BirdwatchError");
  }
};

// exact/outbox.ts
var exactOutboxPath = "app:/data/birdwatch.sqlite";
var lastUse = Promise.resolve();
function exactOutbox(scope, capture, normalize) {
  function use(sqlite, action) {
    const run = lastUse.then(async () => {
      const db = await sqlite.open(exactOutboxPath);
      try {
        await db.execute(
          "CREATE TABLE IF NOT EXISTS events_v1 (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, uuid TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(scope,uuid))"
        );
        return await action(db);
      } finally {
        await db.close();
      }
    });
    lastUse = run.catch(() => {
    });
    return run;
  }
  async function enqueue(input, sqlite) {
    const event = normalize(input);
    if (typeof event.timestamp !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp))) {
      throw new BirdwatchError(
        "invalid_input",
        "Queued events require their original ISO timestamp with a time zone."
      );
    }
    const body = JSON.stringify(event);
    await use(sqlite, async (db) => {
      const stored = await db.execute(
        "INSERT INTO events_v1(scope,uuid,event) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM events_v1 WHERE scope=?) < 1000 ON CONFLICT(scope,uuid) DO NOTHING",
        [scope, event.id, body, scope]
      );
      if (!stored.changes && !(await db.query("SELECT seq FROM events_v1 WHERE scope=? AND uuid=?", [
        scope,
        event.id
      ])).rows.length)
        throw new BirdwatchError("queue_full", "The Exact outbox is full.");
    });
    return { id: event.id };
  }
  async function flush(sqlite) {
    const rows = await use(
      sqlite,
      (db) => db.query(
        "SELECT seq,event FROM events_v1 WHERE scope=? ORDER BY seq LIMIT 100",
        [scope]
      )
    );
    let accepted = 0, duplicates = 0;
    for (const [seq, raw] of rows.rows) {
      const event = JSON.parse(String(raw));
      try {
        const result = await capture(event);
        accepted += result.accepted;
        duplicates += result.duplicates;
      } catch (error) {
        if (!(error instanceof BirdwatchError && (error.status === 400 || error.status === 413)))
          throw error;
        await use(
          sqlite,
          (db) => db.execute("DELETE FROM events_v1 WHERE scope=? AND seq=?", [
            scope,
            String(seq)
          ])
        );
        throw error;
      }
      await use(
        sqlite,
        (db) => db.execute("DELETE FROM events_v1 WHERE scope=? AND seq=?", [
          scope,
          String(seq)
        ])
      );
    }
    return { accepted, duplicates };
  }
  return { enqueue, flush };
}

// ../sdk/src/utf8.ts
function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}

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

// exact/index.ts
function createExactClient(options) {
  const endpoint = captureEndpoint(options?.host);
  const key = stringField(options.writeKey, "writeKey", 128);
  const timeout = options.timeoutMs ?? 5e3;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 12e4)
    invalid("timeoutMs must be 1\u2013120000.");
  const request = options.fetch;
  if (typeof request !== "function") invalid("Pass Exact's scoped fetch.");
  function normalize(e) {
    return {
      id: stringField(e.id, "id", 128),
      event: stringField(e.event, "event", 128),
      distinctId: stringField(e.distinctId, "distinctId", 256),
      ...e.timestamp === void 0 ? {} : { timestamp: stringField(e.timestamp, "timestamp", 64) },
      properties: JSON.parse(
        snapshotProperties(e.properties === void 0 ? {} : e.properties)
      )
    };
  }
  async function captureBatch(events) {
    if (!Array.isArray(events) || events.length < 1 || events.length > 100)
      invalid("Send 1\u2013100 events per batch.");
    const batch = events.map((e) => {
      const row = normalize(e);
      return {
        uuid: row.id,
        event: row.event,
        distinct_id: row.distinctId,
        timestamp: row.timestamp,
        properties: row.properties
      };
    });
    const body = JSON.stringify({ api_key: key, batch });
    if (utf8Length(body) > 1048576)
      invalid("Batch exceeds the collector's 1 MiB request limit.");
    const res = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      exactTimeout: timeout
    });
    if (!res.ok)
      throw new BirdwatchError(
        "http",
        "Collector returned HTTP " + res.status,
        res.status
      );
    const ack = await res.json().catch(() => null);
    if (!ack || !Number.isSafeInteger(ack.accepted) || !Number.isSafeInteger(ack.duplicates) || ack.accepted < 0 || ack.duplicates < 0 || ack.accepted + ack.duplicates !== batch.length)
      throw new BirdwatchError(
        "invalid_response",
        "Collector returned an invalid acknowledgement."
      );
    return { accepted: ack.accepted, duplicates: ack.duplicates };
  }
  const capture = (event) => captureBatch([event]);
  return {
    captureBatch,
    capture,
    ...exactOutbox(JSON.stringify([endpoint, key]), capture, normalize)
  };
}
