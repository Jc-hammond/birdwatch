import type { CatalogShape, ClientOptions, EventCatalog, ServerClient } from "./types.js";
export { createBrowserClient } from "./browser.js";
export { BirdwatchError } from "./types.js";
export type { BatchCounts, BrowserClient, BrowserOptions, CaptureOptions, ClientOptions, ErrorCode, EventCatalog, Json, Properties, Receipt, ServerClient, ServerEvent, } from "./types.js";
export declare function createServerClient<C extends CatalogShape<C> = EventCatalog>(options: ClientOptions): ServerClient<C>;
