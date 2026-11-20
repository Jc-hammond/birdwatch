import { newId, invalid, snapshotProperties, stringField } from "../../sdk/src/event.js";
import { configure, payload, send } from "../../sdk/src/transport.js";
import {
  BirdwatchError,
  type BatchCounts,
  type ClientOptions,
  type Properties,
} from "../../sdk/src/types.js";
import { utf8Length } from "../../sdk/src/utf8.js";
import { exactOutbox } from "./outbox.js";
export { exactOutboxPath, type ExactSQLite, type QueuedExactEvent } from "./outbox.js";
export { BirdwatchError };
export type { BatchCounts, Properties };

export interface ExactEvent {
  id?: string;
  distinctId: string;
  event: string;
  properties?: Properties;
  timestamp?: string;
}
export interface ExactOptions
  extends Pick<ClientOptions, "host" | "writeKey" | "maxQueueSize" | "timeoutMs" | "onError"> {
  fetch: (
    url: string,
    init: RequestInit & { exactTimeout: number },
  ) => Promise<Pick<Response, "status" | "json"> & { headers?: Headers }>;
}

function normalize(event: ExactEvent) {
  const timestamp = event.timestamp;
  if (
    timestamp !== undefined &&
    (!/(Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
  )
    invalid("Use an ISO timestamp with a time zone.");
  return {
    id: stringField(event.id ?? newId(), "id", 128),
    event: stringField(event.event, "event", 128),
    distinctId: stringField(event.distinctId, "distinctId", 256),
    timestamp,
    properties: JSON.parse(snapshotProperties(event.properties ?? {})) as Properties,
  };
}

export function createExactClient(options: ExactOptions) {
  if (typeof options?.fetch !== "function") invalid("Pass Exact's scoped fetch.");
  const config = configure({
    ...options,
    fetch: async (url, init) => {
      const response = await options.fetch(String(url), { ...init, exactTimeout: options.timeoutMs ?? 5000 });
      return {
        status: response.status,
        json: () => response.json(),
        headers: response.headers ?? { get: () => null },
      } as Response;
    },
  });
  function report(error: BirdwatchError) {
    try {
      void Promise.resolve(config.onError?.(error)).catch(() => {});
    } catch {
      /* observers */
    }
  }
  function encoded(event: ExactEvent) {
    const row = normalize(event);
    return {
      json: JSON.stringify({
        uuid: row.id,
        event: row.event,
        distinct_id: row.distinctId,
        timestamp: row.timestamp,
        properties: row.properties,
      }),
    };
  }
  async function deliver(events: ExactEvent[], at: number, background: boolean) {
    const body = payload(config.key, events.map(encoded), new Date(at).toISOString());
    if (utf8Length(body) > 1048576) invalid("Limit the request to 1 MiB.");
    return send(config, body, events.length, false, background, at);
  }
  async function captureBatch(events: readonly ExactEvent[], at: number): Promise<BatchCounts> {
    if (!Array.isArray(events) || !events.length || events.length > 100)
      invalid("Send 1–100 events per batch.");
    const result = await deliver([...events], at, false);
    for (const error of result.rejected.values()) report(error);
    return result.counts;
  }
  return {
    captureBatch,
    capture: (event: ExactEvent, at: number) => captureBatch([event], at),
    ...exactOutbox(
      JSON.stringify([config.endpoint, config.key]),
      config.maxQueue,
      normalize,
      deliver,
      report,
    ),
  };
}
