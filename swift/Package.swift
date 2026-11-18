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
        .target(name: "SkyKit"),
        .executableTarget(name: "sky-render", dependencies: ["SkyKit"]),
    ]
)
