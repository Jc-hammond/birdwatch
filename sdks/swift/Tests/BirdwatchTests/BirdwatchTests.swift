import XCTest
@testable import Birdwatch
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class BirdwatchTests: XCTestCase {
    func testIdentityAndValidation() async throws {
        let host = URL(string: "http://127.0.0.1")!
        let client = try BirdwatchClient(host: host, writeKey: "test", persistence: .memory)
        let original = await client.distinctId
        try await client.identify("user-42")
        let identified = await client.distinctId
        XCTAssertEqual(identified, "user-42")
        await client.reset()
        let reset = await client.distinctId
        XCTAssertNotEqual(reset, original)
        XCTAssertThrowsError(try BirdwatchClient(host: host, writeKey: " "))
        do { _ = try await client.capture(" "); XCTFail("accepted a blank event") }
        catch { XCTAssertEqual(error as? BirdwatchError, .invalidInput("event")) }
    }

    func testCollector() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let value = env["BIRDWATCH_TEST_HOST"], let url = URL(string: value),
              let key = env["BIRDWATCH_TEST_KEY"] else { throw XCTSkip("Set BIRDWATCH_TEST_HOST and BIRDWATCH_TEST_KEY for a live collector") }
        let client = try BirdwatchClient(host: url, writeKey: key, persistence: .memory)
        try await client.identify("swift-integration")
        let id = UUID().uuidString
        let first = try await client.capture("swift_checkout", properties: ["quantity": 2, "context": ["mobile": true]], id: id)
        let second = try await client.capture("swift_checkout", id: id)
        let screen = try await client.screen("Checkout")
        XCTAssertEqual(first.accepted, 1)
        XCTAssertEqual(second.duplicates, 1)
        XCTAssertEqual(screen.accepted, 1)
    }
}
