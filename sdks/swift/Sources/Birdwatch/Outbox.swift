import Foundation
import SQLite3

struct StoredEvent: Sendable {
    let sequence: Int64
    let id: String
    let body: Data
}

/// The client actor owns this connection. SQLite also serializes other connections
/// to the same file, including another app process interrupted during delivery.
final class Outbox {
    private let db: OpaquePointer
    private let scope: String
    private let capacity: Int
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(file: URL?, scope: String, capacity: Int) throws {
        guard capacity > 0 else { throw BirdwatchError.invalidInput("maxQueueSize") }
        self.capacity = capacity
        self.scope = scope
        if let file {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(file?.path ?? ":memory:", &handle,
                              SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let opened = handle else {
            sqlite3_close(handle)
            throw BirdwatchError.storage("Could not open the Birdwatch outbox.")
        }
        db = opened
        sqlite3_busy_timeout(db, 5000)
        try execute("CREATE TABLE IF NOT EXISTS outbox_v1 (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, uuid TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(scope, uuid))")
    }
    deinit { sqlite3_close(db) }

    private func failure() -> BirdwatchError { .storage(String(cString: sqlite3_errmsg(db))) }

    private func statement<T>(_ sql: String, _ values: [String], _ operation: (OpaquePointer) throws -> T) throws -> T {
        var result: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &result, nil) == SQLITE_OK, let stmt = result else { throw failure() }
        defer { sqlite3_finalize(stmt) }
        for (i, value) in values.enumerated() {
            guard sqlite3_bind_text(stmt, Int32(i + 1), value, -1, transient) == SQLITE_OK else { throw failure() }
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
                    events.append(StoredEvent(sequence: sqlite3_column_int64(stmt, 0),
                        id: String(cString: id), body: Data(bytes: body, count: Int(sqlite3_column_bytes(stmt, 2)))))
                default: throw failure()
                }
            }
        }
    }
    func put(id: String, body: Data) throws -> StoredEvent {
        try execute("BEGIN IMMEDIATE")
        do {
            try execute("""
                INSERT INTO outbox_v1(scope, uuid, body)
                SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM outbox_v1 WHERE scope=?) < CAST(? AS INTEGER)
                ON CONFLICT(scope, uuid) DO NOTHING
                """, [scope, id, String(decoding: body, as: UTF8.self), scope, String(capacity)])
            guard let row = try rows("SELECT seq,uuid,body FROM outbox_v1 WHERE scope=? AND uuid=?", [scope,id]).first
            else { throw BirdwatchError.queueFull }
            try execute("COMMIT")
            return row
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }
    func list() throws -> [StoredEvent] {
        try rows("SELECT seq,uuid,body FROM outbox_v1 WHERE scope=? ORDER BY seq", [scope])
    }
    func remove(_ entry: StoredEvent) throws {
        try execute("DELETE FROM outbox_v1 WHERE scope=? AND seq=?", [scope, String(entry.sequence)])
    }
}
