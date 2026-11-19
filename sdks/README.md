# Mobile and Exact SDKs

Use the project's public write key from **Setup** and the address your app can reach. On a physical device, localhost points to the device. Use a reachable HTTPS collector URL for distributed apps. Each SDK sends explicit events to your own Birdwatch instance.

| SDK | Install | Delivery |
| --- | --- | --- |
| [React Native](react-native/README.md) | Download the npm tarball from Setup | Typed captures, screen views, identity storage and durable offline capture and lifecycle-aware batching |
| [Expo Exact](exact/README.md) | Download the npm tarball from Setup | Call from an Exact data answer with a scoped fetch grant and a persistent SQLite queue |
| [Swift](swift/README.md) | Add the extracted Swift package in Xcode | Queue events offline on iOS or macOS and replay on reconnection |
| [Android](android/README.md) | Add the AAR to your app module | Native Kotlin and Java event capture with a SQLite outbox and connectivity-triggered replay |

For a journey that spans clients, use the same signed-in distinct ID and event names. Supply a shared occurrence ID only when two clients are reporting the same action and you want it counted once.

To rebuild the JS adapters from this source tree, run `npm ci` inside `sdk/`, then run `node sdks/build.mjs` from the project root. Use `npm pack` in each adapter directory to create its installable tarball. The Exact package includes a complete sample app.

After building, run `node --test sdks/test/*.test.mjs` from the project root. Run `swift test` from `sdks/swift/`.
