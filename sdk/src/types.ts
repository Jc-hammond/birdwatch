export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Properties = { [key: string]: Json };
export type EventCatalog = Record<string, Properties>;

// A mapped constraint also accepts ordinary named interfaces without index signatures.
export type CatalogShape<C> = { [K in keyof C]: object };
export type EventName<C> = Extract<keyof C, string>;

export interface ClientOptions {
  /** Origin of the collector. A reverse-proxy path prefix is also supported. */
  host: string;
  writeKey: string;
  /** Start sending at this many queued events. Default 20, maximum 100. */
  batchSize?: number;
  /** Maximum wait before sending the first queued event. Default 150 ms. */
  flushIntervalMs?: number;
  /** Includes in-flight events. Default 1,000. */
  maxQueueSize?: number;
  /** Per HTTP attempt, including reading its response. Default 5,000 ms. */
  timeoutMs?: number;
  /** Observes each failed capture, including background delivery. */
  onError?: (error: BirdwatchError) => void;
  /** Use for a custom network environment or a test transport. */
  fetch?: typeof globalThis.fetch;
}

export interface BrowserOptions extends ClientOptions {
  /** Store unacknowledged events in browser storage. Default false. */
  persist?: boolean;
  /** The default reuses the existing browser tracker's per-project identity. */
  persistence?: "localStorage" | "memory";
}

export interface CaptureOptions {
  /** Supply the same ID to deduplicate application-level retries. */
  id?: string;
  /** Event occurrence time. Defaults to the instant capture is called. */
  timestamp?: Date | string;
}

export interface BatchCounts {
  readonly accepted: number;
  readonly duplicates: number;
}

export interface Receipt {
  /** This event is present in the collector, including after a deduplicated retry. */
  readonly id: string;
  /** Counts for the entire HTTP batch containing this event. */
  readonly batch: Readonly<BatchCounts>;
}

export interface Lifecycle {
  flush(): Promise<void>;
  close(): Promise<void>;
  onError(handler: (error: BirdwatchError) => void): void;
}
export type CaptureArgs<P, O = CaptureOptions> = {} extends P
  ? [properties?: P, options?: O]
  : [properties: P, options?: O];

export interface BrowserClient<C extends CatalogShape<C> = EventCatalog> extends Lifecycle {
  identify(distinctId: string, traits?: Properties): void;
  reset(): void;
  capture<N extends EventName<C>>(name: N, ...args: CaptureArgs<C[N]>): Promise<string>;
}

export type ServerEvent<C> = {
  [N in EventName<C>]: CaptureOptions & {
    event: N;
    distinctId: string;
  } & ({} extends C[N] ? { properties?: C[N] } : { properties: C[N] });
}[EventName<C>];

export interface ServerClient<C extends CatalogShape<C> = EventCatalog> extends Lifecycle {
  identify(distinctId: string, traits?: Properties): void;
  reset(): void;
  capture<N extends EventName<C>>(name: N, ...args: CaptureArgs<C[N], CaptureOptions & { distinctId?: string }>): Promise<string>;
}

export type ErrorCode =
  | "invalid_input"
  | "queue_full"
  | "storage"
  | "closed"
  | "network"
  | "timeout"
  | "http"
  | "invalid_response";

export class BirdwatchError extends Error {
  readonly name = "BirdwatchError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
