import { type EncodedEvent } from "./event.js";
import type { CaptureOptions, ClientOptions, Receipt } from "./types.js";
export declare class DeliveryQueue {
    private readonly config;
    private readonly prefix;
    private readonly overhead;
    private readonly waiting;
    private readonly pending;
    private timer?;
    private running;
    private closing?;
    constructor(options: ClientOptions, endpointFor?: (host: string) => string);
    capture(name: unknown, person: unknown, props: unknown, options?: CaptureOptions): Promise<Receipt>;
    /** Deliver a previously validated snapshot without consulting the device clock again. */
    captureEncoded(event: EncodedEvent): Promise<Receipt>;
    private observe;
    private enqueue;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    private drain;
    private deliver;
}
