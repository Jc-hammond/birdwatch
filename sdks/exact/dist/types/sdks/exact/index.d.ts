export { exactOutboxPath, type ExactSQLite, type QueuedExactEvent, } from "./outbox.js";
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
    fetch: (url: string, init: {
        method: "POST";
        headers: Record<string, string>;
        body: string;
        exactTimeout: number;
    }) => Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
    }>;
    timeoutMs?: number;
}
export declare function createExactClient(options: ExactOptions): {
    enqueue: (input: import("./outbox.js").QueuedExactEvent, sqlite: import("./outbox.js").ExactSQLite) => Promise<{
        id: string;
    }>;
    flush: (sqlite: import("./outbox.js").ExactSQLite) => Promise<BatchCounts>;
    captureBatch: (events: readonly ExactEvent[]) => Promise<BatchCounts>;
    capture: (event: ExactEvent) => Promise<BatchCounts>;
};
