export interface IdentityStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}
export interface WireEvent {
    uuid: string;
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
    timestamp: string;
}
export declare class Outbox {
    private storage;
    private key;
    private capacity;
    private memory;
    constructor(storage: IdentityStorage | null, key: string, capacity: number);
    private run;
    private load;
    private save;
    list(): Promise<WireEvent[]>;
    put(row: WireEvent): Promise<WireEvent>;
    remove(id: string): Promise<void>;
}
