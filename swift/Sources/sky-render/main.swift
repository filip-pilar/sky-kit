// sky-render: render a still of the sky to a PNG (also used to check parity with the web version).
//
//   swift run sky-render --width 1600 --height 1000 --seconds 30 --out sky.png
//   options: --seed N --coverage 0..1 --shadow 0..1 --palette day|summer|pastel --scale 2 --direction left|right
import Foundation
import CoreGraphics
import ImageIO
import SkyKit

var opts = SkyOptions()
var width = 1600, height = 1000, seconds = 0.0, scale = 2.0, out = "sky.png"
var args = Array(CommandLine.arguments.dropFirst())
func value() -> String {
    guard !args.isEmpty else { FileHandle.standardError.write("missing value\n".data(using: .utf8)!); exit(2) }
    return args.removeFirst()
}
while !args.isEmpty {
    switch args.removeFirst() {
    case "--width": width = Int(value()) ?? width
    case "--height": height = Int(value()) ?? height
    case "--seconds": seconds = Double(value()) ?? 0
    case "--scale": scale = Double(value()) ?? scale
    case "--out": out = value()
    case "--seed": opts.seed = Double(value()) ?? 0
    case "--coverage": opts.coverage = Double(value()) ?? opts.coverage
    case "--shadow": opts.shadow = Double(value()) ?? opts.shadow
    case "--palette": opts.palette = SkyOptions.Palette(rawValue: value()) ?? .day
    case "--direction": opts.direction = value() == "right" ? .right : .left
    case let other:
        FileHandle.standardError.write("unknown option \(other)\n".data(using: .utf8)!); exit(2)
    }
}

do {
    let renderer = try SkyRenderer(options: opts)
    let start = Date()
    let image = try renderer.renderImage(width: width, height: height, pixelsPerPoint: scale, seconds: seconds)
    let url = URL(fileURLWithPath: out)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw SkyRenderer.RendererError.readback }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw SkyRenderer.RendererError.readback }
    print("wrote \(out) (\(width)×\(height), \(seconds)s of sky time) in \(String(format: "%.2f", Date().timeIntervalSince(start)))s")
} catch {
    FileHandle.standardError.write("sky-render failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
