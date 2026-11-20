# Mobile and Exact SDKs

Open your Birdwatch project’s **Setup** page to download an SDK and copy your write key. Use an HTTPS Birdwatch URL reachable from the device. On a phone, `localhost` points to the phone itself.

Use `enqueue` to save an event on the device, including while offline. Each guide describes when its SDK sends queued events.

| SDK | Install | Delivery |
| --- | --- | --- |
| [React Native](react-native/README.md) | Download the npm tarball from Setup | Typed events and screen views, with a queue that survives app restarts |
| [Expo Exact](exact/README.md) | Download the npm tarball from Setup | Events from Contract data answers, with a SQLite queue |
| [Swift](swift/README.md) | Add the extracted Swift package in Xcode | Queue events offline on iOS or macOS and replay on reconnection |
| [Android](android/README.md) | Add the AAR to your app module | Events from Kotlin and Java, with delivery that resumes when the device reconnects |

Use the same signed-in user ID across apps to see a person’s activity together. If two apps report the same action, use the same event ID so Birdwatch counts it once.

## Build and test the SDKs

From the repository root, run `make js-sdk` to build the JavaScript adapters. Run `make build` to regenerate the offline downloads in `static/assets/`. The Exact package includes a complete sample app.

After building, run `node --test sdks/test/*.test.mjs` from the project root. Run `swift test` from `sdks/swift/`.
