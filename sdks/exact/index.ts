import { exactOutbox } from "./outbox.js";
export {
  exactOutboxPath,
  type ExactSQLite,
  type QueuedExactEvent,
} from "./outbox.js";
import { captureEndpoint } from "../endpoint.js";
import {
  invalid,
  snapshotProperties,
  stringField,
} from "../../sdk/src/event.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import { BirdwatchError } from "../../sdk/src/types.js";
import type { BatchCounts, Properties } from "../../sdk/src/types.js";
export { BirdwatchError };
export type { BatchCounts, Properties };

export interface ExactEvent {
  /** Stable per occurrence within this Birdwatch project. Keep it when retrying. */
  id: string;
  distinctId: string;
  event: string;
  properties?: Properties;
  /** ISO 8601 with timezone. Omit to use the collector's clock. */
  timestamp?: string;
}
export interface ExactOptions {
  host: string;
  writeKey: string;
  /** Pass the fetch in your app.ts answer scope so Exact enforces your grant. */
  fetch: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      exactTimeout: number;
    }
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  timeoutMs?: number;
}
export function createExactClient(options: ExactOptions) {
  const endpoint = captureEndpoint(options?.host);
  const key = stringField(options.writeKey, "writeKey", 128);
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
    invalid("timeoutMs must be 1–120000.");
  const request = options.fetch;
  if (typeof request !== "function") invalid("Pass Exact's scoped fetch.");
  function normalize(e: ExactEvent): ExactEvent {
    return {
      id: stringField(e.id, "id", 128),
      event: stringField(e.event, "event", 128),
      distinctId: stringField(e.distinctId, "distinctId", 256),
      ...(e.timestamp === undefined
        ? {}
        : { timestamp: stringField(e.timestamp, "timestamp", 64) }),
      properties: JSON.parse(
        snapshotProperties(e.properties === undefined ? {} : e.properties)
      ),
    };
  }
  async function captureBatch(
    events: readonly ExactEvent[]
  ): Promise<BatchCounts> {
    if (!Array.isArray(events) || events.length < 1 || events.length > 100)
      invalid("Send 1–100 events per batch.");
    const batch = events.map((e) => {
      const row = normalize(e);
      return {
        uuid: row.id,
        event: row.event,
        distinct_id: row.distinctId,
        timestamp: row.timestamp,
        properties: row.properties,
      };
    });
    const body = JSON.stringify({ api_key: key, batch });
    if (utf8Length(body) > 1048576)
      invalid("Batch exceeds the collector's 1 MiB request limit.");
    const res = await request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      exactTimeout: timeout,
    });
    if (!res.ok)
      throw new BirdwatchError(
        "http",
        "Collector returned HTTP " + res.status,
        res.status
      );
    const ack = (await res.json().catch(() => null)) as BatchCounts | null;
    if (
      !ack ||
      !Number.isSafeInteger(ack.accepted) ||
      !Number.isSafeInteger(ack.duplicates) ||
      ack.accepted < 0 ||
      ack.duplicates < 0 ||
      ack.accepted + ack.duplicates !== batch.length
    )
      throw new BirdwatchError(
        "invalid_response",
        "Collector returned an invalid acknowledgement."
      );
    return { accepted: ack.accepted, duplicates: ack.duplicates };
  }
  const capture = (event: ExactEvent) => captureBatch([event]);
  return {
    captureBatch,
    capture,
    ...exactOutbox(JSON.stringify([endpoint, key]), capture, normalize),
  };
}
