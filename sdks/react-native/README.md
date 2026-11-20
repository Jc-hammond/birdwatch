# Birdwatch for React Native

Download the React Native SDK from **Setup** and save it in your app directory. In an Expo project, run these commands to install the package, AsyncStorage 2.x, and the UUID helper.

```sh
npx expo install expo-crypto @react-native-async-storage/async-storage
npm install ./birdwatch-react-native-0.2.0.tgz
```

```ts
import { createReactNativeClient } from "@birdwatch/react-native";
import { randomUUID } from "expo-crypto";

type Events = { checkout_completed: { orderId: string; total: number } };
const analytics = await createReactNativeClient<Events>({
  host: "https://analytics.example.com", writeKey: "YOUR_PROJECT_WRITE_KEY", randomUUID,
});

await analytics.identify("user-42");
const { id } = await analytics.enqueue("checkout_completed",
  { orderId: "order-123", total: 54 }, { id: "checkout:order-123" });
// The checkout is saved locally. Navigation can continue while delivery is pending.
await analytics.reset(); // Queued events retain the identity used at capture.
```

## Client setup

React Native 0.65 introduced the removable AppState subscription used here and is the minimum supported by the AsyncStorage 2.2 peer. The SDK bundles its Birdwatch code and uses the host app’s native modules.

Create one client per project at app startup and retain it while collection is enabled. React Native uses AsyncStorage by default. You can supply an adapter with async `getItem` and `setItem`. Pass `storage: null` for an ephemeral client. A secure `randomUUID` option is required on hosts without `crypto.randomUUID`.

## Save and send events

`enqueue` resolves with the event ID after a local commit. `capture` and `screen` also save before sending and resolve with a collector receipt. A transient delivery error can reject those calls while the event remains queued. Pass a stable occurrence ID when retrying an application action. For explicit screen tracking, call `await analytics.screen("Checkout")`.

## Delivery and retries

The SDK stores one event per AsyncStorage entry. A small header commits queue changes after the event bytes are safe. On first open, an existing queue is converted to individual entries. Damaged data is moved aside and reported through `onError`. Storage adapters can implement `multiGet`, `multiRemove` and `removeItem` for batched native storage operations.

Each request sends up to 100 events within the collector’s byte limit. The client retries transient failures with full jitter and honors Retry-After up to five minutes. Unknown keys pause sends until restart. Each rejected event is reported once. The default capacity is 1,000 events; overflow drops the oldest and reports once until a successful flush frees space.

The client replays on launch, AppState changes and connectivity notifications. Your app can pass `subscribeConnectivity: listener => NetInfo.addEventListener(state => listener(state.isInternetReachable === true))`. Backgrounding also sends events whose foreground acknowledgement is outstanding. Each retry uses the original event ID and timestamp.

`flush()` attempts outstanding delivery. `shutdown()` removes listeners and attempts a final drain. A failed drain leaves events on disk. Set `maxRetries` to control how many transient attempts a caller’s capture receipt waits through. Durable replay continues as long as the client is open.
