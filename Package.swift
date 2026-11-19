// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SkyKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "SkyKit", targets: ["SkyKit"]),
        .executable(name: "sky-render", targets: ["sky-render"]),
    ],
    targets: [
        .target(name: "SkyKit", path: "swift/Sources/SkyKit"),
        .executableTarget(name: "sky-render", dependencies: ["SkyKit"], path: "swift/Sources/sky-render"),
        .executableTarget(name: "SkyDemo", dependencies: ["SkyKit"], path: "swift/Sources/SkyDemo"),   // macOS window demo: swift run SkyDemo
        .testTarget(name: "SkyKitTests", dependencies: ["SkyKit"], path: "swift/Tests/SkyKitTests"),
    ]
)
