import { BirdwatchError } from "./types.js";
import type { ClientOptions, BatchCounts } from "./types.js";
declare function browserEndpoint(host: string): string;
export declare function configure(options: ClientOptions, endpointFor?: typeof browserEndpoint): {
    onError: ((error: BirdwatchError) => void) | undefined;
    endpoint: string;
    key: string;
    fetch: typeof fetch;
    batchSize: number;
    flushInterval: number;
    maxQueue: number;
    timeout: number;
    retries: number;
};
export type Config = ReturnType<typeof configure>;
export declare const MAX_BODY_BYTES: number;
export declare function transmit(config: Config, body: string, count: number): Promise<BatchCounts>;
export {};
