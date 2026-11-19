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

Create one client per project at app startup and retain it while collection is enabled. React Native uses AsyncStorage by default. You can supply an adapter with async `getItem` and `setItem`. Pass `storage: null` for an ephemeral client. A secure `randomUUID` option is required on hosts without `crypto.randomUUID`.

## Save and send events

`enqueue` resolves with the event ID after a local commit. `capture` and `screen` also save before sending and resolve with a collector receipt. A transient delivery error can reject those calls while the event remains queued. Pass a stable occurrence ID when retrying an application action. For explicit screen tracking, call `await analytics.screen("Checkout")`.

## Delivery and retries

The client replays pending events on launch and AppState transitions. While it can execute, a retry timer backs off to one minute. If your app already observes connectivity, pass `subscribeConnectivity: listener => NetInfo.addEventListener(state => listener(state.isInternetReachable === true))` to wake it immediately. Terminating the app preserves its queue. Reopening it resumes delivery.

`flush()` attempts delivery of outstanding events. `shutdown()` removes listeners and attempts a final drain. A failed drain preserves pending events. HTTP 400 and 413 for an individual event are terminal input errors. Authentication failures leave queued events available for retry with the same project configuration. Use `onError` to observe failed transport attempts.

Each collector and write key has a separate queue. Its default capacity is 1,000 events with a 1 MiB serialized limit. New writes reject on overflow or storage failure. Earlier entries stay in place. `maxQueueSize`, `batchSize`, `flushIntervalMs`, `maxRetries`, and `timeoutMs` tune delivery.
