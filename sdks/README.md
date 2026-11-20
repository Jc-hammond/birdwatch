# Birdwatch SDKs

Open your Birdwatch project’s **Setup** page to download an SDK and copy your write key. Use an HTTPS Birdwatch URL reachable from the device. On a phone, `localhost` points to the phone itself.

`capture` returns the event ID after a local durable commit or, for an in-memory queue, collector acknowledgement.

| SDK | Install | Delivery |
| --- | --- | --- |
| [Browser and Node](../sdk/README.md) | Download the npm tarball from Setup, or embed the browser script | Optional browser persistence and per-request server identity |
| [React Native](react-native/README.md) | Download the npm tarball from Setup | Typed events and screen views, with a queue that survives app restarts |
| [Expo Exact](exact/README.md) | Download the npm tarball from Setup | Events from Contract data answers, with a SQLite queue |
| [Swift](swift/README.md) | Add the extracted Swift package in Xcode | Queue events offline on iOS or macOS and replay on reconnection |
| [Android](android/README.md) | Add the AAR to your app module | Events from Kotlin and Java, with delivery that resumes when the device reconnects |

Use the same signed-in user ID across apps to see a person’s activity together. If two apps report the same action, use the same event ID so Birdwatch counts it once.

## Client methods

All six methods operate on the client returned by the platform’s factory. Browser, Node and React Native capture options carry an optional `id` and `timestamp`. Node also accepts `distinctId` per capture so concurrent requests can share a client. Exact receives the Contract answer’s granted storage and clock in `ctx`.

| SDK | Capture | Identity | Delivery and errors |
| --- | --- | --- | --- |
| Browser and script | `capture(name, properties?, options?): Promise<string>` | `identify(id, traits?): void`, `reset(): void` | `flush(): Promise<void>`, `close(): Promise<void>`, `onError(handler): void` |
| Node | `capture(name, properties?, options?): Promise<string>` | `identify(id, traits?): void`, `reset(): void` | `flush(): Promise<void>`, `close(): Promise<void>`, `onError(handler): void` |
| React Native | `capture(name, properties?, options?): Promise<string>` | `identify(id, traits?): Promise<void>`, `reset(): Promise<void>` | `flush(): Promise<void>`, `close(): Promise<void>`, `onError(handler): void` |
| Swift | `capture(_:properties:id:timestamp:) async throws -> String` | `identify(_:traits:) throws`, `reset()` | `flush() async`, `close() async`, `onError(_:)` |
| Android | `capture(name[, properties[, id, timestampMillis]]): CompletableFuture<String>` | `identify(id[, traits]): CompletableFuture<Void>`, `reset(): CompletableFuture<String>` | `flush(): CompletableFuture<Void>`, `close(): CompletableFuture<Void>`, `onError(handler): void` |
| Expo Exact | `capture(ctx, name, properties?, options?): Promise<string>` | `identify(ctx, id, traits?): Promise<void>`, `reset(ctx): Promise<void>` | `flush(ctx): Promise<ExactFlushResult>`, `close(ctx): Promise<void>`, `onError(handler): void` |

Exact’s delivery context contains `storage` and a `sendTime` callback supplied by Contract. Its flush result carries acknowledgement counts and a retry token for scheduling in Contract. The packaged example passes fresh action time on every send.

## Build and test the SDKs

From the repository root, run `make js-sdk` to build the JavaScript adapters. Run `make build` to regenerate the offline downloads in `static/assets/`. The Exact package includes a complete sample app.

After building, run `node --test sdks/test/*.test.mjs` from the project root. Run `swift test` from `sdks/swift/`.
