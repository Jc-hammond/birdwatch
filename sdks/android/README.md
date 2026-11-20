# Birdwatch for Android

Use the Android SDK from Kotlin or Java on Android 7.0 (API 24) or later. It uses Android’s SQLite, networking, and connectivity APIs and has no third-party runtime dependencies.

Save `birdwatch-android-0.2.0.aar` in your app module’s `libs/` folder. Add it to `app/build.gradle.kts` and sync Gradle.

```kotlin
dependencies {
    implementation(files("libs/birdwatch-android-0.2.0.aar"))
}
```

## Save and send events

Create one client per project at application startup. Use the write key from Birdwatch **Setup** and an HTTPS collector URL your device can reach.

```kotlin
import dev.birdwatch.sdk.Birdwatch

val analytics = Birdwatch.open(applicationContext, "https://analytics.example.com", writeKey)

// Call after sign-in. SDK operations submitted to this client run in order.
analytics.identify("user-42")
val checkout = analytics.capture("checkout_completed", mapOf("orderId" to "order-123"), "checkout:order-123", null)
checkout.whenComplete { eventId, error ->
    if (error != null) android.util.Log.e("Analytics", "Could not save checkout", error)
}
```

`capture` returns a future containing the event ID after SQLite commits. Supply the same ID on an application retry or omit it to generate a UUID. An optional fourth argument is the occurrence time in epoch milliseconds. The SDK snapshots properties when capture is called. Properties support JSON primitives, string-keyed maps, lists, arrays and null.

Use `identify` and `reset` for subsequent captures, `onError` to register a background error handler, `flush` to attempt delivery, and `close` to flush and release resources. Android runs storage and delivery on worker threads. Dispatch UI updates to the main thread.

## Offline delivery

Events commit to SQLite in the app’s no-backup directory. The SDK sends up to 100 events per request. Each retry preserves the original ID, timestamp and properties. Opening the client, regaining connectivity or backgrounding the final activity triggers delivery. Unknown keys pause delivery and retain queued events until the next open. Network errors and unrecognised responses retry with full jitter, respecting Retry-After up to five minutes.

Queue capacity defaults to 1,000 events per collector and write key. Overflow drops the oldest events and reports once until delivery frees space. A damaged database is moved aside before collection resumes. The builder’s `onError` receives invalid input, rejection, overflow and storage errors. Invalid input completes the returned future exceptionally. Configure `maxQueueSize` and `timeoutMillis` (default 5,000) on the builder.

## Local development

Use `http://10.0.2.2:8123` to reach a host-machine collector from the standard Android Emulator. If Android blocks cleartext HTTP, configure your debug build to allow it for the development endpoint. Use a device-reachable HTTPS address for deployed apps. The AAR declares the normal `INTERNET` and `ACCESS_NETWORK_STATE` permissions.

## Build from source

In the source release, open `sdks/android/` in Android Studio, or run `./gradlew assembleRelease` there with JDK 17 and Android SDK Platform 35 installed. The AAR is written to `build/outputs/aar/`. Run `./gradlew testDebugUnitTest` with Node available to exercise the shared scenarios on the JVM. The SDK uses Android’s connection pool. Its JVM test driver substitutes an HTTP client and runs against the same local collector as the other SDKs. The SDK uses the Birdwatch MIT license. The Gradle wrapper’s license and notices are in `gradle/wrapper/`.
