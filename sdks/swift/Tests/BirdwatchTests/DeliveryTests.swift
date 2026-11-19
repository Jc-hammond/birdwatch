import Foundation
import XCTest
@testable import Birdwatch
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class Stub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var responses: [(Int, String)] = []
    static var bodies: [Data] = []
    static func prepare(_ replies: [(Int, String)]) {
        lock.lock(); defer { lock.unlock() }
        responses = replies
        bodies = []
    }
    static func captured() -> [Data] {
        lock.lock(); defer { lock.unlock() }
        return bodies
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        Self.lock.lock()
        Self.bodies.append(body)
        let reply = Self.responses.isEmpty ? (500, "") : Self.responses.removeFirst()
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.0, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class DeliveryTests: XCTestCase {
    func testRetryAndPermanentFailure() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        let client = try BirdwatchClient(host: URL(string: "https://birdwatch.invalid")!,
            writeKey: "test", persistence: .memory, session: URLSession(configuration: config))
        Stub.prepare([(503, ""), (200, #"{"accepted":0,"duplicates":1}"#)])
        let receipt = try await client.capture("paid", id: "order-42")
        XCTAssertEqual(receipt.duplicates, 1)
        let bodies = Stub.captured()
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies.first, bodies.last)
        let body = try XCTUnwrap(bodies.first)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(payload["uuid"] as? String, "order-42")
        Stub.prepare([(401, "")])
        do { _ = try await client.capture("paid"); XCTFail("accepted a rejected write key") }
        catch { XCTAssertEqual(error as? BirdwatchError, .http(401)) }
        XCTAssertEqual(Stub.captured().count, 1)
        Stub.prepare([(200, #"{"accepted":1,"duplicates":1}"#)])
        do { _ = try await client.capture("paid"); XCTFail("accepted incorrect counts") }
        catch { XCTAssertEqual(error as? BirdwatchError, .invalidAcknowledgement) }
    }
}

extension DeliveryTests {
    func testDurableCommitIsScopedAndReplayable() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("events.sqlite3")
        let data = Data(#"{"uuid":"one","distinct_id":"before-reset"}"#.utf8)
        do {
            let spool = try Outbox(file: path, scope: "a", capacity: 1)
            _ = try spool.put(id: "one", body: data)
            let replay = try spool.put(id: "one", body: Data("changed".utf8))
            XCTAssertEqual(replay.body, data)
            XCTAssertThrowsError(try spool.put(id: "two", body: data)) {
                XCTAssertEqual($0 as? BirdwatchError, .queueFull)
            }
        }
        let reopened = try Outbox(file: path, scope: "a", capacity: 1)
        let other = try Outbox(file: path, scope: "b", capacity: 1)
        XCTAssertTrue(try other.list().isEmpty)
        let entry = try XCTUnwrap(reopened.list().first)
        XCTAssertEqual(entry.body, data)
        try reopened.remove(entry)
        XCTAssertTrue(try reopened.list().isEmpty)
    }
}
