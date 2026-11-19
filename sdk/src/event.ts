import { utf8Length } from "./utf8.js";
import { BirdwatchError } from "./types.js";
import type { CaptureOptions } from "./types.js";

export function invalid(message: string): never {
  throw new BirdwatchError("invalid_input", message);
}

export function stringField(
  value: unknown,
  field: string,
  limit: number
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > limit ||
    /[\u0000\uD800-\uDFFF]/u.test(value)
  ) {
    invalid(
      `${field} must be a nonempty Unicode string of at most ${limit} characters.`
    );
  }
  return value;
}

export function newId(): string {
  // getRandomValues also works on non-secure local-network origins.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function snapshotProperties(value: unknown): string {
  if (!plainObject(value)) invalid("properties must be a plain JSON object.");
  try {
    const json = JSON.stringify(value, function (key, item: unknown) {
      // Inspect original containers as well: Date and custom toJSON can transform them.
      const original = this[key];
      if (
        typeof original === "object" &&
        original !== null &&
        !Array.isArray(original) &&
        !plainObject(original)
      ) {
        invalid(
          "properties must contain only JSON values. Convert dates to strings."
        );
      }
      if (
        typeof original?.toJSON === "function" ||
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol" ||
        typeof item === "bigint" ||
        (typeof item === "number" && !Number.isFinite(item))
      ) {
        invalid(
          "properties must contain only finite numbers, strings, booleans, null, arrays, or objects."
        );
      }
      return item;
    });
    // The Python collector measures compact JSON with ensure_ascii enabled.
    const asciiLength =
      json.length + 5 * (json.match(/[^\x00-\x7e]/g)?.length ?? 0);
    if (asciiLength > 32768)
      invalid("Encoded properties exceed the collector's 32 KiB limit.");
    return json;
  } catch (error) {
    if (error instanceof BirdwatchError) throw error;
    throw new BirdwatchError(
      "invalid_input",
      "properties must be an acyclic JSON object.",
      undefined,
      { cause: error }
    );
  }
}

function occurrenceTime(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  let time: number;
  let micros = "";
  if (value instanceof Date) {
    time = value.getTime();
  } else {
    const parts =
      typeof value === "string" &&
      /^(\d{4}-\d\d-\d\d)T(\d\d):\d\d(?::\d\d(?:\.(\d{1,6}))?)?(Z|[+-]\d\d:\d\d)$/.exec(
        value
      );
    if (!parts || Number(parts[2]) > 23)
      invalid(
        "timestamp must be a Date or an ISO 8601 timestamp with a time zone."
      );
    const day = new Date(parts[1] + "T00:00:00Z");
    if (
      !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== parts[1]
    )
      invalid("timestamp contains an invalid calendar date.");
    time = Date.parse(value as string);
    micros = (parts[3] ?? "").slice(3);
  }
  if (!Number.isFinite(time) || time > Date.now() + 300_000)
    invalid("Invalid or future timestamp (maximum clock skew 5 minutes).");
  const iso = new Date(time).toISOString();
  if (!/^\d{4}-/.test(iso) || iso.startsWith("0000-"))
    invalid("timestamp year must be between 1 and 9999.");
  return micros ? iso.slice(0, -1) + micros.padEnd(3, "0") + "Z" : iso;
}

export interface EncodedEvent {
  id: string;
  json: string;
  bytes: number;
}

export function encodeEvent(
  name: unknown,
  person: unknown,
  props: unknown,
  options: CaptureOptions
): EncodedEvent {
  if (!plainObject(options)) invalid("Capture options must be an object.");
  const id =
    options.id === undefined ? newId() : stringField(options.id, "id", 128);
  const metadata = {
    uuid: id,
    event: stringField(name, "event", 128),
    distinct_id: stringField(person, "distinctId", 256),
    timestamp: occurrenceTime(options.timestamp),
  };
  const properties = snapshotProperties(props === undefined ? {} : props);
  const json =
    JSON.stringify(metadata).slice(0, -1) + ',"properties":' + properties + "}";
  return { id, json, bytes: utf8Length(json) };
}
