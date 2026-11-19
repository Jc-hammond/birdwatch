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
function browserEndpoint(host: string) {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return invalid("host must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid(
      "host must be an HTTP(S) URL without credentials, a query, or a fragment."
    );
  url.pathname = url.pathname.replace(/\/+$/, "") + "/api/capture";
  return url.href;
}

export function configure(options: ClientOptions, endpointFor = browserEndpoint) {
  if (!options || typeof options.host !== "string")
    invalid("Provide a host and project writeKey.");
  const endpoint = endpointFor(options.host);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function")
    invalid("A Fetch API implementation is required.");
  if (options.onError !== undefined && typeof options.onError !== "function")
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
      60_000,
      "flushIntervalMs"
    ),
    maxQueue: integer(options.maxQueueSize, 1000, 1, 100_000, "maxQueueSize"),
    timeout: integer(options.timeoutMs, 5000, 1, 120_000, "timeoutMs"),
    retries: integer(options.maxRetries, 2, 0, 5, "maxRetries"),
  };
}

export type Config = ReturnType<typeof configure>;
export const MAX_BODY_BYTES = 48 * 1024;

class HttpFailure extends BirdwatchError {
  constructor(status: number, message: string, readonly retryAfter: number) {
    super("http", message, status);
  }
}

function retryDelay(header: string | null): number {
  if (header === null) return 0;
  const ms = /^\d+(\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - Date.now();
  return Number.isNaN(ms) ? 0 : Math.max(0, ms);
}

async function attempt(
  config: Config,
  body: string,
  count: number
): Promise<BatchCounts> {
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
      redirect: "error",
    });
    if (!response.ok) {
      let detail;
      try {
        detail = (await response.json()).error;
      } catch {
        /* Proxies may return HTML. */
      }
      throw new HttpFailure(
        response.status,
        typeof detail === "string"
          ? detail
          : `Collector returned HTTP ${response.status}.`,
        retryDelay(response.headers.get("Retry-After"))
      );
    }
    const ack = await response.json().catch(() => null);
    if (
      !ack ||
      !Number.isSafeInteger(ack.accepted) ||
      !Number.isSafeInteger(ack.duplicates) ||
      ack.accepted < 0 ||
      ack.duplicates < 0 ||
      ack.accepted + ack.duplicates !== count
    ) {
      throw new BirdwatchError(
        "invalid_response",
        "Collector returned an invalid acknowledgement."
      );
    }
    return Object.freeze({
      accepted: ack.accepted,
      duplicates: ack.duplicates,
    });
  } catch (cause) {
    if (controller.signal.aborted)
      throw new BirdwatchError(
        "timeout",
        "Capture request timed out.",
        undefined,
        { cause }
      );
    if (cause instanceof BirdwatchError) throw cause;
    throw new BirdwatchError(
      "network",
      "Could not reach the Birdwatch collector.",
      undefined,
      { cause }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function transmit(
  config: Config,
  body: string,
  count: number
): Promise<BatchCounts> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt(config, body, count);
    } catch (error) {
      const http = error instanceof HttpFailure;
      const transient = http
        ? error.status === 408 || error.status === 429 || error.status! >= 500
        : error instanceof BirdwatchError &&
          ["network", "timeout", "invalid_response"].includes(error.code);
      if (!transient || retry === config.retries) throw error;
      const delay = Math.max(
        http ? error.retryAfter : 0,
        (0.5 + Math.random() / 2) * 200 * 2 ** retry
      );
      // A long Retry-After ends delivery explicitly rather than retrying too early.
      if (delay > 30_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
