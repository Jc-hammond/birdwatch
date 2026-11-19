# Birdwatch for Swift

Download and unzip the Swift SDK from **Setup**. In Xcode, choose **File → Add Package Dependencies → Add Local**, select the folder containing `Package.swift`, and add the **Birdwatch** product to your target. In SwiftPM, use `.package(path: "../Birdwatch")` and add `.product(name: "Birdwatch", package: "Birdwatch")` to your target.

```swift
import Foundation
import Birdwatch

let analytics = try BirdwatchClient(
    host: URL(string: "https://analytics.example.com")!,
    writeKey: "YOUR_PROJECT_WRITE_KEY"
)
try await analytics.identify("user-42")
let id = try await analytics.enqueue("checkout_completed",
    properties: ["orderId": "order-123", "total": 54], id: "checkout:order-123")
await analytics.reset()
```

## Save and send events

Keep a client alive from app startup. `enqueue` returns the event ID after SQLite commits the original timestamp, identity and properties. It works offline. `capture` and `screen` also persist before sending and return a collector receipt. A transient failure can throw while the event stays queued. `flush()` explicitly attempts pending delivery. Use the same occurrence ID for application-level retries.

## Delivery and retries

On iOS 15+ and macOS 12+, the client automatically drains at startup, when Network.framework reports a usable path, and on a retry timer while the process can execute. A device that reconnects while the app is terminated syncs on its next launch. The collector treats an already accepted ID as a successful duplicate acknowledgement.

The default database lives in Application Support/Birdwatch and is excluded from backup. Queues and identities are scoped to the collector and project write key. Identity changes affect subsequent events. Set `persistence: .memory` to keep both ephemeral, or pass an `outboxURL` to explicitly select a disk database. Each project holds up to `maxQueueSize` pending events (default 1,000). Full queues and write failures throw without evicting older events.

Per-request retries reuse the encoded body. Configure `timeout` in seconds and `maxRetries` for transient failures. HTTP 400 and 413 retire a rejected event. Other unsuccessful responses preserve it. An acknowledged event is removed only after the local deletion commits. A device must be able to reach its configured collector URL.

Run `swift test` from the package directory. Set `BIRDWATCH_TEST_HOST` and `BIRDWATCH_TEST_KEY` to exercise a live collector as well.
