import type { BrowserClient, BrowserOptions, CatalogShape, EventCatalog } from "./types.js";
export declare function createBrowserClient<C extends CatalogShape<C> = EventCatalog>(options: BrowserOptions): BrowserClient<C>;
