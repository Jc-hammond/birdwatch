import type { CaptureOptions } from "./types.js";
export declare function invalid(message: string): never;
export declare function stringField(value: unknown, field: string, limit: number): string;
export declare function newId(): string;
export interface EncodedEvent {
    id: string;
    json: string;
    bytes: number;
}
export declare function encodeEvent(name: unknown, person: unknown, props: unknown, options: CaptureOptions): EncodedEvent;
