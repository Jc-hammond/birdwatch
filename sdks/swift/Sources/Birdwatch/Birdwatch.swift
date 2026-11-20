import Foundation
import Network

#if canImport(UIKit)
  import UIKit
#elseif canImport(AppKit)
  import AppKit
#endif
#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum BirdwatchError: Error, Equatable {
  case invalidInput(String)
  case http(Int)
  case queueFull
  case storage(String)
  case invalidAcknowledgement
  case closed
}

public struct Receipt: Sendable, Equatable {
  public let id: String
  public let accepted: Int
  public let duplicates: Int
}

private struct Rejection: Decodable {
  let index: Int
  let code: String
}
private struct Counts: Decodable {
  let accepted: Int
  let duplicates: Int
  let rejected: [Rejection]?
}
private struct ServerError: Decodable { let code: String }

private struct Capture: Encodable {
  let uuid: String
  let distinct_id: String
  let event: String
  let properties: [String: JSONValue]
  let timestamp: String
}

private func checked(_ value: String, _ limit: Int, _ label: String) throws -> String {
  guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    !value.utf8.contains(0), value.unicodeScalars.count <= limit
  else {
    throw BirdwatchError.invalidInput(label)
  }
  return value
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

struct DeliveryEnvironment: Sendable {
  var now: @Sendable () -> Date = { Date() }
  var jitter: @Sendable () -> Double = { Double.random(in: 0...1) }
  var transport: (@Sendable (URLRequest) async throws -> (Data, URLResponse))?
  var automatic = true
  var flushDelay = 0.15
}

public actor BirdwatchClient {
  public enum Persistence: Sendable { case disk, memory }
  public typealias ErrorHandler = @Sendable (BirdwatchError) -> Void
  private let endpoint: URL
  private let writeKey: String
  private let session: URLSession
  private let persistenceKey: String?
  private let outbox: Outbox
  private let environment: DeliveryEnvironment
  private let onError: ErrorHandler?
  private let monitor = NWPathMonitor()
  private var observer: NSObjectProtocol?
  private var timer: Task<Void, Never>?
  private var inFlight: Task<Bool, Error>?
  private var waiters: [String: [UUID: CheckedContinuation<Receipt, Error>]] = [:]
  private var ceiling = 1.0
  private var notBefore = Date.distantPast
  private var paused = false
  private var closed = false
  private var overflow = false
  private(set) var due: Date?
  public private(set) var distinctId: String

  public init(
    host: URL, writeKey: String, persistence: Persistence = .disk, timeout: TimeInterval = 5,
    session: URLSession? = nil, outboxURL: URL? = nil, maxQueueSize: Int = 1000,
    onError: ErrorHandler? = nil
  ) async throws {
    try await self.init(
      host: host, writeKey: writeKey, persistence: persistence, timeout: timeout, session: session,
      outboxURL: outboxURL, maxQueueSize: maxQueueSize, onError: onError,
      environment: DeliveryEnvironment())
  }

  init(
    host: URL, writeKey: String, persistence: Persistence, timeout: TimeInterval = 5,
    session: URLSession? = nil, outboxURL: URL?, maxQueueSize: Int, onError: ErrorHandler?,
    environment: DeliveryEnvironment
  ) async throws {
    guard let parts = URLComponents(url: host, resolvingAgainstBaseURL: false),
      let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
      parts.host?.isEmpty == false, parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil, timeout.isFinite, timeout > 0, timeout <= 120
    else { throw BirdwatchError.invalidInput("host or timeout") }
    endpoint = host.appendingPathComponent("api/capture")
    self.writeKey = try checked(writeKey, 128, "writeKey")
    self.onError = onError
    self.environment = environment
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = timeout
    config.timeoutIntervalForResource = timeout
    self.session =
      session ?? URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    let scope = String(
      decoding: try JSONEncoder().encode([endpoint.absoluteString, writeKey]), as: UTF8.self)
    let file: URL?
    if persistence == .disk && outboxURL == nil {
      file = try await Outbox.perform {
        var directory = try FileManager.default.url(
          for: .applicationSupportDirectory, in: .userDomainMask,
          appropriateFor: nil, create: true
        ).appendingPathComponent("Birdwatch", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory.appendingPathComponent("outbox.sqlite3")
      }
    } else {
      file = outboxURL
    }
    let (store, recovered) = try await Outbox.open(file: file, scope: scope, capacity: maxQueueSize)
    outbox = store
    persistenceKey =
      persistence == .disk ? "birdwatch.identity.\(endpoint.absoluteString)|\(writeKey)" : nil
    if let key = persistenceKey, let saved = UserDefaults.standard.string(forKey: key) {
      distinctId = try checked(saved, 256, "saved identity")
    } else {
      distinctId = UUID().uuidString
      if let key = persistenceKey { UserDefaults.standard.set(distinctId, forKey: key) }
    }
    if recovered { onError?(.storage("Corrupt outbox was moved aside.")) }
    if environment.automatic { startReplay() }
  }

  private func startReplay() {
    monitor.pathUpdateHandler = { [weak self] path in
      if path.status == .satisfied { Task { try? await self?.flush() } }
    }
    monitor.start(queue: DispatchQueue(label: "birdwatch.connectivity"))
    #if canImport(UIKit)
      let name = UIApplication.didEnterBackgroundNotification
    #else
      let name = NSApplication.didResignActiveNotification
    #endif
    observer = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) {
      [weak self] _ in
      Task { try? await self?.background() }
    }
    schedule(after: 0)
  }

  deinit {
    monitor.cancel()
    timer?.cancel()
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }

  private func schedule(after delay: TimeInterval) {
    guard !paused && !closed else { return }
    let next = max(notBefore, environment.now().addingTimeInterval(delay))
    if let due, due <= next && due >= notBefore { return }
    due = next
    timer?.cancel()
    guard environment.automatic else { return }
    let ns = UInt64(max(0, next.timeIntervalSince(environment.now())) * 1_000_000_000)
    timer = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: ns) } catch { return }
      await self?.tick()
    }
  }

  func tick() async {
    guard let due, due <= environment.now() else { return }
    self.due = nil
    try? await flush()
  }

  public func identify(_ person: String) throws {
    distinctId = try checked(person, 256, "distinctId")
    if let key = persistenceKey { UserDefaults.standard.set(distinctId, forKey: key) }
  }

  public func reset() { try? identify(UUID().uuidString) }

  @discardableResult
  public func screen(_ name: String, id: String = UUID().uuidString) async throws -> Receipt {
    try await capture(
      "screen_view", properties: ["screen": .string(try checked(name, 256, "screen"))], id: id)
  }

  @discardableResult
  public func enqueue(
    _ name: String, properties: [String: JSONValue] = [:],
    id: String = UUID().uuidString, timestamp: Date? = nil
  ) async throws -> String {
    guard !closed else { throw BirdwatchError.closed }
    let row: Data
    do {
      let encoded = try JSONEncoder().encode(properties)
      guard encoded.count <= 32768 else {
        throw BirdwatchError.invalidInput("properties exceed 32 KiB")
      }
      let clock = ISO8601DateFormatter()
      clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      row = try JSONEncoder().encode(
        Capture(
          uuid: try checked(id, 128, "id"), distinct_id: distinctId,
          event: try checked(name, 128, "event"), properties: properties,
          timestamp: clock.string(from: timestamp ?? environment.now())))
    } catch {
      let failure =
        error as? BirdwatchError ?? .invalidInput("properties must contain finite JSON values")
      onError?(failure)
      throw failure
    }
    let (_, dropped) = try await Outbox.perform { [outbox] in try outbox.put(id: id, body: row) }
    for item in dropped { finish(item.id, with: .failure(BirdwatchError.queueFull)) }
    if !dropped.isEmpty && !overflow {
      onError?(.queueFull)
      overflow = true
    }
    schedule(after: environment.flushDelay)
    return id
  }

  @discardableResult
  public func capture(
    _ name: String, properties: [String: JSONValue] = [:],
    id: String = UUID().uuidString, timestamp: Date? = nil
  ) async throws -> Receipt {
    return try await withCheckedThrowingContinuation { continuation in
      let token = UUID()
      waiters[id, default: [:]][token] = continuation
      Task {
        do {
          _ = try await enqueue(name, properties: properties, id: id, timestamp: timestamp)
          try await flush()
        } catch {
          waiters[id]?.removeValue(forKey: token)?.resume(throwing: error)
          if waiters[id]?.isEmpty == true { waiters[id] = nil }
        }
      }
    }
  }

  private func finish(_ id: String, with result: Result<Receipt, Error>) {
    if let waiting = waiters.removeValue(forKey: id) {
      for waiter in waiting.values { waiter.resume(with: result) }
    }
  }

  public func flush() async throws { try await drain(background: false) }
  func background() async throws { try await drain(background: true) }

  private func drain(background: Bool) async throws {
    guard !closed else { throw BirdwatchError.closed }
    guard !paused else { throw BirdwatchError.http(401) }
    guard environment.now() >= notBefore else { throw BirdwatchError.http(429) }
    let last = try await Outbox.perform { [outbox] in try outbox.lastSequence() }
    while !closed && !paused {
      if let active = inFlight, !background {
        _ = try await active.value
        continue
      }
      if background {
        if try await !sendPage(through: last) { break }
      } else {
        let task = Task {
          defer { inFlight = nil }
          return try await sendPage(through: last)
        }
        inFlight = task
        if try await !task.value { break }
      }
    }
  }

  private func sendPage(through limit: Int64) async throws -> Bool {
    let page = try await Outbox.perform { [outbox] in try outbox.page(through: limit) }
    guard !page.isEmpty else { return false }
    let clock = ISO8601DateFormatter()
    clock.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var body = Data("{\"sent_at\":\"\(clock.string(from:environment.now()))\",\"api_key\":".utf8)
    body.append(try JSONEncoder().encode(writeKey))
    body.append(Data(",\"batch\":[".utf8))
    var rows = [StoredEvent]()
    for row in page {
      if body.count + row.body.count + 3 > 1_048_576 { break }
      if !rows.isEmpty { body.append(44) }
      body.append(row.body)
      rows.append(row)
    }
    guard !rows.isEmpty else {
      throw BirdwatchError.storage("Outbox row exceeds the request limit.")
    }
    body.append(contentsOf: [93, 125])
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    var retryAfter: Double?
    let outcomes: [Result<Receipt, Error>]
    do {
      let pair: (Data, URLResponse)
      if let send = environment.transport {
        pair = try await send(request)
      } else {
        pair = try await session.data(for: request)
      }
      guard let response = pair.1 as? HTTPURLResponse else {
        throw BirdwatchError.invalidAcknowledgement
      }
      let status = response.statusCode
      let raw = response.value(forHTTPHeaderField: "Retry-After")
      if let raw {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
        if let wait = Double(raw) ?? format.date(from: raw)?.timeIntervalSince(environment.now()),
          wait.isFinite
        {
          retryAfter = min(300, max(0, wait))
        }
      }
      if status == 200 {
        let ack = try JSONDecoder().decode(Counts.self, from: pair.0)
        let rejected = ack.rejected ?? []
        let indices = Set(rejected.map(\.index))
        guard ack.accepted >= 0, ack.duplicates >= 0, ack.accepted <= rows.count,
          ack.duplicates <= rows.count,
          indices.count == rejected.count,
          ack.accepted + ack.duplicates + indices.count == rows.count,
          rejected.allSatisfy({
            rows.indices.contains($0.index) && ["invalid_event", "too_large"].contains($0.code)
          })
        else { throw BirdwatchError.invalidAcknowledgement }
        outcomes = rows.enumerated().map { index, row in
          if let error = rejected.first(where: { $0.index == index }) {
            return .failure(BirdwatchError.http(error.code == "too_large" ? 413 : 400))
          }
          return .success(Receipt(id: row.id, accepted: ack.accepted, duplicates: ack.duplicates))
        }
      } else {
        let code = (try? JSONDecoder().decode(ServerError.self, from: pair.0))?.code
        if status < 500 && status != 408 && status != 429 {
          if code == "unknown_key" {
            if !paused { onError?(.http(status)) }
            paused = true
            due = nil
            timer?.cancel()
          }
          if code == "invalid_event" || code == "too_large" {
            outcomes = rows.map { _ in .failure(BirdwatchError.http(status)) }
          } else {
            throw BirdwatchError.http(status)
          }
        } else {
          throw BirdwatchError.http(status)
        }
      }
    } catch {
      if !paused && !closed {
        let wait = retryAfter ?? ceiling * environment.jitter()
        ceiling = min(60, ceiling * 2)
        notBefore = max(notBefore, environment.now().addingTimeInterval(wait))
        schedule(after: 0)
      }
      throw error
    }
    let batch = rows
    let removed = try await Outbox.perform { [outbox] in try outbox.remove(batch) }
    for (row, result) in zip(rows, outcomes) where removed.contains(row.sequence) {
      finish(row.id, with: result)
      if case .failure(let error) = result {
        onError?(error as? BirdwatchError ?? .invalidAcknowledgement)
      }
    }
    ceiling = 1
    overflow = false
    return true
  }

  public func close() async throws {
    defer {
      closed = true
      timer?.cancel()
      monitor.cancel()
      if let observer {
        NotificationCenter.default.removeObserver(observer)
        self.observer = nil
      }
    }
    if !closed { try await flush() }
  }
}
