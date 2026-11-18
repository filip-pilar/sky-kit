// sky-render: render a still of the sky to a PNG (also used to check parity with the web version).
//
//   swift run sky-render --width 1600 --height 1000 --seconds 30 --out sky.png
//   options: --seed N --coverage 0..1 --shadow 0..1 --palette day|summer|pastel --scale 2 --direction left|right
//            --text hello | --text one,two (chained) | --heart (start forming a shape at time 0), --plane
//            --form/--hold/--fade seconds, --density 0..1, --pause seconds between chained words (0 = straight from one to the next)
import Foundation
import CoreGraphics
import ImageIO
import SkyKit

var opts = SkyOptions()
var width = 1600, height = 1000, seconds = 0.0, scale = 2.0, out = "sky.png"
var shapeText: String? = nil, plane = false, heart = false, shapeX = 0.5
var releaseAt: Double? = nil
var form = 5.0, hold = 5.0, fade = 7.0, density = 0.5, pause = 1.0, symbol: SkySymbol? = nil, size = 0.32, symbolSheet: String? = nil

/// The heart used by the web demos (SVG path, viewBox 100×92), drawn at 220 px tall.
func heartImage() -> CGImage? {
    let h = 220.0, s = h / 92, w = Int((100 * s).rounded())
    guard let ctx = CGContext(data: nil, width: w, height: Int(h), bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * s, y: (92 - y) * s) }
    let path = CGMutablePath()
    path.move(to: pt(50, 90))
    path.addCurve(to: pt(2, 28), control1: pt(20, 66), control2: pt(2, 48))
    path.addCurve(to: pt(28, 2), control1: pt(2, 13), control2: pt(14, 2))
    path.addCurve(to: pt(50, 16), control1: pt(38, 2), control2: pt(46, 8))
    path.addCurve(to: pt(72, 2), control1: pt(54, 8), control2: pt(62, 2))
    path.addCurve(to: pt(98, 28), control1: pt(86, 2), control2: pt(98, 13))
    path.addCurve(to: pt(50, 90), control1: pt(98, 48), control2: pt(80, 66))
    path.closeSubpath()
    ctx.addPath(path); ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fillPath()
    return ctx.makeImage()
}
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
    case "--palette": opts.palette = SkyOptions.Palette(rawValue: value()) ?? .summer
    case "--gradient": opts.gradient = Double(value()) ?? 0
    case "--direction": opts.direction = value() == "right" ? .right : .left
    case "--text": shapeText = value()                 // start forming this text at time 0
    case "--heart": heart = true                        // start forming a heart at time 0 (same path as the demos)
    case "--shape-x": shapeX = Double(value()) ?? 0.5   // where the shape sits (0…1 of the view width)
    case "--form": form = Double(value()) ?? form
    case "--hold": hold = Double(value()) ?? hold
    case "--fade": fade = Double(value()) ?? fade
    case "--density": density = Double(value()) ?? density
    case "--pause": pause = Double(value()) ?? pause
    case "--release-at": releaseAt = Double(value())      // melt the shape back from wherever it is at this time
    case "--hold-forever": hold = .infinity
    case "--symbol": symbol = SkySymbol(rawValue: value())   // start forming a built-in symbol at time 0
    case "--size": size = Double(value()) ?? size
    case "--symbol-sheet": symbolSheet = value()             // just draw every symbol side by side into this PNG and exit
    case "--plane": plane = true                        // a plane from (0, 0.7) to (1, 0.75) at time 0
    case let other:
        FileHandle.standardError.write("unknown option \(other)\n".data(using: .utf8)!); exit(2)
    }
}

if let symbolSheet {   // the symbols as drawn for the masks (to compare with the browser's SVG)
    let imgs = SkySymbol.allCases.compactMap { $0.image(height: 110) }
    let W = imgs.reduce(0) { $0 + $1.width + 10 } + 10
    let ctx = CGContext(data: nil, width: W, height: 130, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: W, height: 130))
    var x = 10
    for img in imgs { ctx.draw(img, in: CGRect(x: x, y: 10, width: img.width, height: img.height)); x += img.width + 10 }
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: symbolSheet) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil); CGImageDestinationFinalize(dest)
    exit(0)
}
do {
    let renderer = try SkyRenderer(options: opts)
    let start = Date()
    let image = try renderer.renderImage(width: width, height: height, pixelsPerPoint: scale, seconds: seconds, prepare: { r in
        for (i, word) in (shapeText ?? "").split(separator: ",").enumerated()   // one,two: each forms after the last has melted
        where !r.showShape(.text(String(word)), x: shapeX, form: form, hold: hold, fade: fade, density: density, queue: i > 0, pause: pause) {
            FileHandle.standardError.write("could not build the shape\n".data(using: .utf8)!)
        }
        if let symbol, !r.showShape(.symbol(symbol), x: shapeX, size: size, form: form, hold: hold, fade: fade, density: density) {
            FileHandle.standardError.write("could not build the symbol\n".data(using: .utf8)!)
        }
        if heart, let img = heartImage(), !r.showShape(.image(img), x: shapeX, size: 0.36, form: form, hold: hold, fade: fade, density: density) { FileHandle.standardError.write("could not build the heart\n".data(using: .utf8)!) }
        if plane { r.flyPlane(from: CGPoint(x: 0, y: 0.7), to: CGPoint(x: 1, y: 0.75)) }
    }, onFrame: { r, t in if let releaseAt, abs(t - releaseAt) < 0.5 / 30 { r.releaseShape() } })
    let url = URL(fileURLWithPath: out)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw SkyRenderer.RendererError.readback }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw SkyRenderer.RendererError.readback }
    print("wrote \(out) (\(width)×\(height), \(seconds)s of sky time) in \(String(format: "%.2f", Date().timeIntervalSince(start)))s")
} catch {
    FileHandle.standardError.write("sky-render failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
