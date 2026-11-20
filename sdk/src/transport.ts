import { invalid, stringField } from "./event.js";
import { BirdwatchError } from "./types.js";
import type { ClientOptions, BatchCounts } from "./types.js";

function integer(
  value: number | undefined,
  initial: number,
  min: number,
  max: number,
  field: string
): number {
  if (value === undefined) return initial;
  if (!Number.isInteger(value) || value < min || value > max)
    invalid(`${field} must be an integer from ${min} to ${max}.`);
  return value;
}
const hostError = "Use an HTTP(S) host without credentials, query or fragment.";

export function captureEndpoint(host: string) {
  // Exact and React Native also run on hosts with partial WHATWG URL support.
  const match = typeof host === "string" &&
    /^https?:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/[^?#\\\s]*)?$/i.exec(host);
  if (!match || Number(match[1] ?? 0) > 65535)
    invalid(hostError);
  return host.replace(/\/+$/, "") + "/api/capture";
}

function browserEndpoint(host: string) {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return invalid(hostError);
  }
  return captureEndpoint(url.href);
}

export function configure(
  options: ClientOptions,
  endpointFor = browserEndpoint
) {
  if (!options || typeof options.host !== "string")
    invalid("Provide a host and project writeKey.");
  const endpoint = endpointFor(options.host);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function")
    invalid("A Fetch API implementation is required.");
  if (options.onError !== undefined && typeof options.onError !== "function")
    invalid("onError must be a function.");
  return {
    report(error: BirdwatchError) {
      try { void Promise.resolve(options.onError?.(error)).catch(() => {}); }
      catch { /* Observers do not change delivery outcomes. */ }
    },
    endpoint,
    key: stringField(options.writeKey, "writeKey", 128),
    fetch: fetcher,
    batchSize: integer(options.batchSize, 20, 1, 100, "batchSize"),
    flushInterval: integer(
      options.flushIntervalMs,
      150,
      0,
      60_000,
      "flushIntervalMs"
    ),
    maxQueue: integer(options.maxQueueSize, 1000, 1, 100_000, "maxQueueSize"),
    timeout: integer(options.timeoutMs, 5000, 1, 120_000, "timeoutMs"),
  };
}

export type Config = ReturnType<typeof configure>;

export class DeliveryFailure extends BirdwatchError {
  constructor(
    readonly outcome: "retry" | "pause" | "drop",
    status?: number,
    readonly retryAfter?: number
  ) {
    super("http", "Collector did not acknowledge this batch.", status);
  }
}

/** A rejected attempt uses Retry-After when available, otherwise full jitter. */
export function retryDelay(error: unknown, failures: number, random = Math.random) {
  if (error instanceof DeliveryFailure && error.retryAfter !== undefined) return error.retryAfter;
  return random() * (1000 * Math.min(60, 2 ** failures));
}

export function payload(key: string, rows: { json: string }[], sentAt = new Date().toISOString()) {
  return (
    '{"api_key":' +
    JSON.stringify(key) +
    ',"sent_at":"' +
    sentAt +
    '","batch":[' +
    rows.map((e) => e.json).join(",") +
    "]}"
  );
}

export async function send(
  config: Config,
  body: string,
  count: number,
  browser: boolean,
  keepalive: boolean,
  attemptTime?: number
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  try {
    const fetcher = config.fetch;
    const response = await fetcher(config.endpoint, {
      method: "POST",
      body,
      headers: { "Content-Type": browser ? "text/plain" : "application/json" },
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive,
      redirect: "error",
    });
    const ack = await response.json().catch(() => null);
    if (response.status !== 200) {
      const status = response.status;
      const header = response.headers.get("Retry-After");
      const wait =
        header === null
          ? NaN
          : /^\d+(\.\d+)?$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - (attemptTime ?? Date.now());
      const outcome =
        status >= 500 || status === 429 || status === 408
          ? "retry"
          : ack?.code === "unknown_key"
            ? "pause"
            : ack?.code === "invalid_event" || ack?.code === "too_large"
              ? "drop"
              : "retry";
      throw new DeliveryFailure(
        outcome,
        status,
        Number.isNaN(wait) ? undefined : Math.min(300000, Math.max(0, wait))
      );
    }
    const rejected = new Map<number, BirdwatchError>();
    const invalidAck = () =>
      new BirdwatchError(
        "invalid_response",
        "Invalid collector acknowledgement."
      );
    if (!Array.isArray(ack?.rejected ?? [])) throw invalidAck();
    for (const r of ack?.rejected ?? []) {
      if (
        !Number.isInteger(r?.index) ||
        r.index < 0 ||
        r.index >= count ||
        rejected.has(r.index) ||
        !["invalid_event", "too_large"].includes(r.code)
      )
        throw invalidAck();
      rejected.set(
        r.index,
        new BirdwatchError(
          "http",
          "The collector rejected this event.",
          r.code === "too_large" ? 413 : 400
        )
      );
    }
    if (
      !Number.isSafeInteger(ack?.accepted) ||
      ack.accepted < 0 ||
      !Number.isSafeInteger(ack.duplicates) ||
      ack.duplicates < 0 ||
      ack.accepted + ack.duplicates + rejected.size !== count
    )
      throw invalidAck();
    return {
      counts: Object.freeze({
        accepted: ack.accepted,
        duplicates: ack.duplicates,
      }) as BatchCounts,
      rejected,
    };
  } catch (error) {
    if (error instanceof BirdwatchError) throw error;
    throw new BirdwatchError(
      controller.signal.aborted ? "timeout" : "network",
      "Capture request failed."
    );
  } finally {
    clearTimeout(timer);
  }
}
