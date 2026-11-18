import CoreGraphics
import CoreText
import Foundation
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif

/// What a cloud shape is made from.
public enum SkyShapeSource {
    /// Text or emoji, drawn in a rounded bold system font.
    case text(String)
    /// A silhouette image: transparent images use their alpha, opaque ones use dark = shape.
    case image(CGImage)
    /// One of the built-in symbols (a heart, a star, …).
    case symbol(SkySymbol)
}

/// What the shapes are doing (SkyRenderer.shapeState / SkyController.shapeState).
public struct SkyShapeState: Equatable, Sendable {
    public enum Phase: String, Sendable { case none, waiting, forming, holding, melting }
    /// none; waiting (queued, or its pause before forming); forming; holding; melting.
    public var phase: Phase
    /// The text or symbol on screen ("image" for an image).
    public var label: String?
    /// The labels of the shapes queued after it.
    public var next: [String]
    public init(phase: Phase, label: String?, next: [String]) { self.phase = phase; self.label = label; self.next = next }
    /// Nothing showing or queued.
    public static let idle = SkyShapeState(phase: .none, label: nil, next: [])
}

/// Silhouette turned into the channels the cloud shader uses (port of buildShapeImage in sky.js):
/// R = the shape (from the distance to its outline, see edgeChannel), G = a near halo, B = the shape's body
/// (very wide blur), A = a wide area: how near a point is to the shape (exactly 0 near the image's edge).
/// Rows are stored top-down (Metal texture order).
struct ShapeMask {
    let width: Int
    let height: Int
    let rgba: [UInt8]
    let silhouetteHeight: Int
    let silhouetteWidth: Int
    /// 0 = thin strokes (text) … 1 = a solid shape (a heart, an emoji).
    let thickness: Double
    /// Margin around the silhouette, in mask pixels (room for the wide area).
    let pad: Int
    /// The silhouette's area in mask pixels.
    let silhouetteArea: Double

    /// Built at 100 px per silhouette height (it is soft anyway; the blur radii below are for 220 px,
    /// scaled by `ms`), like sky.js.
    static func make(_ source: SkyShapeSource, pixelHeight px: Int = 100) -> ShapeMask? {
        let ms = Double(px) / 220
        guard let (sil, sw, sh) = silhouette(source, px: px) else { return nil }
        let pad = Int((Double(sh) * 2.2).rounded())   // room for the wide area (A)
        let w = sw + pad * 2, h = sh + pad * 2
        var alpha = [Float](repeating: 0, count: w * h)
        for y in 0..<sh { for x in 0..<sw { alpha[(y + pad) * w + x + pad] = sil[y * sw + x] } }
        let body = blur(alpha, w, h, radius: 70 * ms, scale: 2)                             // the shape's domed body
        // 0 = thin strokes (text) … 1 = a solid shape (a heart, an emoji): solid shapes get softer edges
        let thick = Double(min(1, max(0, ((body.max() ?? 0) / 255 - 0.6) / 0.3)))
        // the shape itself, from the distance to its edge
        let near = edgeChannel(alpha, w, h, soft: (5.6 + 2.5 * thick) * Double(px) / 100, smooth: 4 * Double(px) / 100)
        let wide = blur(alpha, w, h, radius: 44 * ms, scale: 2)
        // the wide area (A): a very wide blur, flattened (square root) so it reaches well out, ~1 at the shape, and faded to exactly 0
        // over the outer part of the margin (it times a morph, which must not change at the mask's edge)
        let far = blur(alpha, w, h, radius: Double(sh) * 1.2, scale: 4)
        let farMax = max(1e-3, far.max() ?? 0)
        func win(_ d: Int) -> Float {
            let x = min(1, max(0, (Float(d) - 0.17 * Float(pad)) / (0.28 * Float(pad)))); return x * x * (3 - 2 * x)   // all-zero over the outer 17%
        }
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        for y in 0..<h {
            let wy = win(min(y, h - 1 - y))
            for x in 0..<w {
                let i = y * w + x
                rgba[i * 4] = UInt8(min(255, near[i]))
                rgba[i * 4 + 1] = UInt8(min(255, wide[i] * 1.4))
                rgba[i * 4 + 2] = UInt8(min(255, body[i]))
                rgba[i * 4 + 3] = UInt8((255 * min(1, 1.2 * (far[i] / farMax).squareRoot()) * wy * win(min(x, w - 1 - x))).rounded())
            }
        }
        return ShapeMask(width: w, height: h, rgba: rgba, silhouetteHeight: sh, silhouetteWidth: sw, thickness: thick, pad: pad,
                         silhouetteArea: Double(sil.reduce(0, +)) / 255)
    }

