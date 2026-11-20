import { encodeEvent, invalid, newId, snapshotProperties, type EncodedEvent } from "../../sdk/src/event.js";
import { captureEndpoint, configure, payload, send } from "../../sdk/src/transport.js";
import type { ClientOptions, EventCatalog, Properties, ServerEvent } from "../../sdk/src/types.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import { exactOutbox, type ExactStorage } from "./outbox.js";
export { exactOutboxPath, type ExactStorage } from "./outbox.js";
export { BirdwatchError, type BatchCounts, type Properties } from "../../sdk/src/types.js";

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
    return send(config, payload(config.key, rows, new Date(at).toISOString()), rows.length, false, background);
  }
  const box = exactOutbox(JSON.stringify([config.endpoint, config.key]), config.maxQueue, overhead, encode, deliver, config.report);
  let closing: Promise<void> | undefined;
  let admissions = Promise.resolve();
  function admit<T>(operation: () => Promise<T>) {
    open();
    const result = admissions.then(operation);
    admissions = result.then(() => {}, () => {});
    return result;
  }
  function open() { if (closing) invalid("The Exact client is closed."); }
  async function flush(ctx: ExactDeliveryContext) {
    await admissions;
    return box.flush(ctx.storage, ctx.sendTime, ctx.background, ctx.retryToken);
  }
  return {
    async capture(ctx: ExactContext, name: string, properties?: Properties, options: { id?: string; timestamp?: string } = {}) {
      open();
      if (!Number.isFinite(ctx.at)) invalid("Pass epoch milliseconds from Contract.");
      const event = { event: name, properties: JSON.parse(snapshotProperties(properties ?? {})),
        id: options.id ?? newId(), timestamp: options.timestamp ?? new Date(ctx.at).toISOString() };
      return admit(() => box.enqueue(event, ctx.storage));
    },
    async identify(ctx: ExactContext, id: string) { await admit(() => box.identify(ctx.storage, id)); },
    async reset(ctx: ExactContext) { await admit(() => box.identify(ctx.storage, newId())); },
    async flush(ctx: ExactDeliveryContext): Promise<ExactFlushResult> { open(); return flush(ctx); },
    close(ctx: ExactDeliveryContext) { return closing ??= flush(ctx).then(() => {}); },
    onError: config.onError,
  };
}

/** Contract supplies its granted storage and the current action clock to each answer. */
export interface ExactContext {
  storage: ExactStorage;
  at: number;
}

export interface ExactDeliveryContext {
  storage: ExactStorage;
  sendTime: () => number | Promise<number>;
  background?: boolean;
  retryToken?: number;
}

export interface ExactFlushResult {
  accepted: number;
  duplicates: number;
  retryAfterMs: number;
  retryAtMs: number;
  retryToken: number;
}
