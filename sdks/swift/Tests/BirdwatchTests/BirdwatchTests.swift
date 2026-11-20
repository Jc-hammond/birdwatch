import XCTest

@testable import Birdwatch

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class BirdwatchTests: XCTestCase {
  func testIdentityAndValidation() async throws {
    let host = URL(string: "http://127.0.0.1")!
    let client = try await BirdwatchClient(host: host, writeKey: "test", persistence: .memory)
    let original = await client.distinctId
    try await client.identify("user-42")
    let identified = await client.distinctId
    XCTAssertEqual(identified, "user-42")
    await client.reset()
    let reset = await client.distinctId
    XCTAssertNotEqual(reset, original)
    do {
      _ = try await BirdwatchClient(host: host, writeKey: " ")
      XCTFail("accepted a blank key")
    } catch { XCTAssertEqual(error as? BirdwatchError, .invalidInput("writeKey")) }
    for props: [String: JSONValue] in [
      ["v": .number(.infinity)], ["v": .string(String(repeating: "x", count: 32768))],
    ] {
      do {
        _ = try await client.enqueue("invalid", properties: props)
        XCTFail("accepted invalid properties")
      } catch BirdwatchError.invalidInput {}
    }
    do {
      _ = try await client.capture(" ")
      XCTFail("accepted a blank event")
    } catch { XCTAssertEqual(error as? BirdwatchError, .invalidInput("event")) }
  }

}
