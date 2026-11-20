import { encodeEvent, invalid, type EncodedEvent } from "../../sdk/src/event.js";
import { captureEndpoint, configure, payload, send } from "../../sdk/src/transport.js";
import { BirdwatchError, type ClientOptions, type EventCatalog, type ServerEvent } from "../../sdk/src/types.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import { exactOutbox } from "./outbox.js";
export { BirdwatchError };
export { exactOutboxPath, type ExactStorage, type QueuedExactEvent } from "./outbox.js";
export type { BatchCounts, Properties } from "../../sdk/src/types.js";

export type ExactEvent = Omit<ServerEvent<EventCatalog>, "timestamp"> & { timestamp?: string };
export interface ExactOptions extends Pick<ClientOptions, "host" | "writeKey" | "maxQueueSize" | "timeoutMs" | "onError"> {
  fetch(url: string, init: RequestInit & { exactTimeout: number }): Promise<Response>;
}
function occurrence(value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 64 || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    invalid("Use an ISO timestamp with a time zone, up to 64 characters.");
  return value;
}
function encode(event: ExactEvent) {
  return encodeEvent(event.event, event.distinctId, event.properties, { id: event.id, timestamp: event.timestamp }, occurrence);
}
export function createExactClient(options: ExactOptions) {
  if (typeof options?.fetch !== "function") invalid("Pass Exact's scoped fetch.");
  const config = configure({
    ...options,
    fetch: (url, init) => options.fetch(String(url), { ...init, exactTimeout: options.timeoutMs ?? 5000 }),
  }, captureEndpoint);
  const overhead = utf8Length(payload(config.key, [], "2000-01-01T00:00:00.000Z"));
  function deliver(rows: EncodedEvent[], at: number, background: boolean) {
    return send(config, payload(config.key, rows, new Date(at).toISOString()), rows.length, false, background, at);
  }
  async function captureBatch(events: readonly ExactEvent[], at: number) {
    if (!Array.isArray(events) || !events.length || events.length > 100) invalid("Send 1–100 events per batch.");
    if (!Number.isFinite(at)) invalid("Pass epoch milliseconds from Contract.");
    const rows = events.map(encode);
    if (rows.reduce((size, row) => size + row.bytes + 1, overhead - 1) > 1048576) invalid("Limit the request to 1 MiB.");
    const result = await deliver(rows, at, false);
    for (const error of result.rejected.values()) config.report(error);
    return result.counts;
  }
  return {
    captureBatch,
    capture: (event: ExactEvent, at: number) => captureBatch([event], at),
    ...exactOutbox(JSON.stringify([config.endpoint, config.key]), config.maxQueue, overhead, encode, deliver, config.report),
  };
}
