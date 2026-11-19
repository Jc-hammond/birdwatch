// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Birdwatch",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "Birdwatch", targets: ["Birdwatch"])],
    targets: [
        .target(name: "Birdwatch"),
        .testTarget(name: "BirdwatchTests", dependencies: ["Birdwatch"])
    ]
)
