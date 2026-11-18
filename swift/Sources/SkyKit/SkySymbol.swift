import CoreGraphics
import Foundation

/// Built-in symbols for `showShape(.symbol(…))` (port of SKY_SYMBOLS in sky.js; keep the two identical). The heart
/// is filled and becomes a solid cloud; the others are bold strokes that form like letters.
public enum SkySymbol: String, CaseIterable, Sendable {
    case heart, star, sun, moon, smile, music, bolt, infinity

    enum Part { case path(fill: Bool, String), circle(fill: Bool, Double, Double, Double), ellipse(Double, Double, Double, Double, Double) }
    /// x, y, width, height of the drawing, in its own units (about 100 tall; y down like SVG)
    var box: (Double, Double, Double, Double) {
        switch self {
        case .heart: return (0, 0, 100, 96)
        case .star: return (-4, -2, 108, 104)
        default: return (-4, -4, 108, 108)
        }
    }
    var parts: [Part] {
        switch self {
        case .heart: return [.path(fill: true, "M50 94C30 78 3 60 3 34 3 16 16 4 31 4 42 4 49 14 50 30 51 14 58 4 69 4 84 4 97 16 97 34 97 60 70 78 50 94Z")]
        case .star: return [.path(fill: false, "M50 7L62.3 36L94 38.2L70 59.5L78.2 90L50 73L21.8 90L30 59.5L6 38.2L37.7 36Z")]
        case .sun: return [.circle(fill: false, 50, 50, 18), .path(fill: false, "M50 6V16M50 84V94M6 50H16M84 50H94M18.9 18.9L26 26M74 74L81.1 81.1M18.9 81.1L26 74M74 26L81.1 18.9")]
        case .moon: return [.path(fill: false, "M46.1 8C25.5 8 7.9 22.8 4.6 43.1C1.2 63.4 13.1 83.2 32.6 89.8C52.1 96.4 73.5 87.9 83.1 69.7C66.2 78.8 45 73 35.1 56.5C25.2 40 30.1 18.6 46.1 8Z")]
        case .smile: return [.circle(fill: false, 50, 50, 42), .circle(fill: true, 35, 40, 8), .circle(fill: true, 65, 40, 8), .path(fill: false, "M30 60Q50 80 70 60")]
        case .music: return [.ellipse(24, 78, 16, 12, -20), .ellipse(74, 70, 16, 12, -20), .path(fill: false, "M36 76V22L86 10V68")]
        case .bolt: return [.path(fill: false, "M58 6L20 56H48L40 94L80 42H52L58 6Z")]
        case .infinity: return [.path(fill: false, "M50 50C40 36 32 30 22 30C11 30 2 39 2 50C2 61 11 70 22 70C32 70 40 64 50 50C60 36 68 30 78 30C89 30 98 39 98 50C98 61 89 70 78 70C68 70 60 64 50 50Z")]
        }
    }

    /// The symbol drawn in black on transparent, `height` pixels tall.
    public func image(height: Int = 220) -> CGImage? {
        let (bx, by, bw, bh) = box
        let s = Double(height) / bh, w = max(2, Int((bw * s).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: height, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // drawing units, y down (like SVG)
        ctx.translateBy(x: 0, y: CGFloat(height)); ctx.scaleBy(x: CGFloat(s), y: -CGFloat(s)); ctx.translateBy(x: -CGFloat(bx), y: -CGFloat(by))
        ctx.setFillColor(gray: 0, alpha: 1); ctx.setStrokeColor(gray: 0, alpha: 1)
        ctx.setLineWidth(14); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        for part in parts {
            switch part {
            case let .path(fill, d):
                ctx.addPath(Self.path(d)); fill ? ctx.fillPath() : ctx.strokePath()
            case let .circle(fill, cx, cy, r):
                let rect = CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)
                fill ? ctx.fillEllipse(in: rect) : ctx.strokeEllipse(in: rect)
            case let .ellipse(cx, cy, rx, ry, deg):
                var t = CGAffineTransform(translationX: cx, y: cy).rotated(by: deg * .pi / 180)
                ctx.addPath(CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: 2 * rx, height: 2 * ry), transform: &t)); ctx.fillPath()
            }
        }
        return ctx.makeImage()
    }

    /// SVG path data, absolute M L H V C Q Z only (numbers may repeat a command, as in SVG).
    static func path(_ d: String) -> CGPath {
        let p = CGMutablePath()
        var tokens: [String] = [], num = ""
        func flush() { if !num.isEmpty { tokens.append(num); num = "" } }
        for ch in d {
            if ch.isLetter { flush(); tokens.append(String(ch)) }
            else if ch == " " || ch == "," { flush() }
            else if ch == "-" && !num.isEmpty && num.last != "e" { flush(); num = "-" }
            else { num.append(ch) }
        }
        flush()
        var i = 0, cmd = "M", cur = CGPoint.zero
        func next() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i]) ?? 0) }
        while i < tokens.count {
            if let c = tokens[i].first, c.isLetter { cmd = tokens[i]; i += 1; if cmd == "Z" { p.closeSubpath(); continue } }
            switch cmd {
            case "M": cur = CGPoint(x: next(), y: next()); p.move(to: cur); cmd = "L"   // pairs after M are lines
            case "L": cur = CGPoint(x: next(), y: next()); p.addLine(to: cur)
            case "H": cur = CGPoint(x: next(), y: cur.y); p.addLine(to: cur)
            case "V": cur = CGPoint(x: cur.x, y: next()); p.addLine(to: cur)
            case "C": let c1 = CGPoint(x: next(), y: next()), c2 = CGPoint(x: next(), y: next()); cur = CGPoint(x: next(), y: next())
                      p.addCurve(to: cur, control1: c1, control2: c2)
            case "Q": let c = CGPoint(x: next(), y: next()); cur = CGPoint(x: next(), y: next()); p.addQuadCurve(to: cur, control: c)
            default: i += 1
            }
        }
        return p
    }
}
