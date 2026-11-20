import Foundation
import SQLite3

private let output = NSLock()
private func reply(_ message: [String: Any]) {
  output.lock()
  defer { output.unlock() }
  let data = try! JSONSerialization.data(withJSONObject: message)
  FileHandle.standardOutput.write(data + Data([10]))
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var millis = 0
  private var online = true
  private var samples = [Double]()
  func set(_ value: Int) { lock.withLock { millis = value } }
  func setOnline(_ value: Bool) { lock.withLock { online = value } }
  func seed(_ values: [Double]) { lock.withLock { samples = values } }
  func date() -> Date { lock.withLock { Date(timeIntervalSince1970: Double(millis) / 1000) } }
  func jitter() -> Double { lock.withLock { samples.isEmpty ? 0.5 : samples.removeFirst() } }
  func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
    guard lock.withLock({ online }) else { throw URLError(.notConnectedToInternet) }
    reply(["sent": lock.withLock { millis }])
    return try await URLSession.shared.data(for: request)
  }
}

private actor Driver {
  let clock = Clock()
  let host: URL
  let file: URL
  var client: BirdwatchClient?
  var lockConnection: OpaquePointer?
  init() {
    host = URL(string: CommandLine.arguments[1])!
    file = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("outbox.sqlite3")
  }
  func handle(_ command: [String: Any]) async throws -> [String: Any] {
    clock.set(command["now"] as! Int)
    let op = command["op"] as! String
    if op == "open" {
      let config = command["config"] as! [String: Any]
      clock.seed(config["jitter"] as? [Double] ?? [])
      let clock = self.clock
      let runtime = DeliveryEnvironment(
        now: { clock.date() }, jitter: { clock.jitter() },
        transport: { try await clock.send($0) }, automatic: false, flushDelay: 60)
      client = try await BirdwatchClient(
        host: host, writeKey: "test", persistence: .memory,
        outboxURL: config["persist"] as? Bool == true ? file : nil,
        maxQueueSize: config["capacity"] as? Int ?? 1000,
        onError: { _ in reply(["errorEvent": true]) }, environment: runtime)
      return [:]
    }
    guard let client else { return [:] }
    switch op {
    case "lockOutbox":
      guard sqlite3_open(file.path, &lockConnection) == SQLITE_OK,
        sqlite3_exec(lockConnection, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK
      else { throw BirdwatchError.storage("Could not acquire fixture lock.") }
    case "unlockOutbox":
      sqlite3_close(lockConnection)
      lockConnection = nil
    case "capture":
      _ = try await client.enqueue(
        command["event"] as! String, id: command["uuid"] as? String ?? UUID().uuidString)
    case "online", "offline": clock.setOnline(op == "online")
    case "flush": try? await client.flush()
    case "hide": try? await client.background()
    case "close":
      try? await client.close()
      self.client = nil
    case "due":
      if let date = await client.due {
        return ["due": Int((date.timeIntervalSince1970 * 1000).rounded())]
      }
    case "tick": await client.tick()
    default: fatalError("unknown step")
    }
    return [:]
  }
}

@main
struct ConformanceDriver {
  static func main() {
    let driver = Driver()
    while let line = readLine() {
      guard let command = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
      else { break }
      Task.detached {
        var result: [String: Any]
        do { result = try await driver.handle(command) } catch {
          result = ["failure": String(describing: error)]
        }
        result["id"] = command["id"]
        reply(result)
      }
    }
  }
}
