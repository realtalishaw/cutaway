// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "cutaway-native",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "cutaway-native", targets: ["cutaway-native"])
    ],
    targets: [
        .executableTarget(
            name: "cutaway-native",
            path: "Sources/cutaway-native",
            exclude: ["Info.plist"],
            swiftSettings: [.unsafeFlags(["-swift-version", "5"])],
            linkerSettings: [
                // Embed Info.plist so TCC can show usage strings when the helper runs standalone.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/cutaway-native/Info.plist",
                ])
            ]
        )
    ]
)