    /// Alpha 0…255, top-down rows.
    private static func silhouette(_ source: SkyShapeSource, px: Int) -> ([Float], Int, Int)? {
        switch source {
        case .text(let string):
            let font = roundedBoldFont(size: CGFloat(px))
            let attr = NSAttributedString(string: string, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,   // draw in the context's white
            ])
            let line = CTLineCreateWithAttributedString(attr)
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            let lineW = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            let w = max(2, Int(ceil(lineW)) + 2), h = max(2, Int(ceil(CGFloat(px) * 1.15)))
            // on transparent, so the coverage (alpha) is the shape whatever the colours (emoji too), like the web version
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.textPosition = CGPoint(x: 1, y: (CGFloat(h) - (ascent + descent)) / 2 + descent)   // vertically centred baseline
            CTLineDraw(line, ctx)
            guard let data = ctx.data else { return nil }
            let p = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
            // CGContext memory is top-down already
            return ((0..<(w * h)).map { Float(p[$0 * 4 + 3]) }, w, h)
        case .symbol(let s):
            guard let img = s.image(height: px * 2) else { return nil }
            return silhouette(.image(img), px: px)
        case .image(let img):
            let h = px, w = max(2, Int((Double(px) * Double(img.width) / Double(img.height)).rounded()))
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let data = ctx.data else { return nil }
            let p = data.bindMemory(to: UInt8.self, capacity: w * h * 4)
            var transparent = false
            for i in 0..<(w * h) where p[i * 4 + 3] < 250 { transparent = true; break }
            var out = [Float](repeating: 0, count: w * h)
            for i in 0..<(w * h) {
                if transparent { out[i] = Float(p[i * 4 + 3]) }
                else {
                    let lum = (0.299 * Float(p[i * 4]) + 0.587 * Float(p[i * 4 + 1]) + 0.114 * Float(p[i * 4 + 2])) / 255
                    out[i] = (1 - lum) * 255
                }
            }
            return (out, w, h)
        }
    }

    /// Heavy rounded system font (SF Pro Rounded), falling back to the plain bold system font.
    private static func roundedBoldFont(size: CGFloat) -> CTFont {
        #if canImport(AppKit)
        let base = NSFont.systemFont(ofSize: size, weight: .heavy)
        let font = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size) } ?? base
        return font as CTFont
        #else
        let base = UIFont.systemFont(ofSize: size, weight: .heavy)
        let font = base.fontDescriptor.withDesign(.rounded).map { UIFont(descriptor: $0, size: size) } ?? base
        return font as CTFont
        #endif
    }

    /// Squared distance transform (Felzenszwalb & Huttenlocher), in place: f holds a squared offset on the seed
    /// pixels and 1e20 elsewhere, and ends up holding each pixel's squared distance (via the nearest seed, plus its
    /// offset). Port of edt in sky.js.
    static func edt(_ f: inout [Double], _ w: Int, _ h: Int) {
        let n = max(w, h)
        var g = [Double](repeating: 0, count: n), out = g, v = [Int](repeating: 0, count: n), z = [Double](repeating: 0, count: n + 1)
        func line(_ len: Int) {
            var k = 0; v[0] = 0; z[0] = -.infinity; z[1] = .infinity
            for q in 1..<max(1, len) {
                var s = ((g[q] + Double(q * q)) - (g[v[k]] + Double(v[k] * v[k]))) / Double(2 * q - 2 * v[k])
                while s <= z[k] { k -= 1; s = ((g[q] + Double(q * q)) - (g[v[k]] + Double(v[k] * v[k]))) / Double(2 * q - 2 * v[k]) }
                k += 1; v[k] = q; z[k] = s; z[k + 1] = .infinity
            }
            k = 0
            for q in 0..<len { while z[k + 1] < Double(q) { k += 1 }; out[q] = Double((q - v[k]) * (q - v[k])) + g[v[k]] }
            for q in 0..<len { g[q] = out[q] }
        }
        for x in 0..<w { for y in 0..<h { g[y] = f[y * w + x] }; line(h); for y in 0..<h { f[y * w + x] = g[y] } }
        for y in 0..<h { for x in 0..<w { g[x] = f[y * w + x] }; line(w); for x in 0..<w { f[y * w + x] = g[x] } }
    }
    /// The shape channel (R): 0.5 exactly on the silhouette's edge, rising to 1 within `soft` pixels inside it and
    /// falling to 0 within `soft` pixels outside, from the distance to the edge, so every part of the shape, however
    /// small (a dot, a thin stroke), keeps a solid core; lightly smoothed. 0…255. Port of edgeChannel in sky.js.
    static func edgeChannel(_ alpha: [Float], _ w: Int, _ h: Int, soft: Double, smooth: Double) -> [Float] {
        // the edge is where the (slightly smoothed, so any antialiasing looks alike) coverage crosses 1/2; the pixels
        // next to it are the seeds, each with its sub-pixel distance to it (coverage offset / slope)
        let n = w * h
        let c = blur(alpha, w, h, radius: 1.7)
        var f = [Double](repeating: 1e20, count: n), seed = [Double](repeating: 0, count: n), edge = [Bool](repeating: false, count: n)
        for y in 0..<h { for x in 0..<w {
            let i = y * w + x, v = Double(c[i]) / 255
            if abs(v - 0.5) > 0.35 { continue }
            let gx = Double(c[x < w - 1 ? i + 1 : i] - c[x > 0 ? i - 1 : i]) / 510, gy = Double(c[y < h - 1 ? i + w : i] - c[y > 0 ? i - w : i]) / 510
            let d = (v - 0.5) / max(0.05, (gx * gx + gy * gy).squareRoot())
            if abs(d) <= 2 { edge[i] = true; f[i] = d * d; seed[i] = d }
        } }
        edt(&f, w, h)
        var r = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let sd = edge[i] ? seed[i] : (c[i] >= 127.5 ? 1 : -1) * f[i].squareRoot()   // signed distance, + inside
            r[i] = Float(255 * min(1, max(0, 0.5 + sd / (2 * soft))))
        }
        return blur(r, w, h, radius: smooth)
    }
    /// The blur at 1/k resolution (box-averaged down, bilinear back up). Port of blurAt in sky.js.
    private static func blur(_ src: [Float], _ w: Int, _ h: Int, radius: Double, scale k: Int) -> [Float] {
        let sw = (w + k - 1) / k, sh = (h + k - 1) / k
        var small = [Float](repeating: 0, count: sw * sh)
        for y in 0..<h { let row = (y / k) * sw; for x in 0..<w { small[row + x / k] += src[y * w + x] } }
        for y in 0..<sh { for x in 0..<sw { small[y * sw + x] /= Float(min(k, w - x * k) * min(k, h - y * k)) } }
        let b = blur(small, sw, sh, radius: radius / Double(k))
        var out = [Float](repeating: 0, count: w * h)
        for y in 0..<h {
            let fy = min(Float(sh - 1), max(0, (Float(y) + 0.5) / Float(k) - 0.5)), y0 = Int(fy), y1 = min(sh - 1, y0 + 1), ty = fy - Float(y0)
            for x in 0..<w {
                let fx = min(Float(sw - 1), max(0, (Float(x) + 0.5) / Float(k) - 0.5)), x0 = Int(fx), x1 = min(sw - 1, x0 + 1), tx = fx - Float(x0)
                out[y * w + x] = (b[y0 * sw + x0] * (1 - tx) + b[y0 * sw + x1] * tx) * (1 - ty) + (b[y1 * sw + x0] * (1 - tx) + b[y1 * sw + x1] * tx) * ty
            }
        }
        return out
    }
    /// Three box-blur passes each way (close to a Gaussian). Port of blurAlpha in sky.js.
    private static func blur(_ src: [Float], _ w: Int, _ h: Int, radius: Double) -> [Float] {
        var a = src, b = [Float](repeating: 0, count: w * h)
        let r = max(1, Int((radius / 1.7).rounded()))
        let norm = Float(2 * r + 1)
        func pass(_ s: [Float], _ d: inout [Float], lines: Int, len: Int, stride: Int, step: Int) {
            for i in 0..<lines {
                let base = i * stride
                var acc: Float = 0
                for k in -r...r { acc += s[base + min(len - 1, max(0, k)) * step] }
                for j in 0..<len {
                    d[base + j * step] = acc / norm
                    acc += s[base + min(len - 1, j + r + 1) * step] - s[base + max(0, j - r) * step]
                }
            }
        }
        for _ in 0..<3 {
            pass(a, &b, lines: h, len: w, stride: w, step: 1)
            pass(b, &a, lines: w, len: h, stride: 1, step: w)
        }
        return a
    }
}
