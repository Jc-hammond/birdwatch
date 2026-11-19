import { type IdentityStorage } from "./outbox.js";
export type { IdentityStorage } from "./outbox.js";
import type { ClientOptions, CatalogShape, EventCatalog, EventName, CaptureArgs, CaptureOptions, Lifecycle, Receipt } from "../../sdk/src/types.js";
import { BirdwatchError } from "../../sdk/src/types.js";
export { BirdwatchError };
export type { Receipt, CaptureOptions, Properties, } from "../../sdk/src/types.js";
export interface NativeOptions extends ClientOptions {
    /** Defaults to AsyncStorage. Pass null for memory-only collection. */
    storage?: IdentityStorage | null;
    /** Optionally notify the SDK immediately when network connectivity returns. */
    subscribeConnectivity?: (listener: (online: boolean) => void) => () => void;
    /** For example, Expo Crypto's randomUUID on hosts without Web Crypto. */
    randomUUID?: () => string;
}
export interface NativeClient<C extends CatalogShape<C>> extends Lifecycle {
    readonly distinctId: string;
    identify(distinctId: string): Promise<void>;
    reset(): Promise<void>;
    capture<N extends EventName<C>>(event: N, ...args: CaptureArgs<C[N]>): Promise<Receipt>;
    /** Resolve on local commit, even when the collector is unreachable. */
    enqueue<N extends EventName<C>>(event: N, ...args: CaptureArgs<C[N]>): Promise<{
        id: string;
    }>;
    screen(name: string, options?: CaptureOptions): Promise<Receipt>;
}
export declare function createReactNativeClient<C extends CatalogShape<C> = EventCatalog>(options: NativeOptions): Promise<NativeClient<C>>;
