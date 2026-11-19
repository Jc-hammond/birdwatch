import type { BatchCounts } from "../../sdk/src/types.js";
import type { ExactEvent } from "./index.js";
export declare const exactOutboxPath = "app:/data/birdwatch.sqlite";
interface Database {
    execute(sql: string, params?: string[]): Promise<{
        changes: number;
    }>;
    query(sql: string, params?: string[]): Promise<{
        rows: unknown[][];
    }>;
    close(): Promise<void>;
}
export interface ExactSQLite {
    open(path: string): Promise<Database>;
}
export interface QueuedExactEvent extends ExactEvent {
    timestamp: string;
}
export declare function exactOutbox(scope: string, capture: (event: ExactEvent) => Promise<BatchCounts>, normalize: (event: ExactEvent) => ExactEvent): {
    enqueue: (input: QueuedExactEvent, sqlite: ExactSQLite) => Promise<{
        id: string;
    }>;
    flush: (sqlite: ExactSQLite) => Promise<BatchCounts>;
};
export {};
