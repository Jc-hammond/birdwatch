import Foundation
import Network
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum BirdwatchError: Error, Equatable {
    case invalidInput(String)
    case http(Int)
    case queueFull
    case storage(String)
    case invalidAcknowledgement
}

public struct Receipt: Sendable, Equatable {
    public let id: String
    public let accepted: Int
    public let duplicates: Int
}

private struct Counts: Decodable { let accepted: Int; let duplicates: Int }
private struct Capture: Encodable {
    let api_key: String
    let uuid: String
    let distinct_id: String
    let event: String
    let properties: [String: JSONValue]
    let timestamp: String
}

private func checked(_ value: String, _ limit: Int, _ label: String) throws -> String {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !value.utf8.contains(0), value.unicodeScalars.count <= limit else {
        throw BirdwatchError.invalidInput(label)
    }
    return value
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Create one client per project. Await a capture to receive the collector's acknowledgement.
public actor BirdwatchClient {
    public enum Persistence: Sendable { case userDefaults, memory }
    private let endpoint: URL
    private let writeKey: String
    private let session: URLSession
    private let persistenceKey: String?
    private let outbox: Outbox
    private let monitor = NWPathMonitor()
    private var active: [Int64: Task<Receipt, Error>] = [:]
    private var timer: Task<Void, Never>?
    private var retrySeconds = 1
    private var notBefore = Date.distantPast
    private let maxRetries: Int
    public private(set) var distinctId: String

    public init(host: URL, writeKey: String, persistence: Persistence = .userDefaults,
                timeout: TimeInterval = 5, maxRetries: Int = 2, session: URLSession? = nil,
                outboxURL: URL? = nil, maxQueueSize: Int = 1000) throws {
        guard let parts = URLComponents(url: host, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let name = parts.host, !name.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil else { throw BirdwatchError.invalidInput("host") }
        guard (0...5).contains(maxRetries), timeout.isFinite, timeout > 0, timeout <= 120 else {
            throw BirdwatchError.invalidInput("retry or timeout configuration")
        }
        self.maxRetries = maxRetries
        self.endpoint = host.appendingPathComponent("api/capture")
        self.writeKey = try checked(writeKey, 128, "writeKey")
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        self.session = session ?? URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        self.persistenceKey = persistence == .userDefaults ? "birdwatch.identity.\(self.endpoint.absoluteString)|\(writeKey)" : nil
        var file = outboxURL
        if file == nil && persistence == .userDefaults {
            var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true).appendingPathComponent("Birdwatch", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            file = directory.appendingPathComponent("outbox.sqlite3")
        }
        let scope = try JSONEncoder().encode([self.endpoint.absoluteString, writeKey])
        self.outbox = try Outbox(file: file, scope: String(decoding: scope, as: UTF8.self), capacity: maxQueueSize)
        if let key = persistenceKey, let saved = UserDefaults.standard.string(forKey: key) {
            self.distinctId = try checked(saved, 256, "saved identity")
        } else {
            self.distinctId = UUID().uuidString
            if let key = persistenceKey { UserDefaults.standard.set(distinctId, forKey: key) }
        }
        Task { [weak self] in await self?.startReplay() }
    }

    private func startReplay() {
        monitor.pathUpdateHandler = { [weak self] path in
            if path.status == .satisfied { Task { await self?.wake() } }
        }
        monitor.start(queue: DispatchQueue(label: "birdwatch.connectivity"))
        schedule(after: 0)
    }
    deinit { monitor.cancel(); timer?.cancel() }

    private func schedule(after seconds: Double) {
        guard timer == nil else { return }
        let delay = max(seconds, notBefore.timeIntervalSinceNow)
        timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(min(delay, 86400) * 1_000_000_000)) }
            catch { return }
            await self?.wake()
        }
    }
    private func wake() async {
        timer?.cancel()
        timer = nil
        if notBefore > Date() { schedule(after: 0); return }
        do { try await flush() } catch { scheduleRetry() }
    }
    private func scheduleRetry() {
        schedule(after: Double(retrySeconds))
        retrySeconds = min(60, retrySeconds * 2)
    }
    public func identify(_ person: String) throws {
        distinctId = try checked(person, 256, "distinctId")
        if let key = persistenceKey { UserDefaults.standard.set(person, forKey: key) }
    }

    public func reset() {
        distinctId = UUID().uuidString
        if let key = persistenceKey { UserDefaults.standard.set(distinctId, forKey: key) }
    }

    @discardableResult
    public func screen(_ name: String, id: String = UUID().uuidString) async throws -> Receipt {
        try await capture("screen_view", properties: ["screen": .string(try checked(name, 256, "screen"))], id: id)
    }

    @discardableResult
    public func capture(_ name: String, properties: [String: JSONValue] = [:],
                        id: String = UUID().uuidString, timestamp: Date = Date()) async throws -> Receipt {
        let entry = try stage(name, properties, id, timestamp)
        return try await deliver(entry)
    }

    /// Commit the occurrence to local storage and return immediately, including offline.
    @discardableResult
    public func enqueue(_ name: String, properties: [String: JSONValue] = [:],
                        id: String = UUID().uuidString, timestamp: Date = Date()) throws -> String {
        let entry = try stage(name, properties, id, timestamp)
        schedule(after: 0.15)
        return entry.id
    }

    private func stage(_ name: String, _ properties: [String: JSONValue], _ id: String, _ timestamp: Date) throws -> StoredEvent {
        let clock = ISO8601DateFormatter()
        clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let event = Capture(api_key: writeKey, uuid: try checked(id, 128, "id"),
                            distinct_id: distinctId, event: try checked(name, 128, "event"),
                            properties: properties, timestamp: clock.string(from: timestamp))
        let body = try JSONEncoder().encode(event)
        guard body.count <= 1024 * 1024 else { throw BirdwatchError.invalidInput("event exceeds 1 MiB") }
        return try outbox.put(id: id, body: body)
    }

    /// Replay the events pending at call time. A failed request leaves its event available for replay.
    public func flush() async throws {
        for entry in try outbox.list() { _ = try await deliver(entry) }
        retrySeconds = 1
    }

    private func deliver(_ entry: StoredEvent) async throws -> Receipt {
        if let task = active[entry.sequence] { return try await task.value }
        let task = Task {
            defer { active[entry.sequence] = nil }
            do {
                let receipt = try await transmit(entry)
                try outbox.remove(entry)
                return receipt
            } catch {
                if case BirdwatchError.http(let status) = error, status == 400 || status == 413 {
                    try outbox.remove(entry)
                } else { scheduleRetry() }
                throw error
            }
        }
        active[entry.sequence] = task
        return try await task.value
    }

    private func transmit(_ entry: StoredEvent) async throws -> Receipt {
        if notBefore > Date() { throw BirdwatchError.http(429) }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = entry.body
        for attempt in 0...maxRetries {
            try Task.checkCancellation()
            var delay = 0.2 * pow(2.0, Double(attempt))
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else { throw BirdwatchError.invalidAcknowledgement }
                if (200..<300).contains(http.statusCode) {
                    guard let ack = try? JSONDecoder().decode(Counts.self, from: data),
                          (ack.accepted == 1 && ack.duplicates == 0) || (ack.accepted == 0 && ack.duplicates == 1)
                    else { throw BirdwatchError.invalidAcknowledgement }
                    return Receipt(id: entry.id, accepted: ack.accepted, duplicates: ack.duplicates)
                }
                let status = http.statusCode
                guard status == 408 || status == 429 || (500..<600).contains(status)
                else { throw BirdwatchError.http(status) }
                if let raw = http.value(forHTTPHeaderField: "Retry-After") {
                    let date = DateFormatter()
                    date.locale = Locale(identifier: "en_US_POSIX")
                    date.timeZone = TimeZone(secondsFromGMT: 0)
                    date.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
                    let wait = Double(raw) ?? date.date(from: raw)?.timeIntervalSinceNow ?? 0
                    if wait.isFinite, wait > 0 { notBefore = max(notBefore, Date().addingTimeInterval(wait)) }
                    guard wait.isFinite, wait <= 30 else { throw BirdwatchError.http(status) }
                    delay = max(delay, wait)
                }
                guard attempt < maxRetries else { throw BirdwatchError.http(status) }
            } catch let error as URLError {
                let retryable: [URLError.Code] = [.timedOut, .networkConnectionLost, .notConnectedToInternet,
                    .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]
                guard attempt < maxRetries, retryable.contains(error.code) else { throw error }
            }
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
        throw BirdwatchError.invalidAcknowledgement
    }
}
