import Foundation
import SQLite3

struct StoredEvent: Sendable {
  let sequence: Int64
  let id: String
  let body: Data
}

/// The client actor owns this connection. SQLite also serializes other connections
/// to the same file, including another app process interrupted during delivery.
final class Outbox: @unchecked Sendable {
  private static let worker = DispatchQueue(label: "birdwatch.sqlite")
  static func perform<T>(_ operation: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      worker.async { continuation.resume(with: Result { try operation() }) }
    }
  }

  static func open(file: URL?, scope: String, capacity: Int) async throws -> (Outbox, Bool) {
    try await perform {
      do {
        return (try Outbox(file: file, scope: scope, capacity: capacity), false)
      } catch SQLiteCorruption.unreadable {
        guard let file else { throw BirdwatchError.storage("Unreadable in-memory outbox.") }
        let backup = file.appendingPathExtension("corrupt-" + UUID().uuidString)
        for suffix in ["", "-wal", "-shm", "-journal"] {
          let source = file.path + suffix
          if FileManager.default.fileExists(atPath: source) {
            try FileManager.default.moveItem(atPath: source, toPath: backup.path + suffix)
          }
        }
        return (try Outbox(file: file, scope: scope, capacity: capacity), true)
      }
    }
  }
  private enum SQLiteCorruption: Error { case unreadable }
  private let db: OpaquePointer
  private let scope: String
  private let capacity: Int
  private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private init(file: URL?, scope: String, capacity: Int) throws {
    guard capacity > 0 else { throw BirdwatchError.invalidInput("maxQueueSize") }
    self.capacity = capacity
    self.scope = scope
    if let file {
      try FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
    var handle: OpaquePointer?
    guard
      sqlite3_open_v2(
        file?.path ?? ":memory:", &handle,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
      let opened = handle
    else {
      sqlite3_close(handle)
      throw BirdwatchError.storage("Could not open the Birdwatch outbox.")
    }
    db = opened
    sqlite3_busy_timeout(db, 5000)
    if file != nil {
      try statement("PRAGMA integrity_check(1)", []) { stmt in
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw failure() }
        guard let message = sqlite3_column_text(stmt, 0), String(cString: message) == "ok" else {
          throw SQLiteCorruption.unreadable
        }
      }
    }
    try execute(
      "CREATE TABLE IF NOT EXISTS outbox_v1 (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, uuid TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(scope, uuid))"
    )
  }
  deinit {
    let handle = db
    // Close on the same queue as the connection's other operations.
    Self.worker.async { sqlite3_close(handle) }
  }

  private func failure() -> Error {
    switch sqlite3_errcode(db) {
    case SQLITE_CORRUPT, SQLITE_NOTADB: return SQLiteCorruption.unreadable
    default: return BirdwatchError.storage("SQLite outbox operation failed.")
    }
  }

  private func statement<T>(
    _ sql: String, _ values: [String], _ operation: (OpaquePointer) throws -> T
  ) throws -> T {
    var result: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &result, nil) == SQLITE_OK, let stmt = result else {
      throw failure()
    }
    defer { sqlite3_finalize(stmt) }
    for (i, value) in values.enumerated() {
      guard sqlite3_bind_text(stmt, Int32(i + 1), value, -1, transient) == SQLITE_OK else {
        throw failure()
      }
    }
    return try operation(stmt)
  }
  private func execute(_ sql: String, _ values: [String] = []) throws {
    try statement(sql, values) { stmt in
      guard sqlite3_step(stmt) == SQLITE_DONE else { throw failure() }
    }
  }
  private func rows(_ sql: String, _ values: [String]) throws -> [StoredEvent] {
    try statement(sql, values) { stmt in
      var events = [StoredEvent]()
      while true {
        switch sqlite3_step(stmt) {
        case SQLITE_DONE: return events
        case SQLITE_ROW:
          guard let id = sqlite3_column_text(stmt, 1), let body = sqlite3_column_text(stmt, 2)
          else { throw BirdwatchError.storage("Unreadable outbox row.") }
          events.append(
            StoredEvent(
              sequence: sqlite3_column_int64(stmt, 0),
              id: String(cString: id),
              body: Data(bytes: body, count: Int(sqlite3_column_bytes(stmt, 2)))))
        default: throw failure()
        }
      }
    }
  }
  func put(id: String, body: Data) throws -> (StoredEvent, [StoredEvent]) {
    try execute("BEGIN IMMEDIATE")
    defer { try? execute("ROLLBACK") }
    try execute(
      "INSERT INTO outbox_v1(scope, uuid, body) VALUES(?,?,?) ON CONFLICT(scope,uuid) DO NOTHING",
      [scope, id, String(decoding: body, as: UTF8.self)])
    guard
      let row = try rows(
        "SELECT seq,uuid,body FROM outbox_v1 WHERE scope=? AND uuid=?", [scope, id]
      ).first
    else { throw failure() }
    let dropped = try rows(
      "SELECT seq,uuid,body FROM outbox_v1 WHERE scope=? ORDER BY seq DESC LIMIT -1 OFFSET CAST(? AS INTEGER)",
      [scope, String(capacity)])
    for entry in dropped {
      try execute("DELETE FROM outbox_v1 WHERE scope=? AND seq=?", [scope, String(entry.sequence)])
    }
    try execute("COMMIT")
    return (row, dropped)
  }

  func lastSequence() throws -> Int64 {
    try statement("SELECT COALESCE(MAX(seq),0) FROM outbox_v1 WHERE scope=?", [scope]) { stmt in
      guard sqlite3_step(stmt) == SQLITE_ROW else { throw failure() }
      return sqlite3_column_int64(stmt, 0)
    }
  }

  func page(through limit: Int64) throws -> [StoredEvent] {
    try rows(
      "SELECT seq,uuid,body FROM outbox_v1 WHERE scope=? AND seq<=CAST(? AS INTEGER) ORDER BY seq LIMIT 100",
      [scope, String(limit)])
  }

  func remove(_ entries: [StoredEvent]) throws -> Set<Int64> {
    try execute("BEGIN IMMEDIATE")
    defer { try? execute("ROLLBACK") }
    var removed = Set<Int64>()
    for entry in entries {
      try execute("DELETE FROM outbox_v1 WHERE scope=? AND seq=?", [scope, String(entry.sequence)])
      if sqlite3_changes(db) > 0 { removed.insert(entry.sequence) }
    }
    try execute("COMMIT")
    return removed
  }
}
