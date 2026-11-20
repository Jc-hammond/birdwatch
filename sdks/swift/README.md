# Birdwatch for Swift

Download and unzip the Swift SDK from **Setup**. In Xcode, choose **File → Add Package Dependencies → Add Local**, select the folder containing `Package.swift`, and add the **Birdwatch** product to your target. In SwiftPM, use `.package(path: "../Birdwatch")` and add `.product(name: "Birdwatch", package: "Birdwatch")` to your target.

```swift
import Foundation
import Birdwatch

let analytics = try await BirdwatchClient(
    host: URL(string: "https://analytics.example.com")!,
    writeKey: "YOUR_PROJECT_WRITE_KEY"
)
try await analytics.identify("user-42")
let id = try await analytics.capture("checkout_completed",
    properties: ["orderId": "order-123", "total": 54], id: "checkout:order-123")
await analytics.reset()
```

## Save and send events

Keep a client alive from app startup. With disk persistence, `capture` returns the event ID when SQLite commits. With memory persistence it waits for collector acknowledgement. Pass the same occurrence ID for application-level retries. Call `await analytics.flush()` to attempt pending delivery and `await analytics.close()` when collection ends.

## Delivery and retries

On iOS 15+ and macOS 12+, the client automatically drains at startup, when Network.framework reports a usable path, and on a retry timer while the process can execute. A device that reconnects while the app is terminated syncs on its next launch. The collector treats an already accepted ID as a successful duplicate acknowledgement.

The default database lives in Application Support/Birdwatch and is excluded from backup. Queues and identities are scoped to the collector and project write key. Identity changes affect subsequent events. Set `persistence: .memory` to keep both ephemeral, or pass an `outboxURL` to explicitly select a disk database. Each project holds up to `maxQueueSize` pending events (default 1,000). When full, the queue drops its oldest events and reports overflow once through `onError`. A corrupt database is moved aside before delivery starts with an empty outbox. Other storage failures are returned to the caller.

The client sends up to 100 events per request and keeps their IDs and occurrence times across retries. It follows the collector’s `Retry-After` and uses exponential backoff with jitter. A partial acknowledgement retires the batch and sends each rejected event to `onError`. An unknown write key pauses delivery and preserves the outbox until restart. Entering the background triggers a flush. Use `await analytics.close()` to drain pending work and stop the client’s monitor and timers.

From the repository root on macOS, run `make test-swift` to build the package, check validation and run every shared SDK delivery scenario against a local collector.
