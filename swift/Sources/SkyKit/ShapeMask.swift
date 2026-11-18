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
}

/// Silhouette turned into the two blurred channels the cloud shader uses (port of buildShapeImage in sky.js):
/// R = the shape (soft blur), G = a near halo, B = the shape's body (very wide blur),
/// A = the wide area the shape gathers from and dissolves into (exactly 0 near the image's edge).
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

    /// Built at 100 px per silhouette height (it is heavily blurred anyway; the radii below are for 220 px,
    /// scaled by `ms`), like sky.js.
    static func make(_ source: SkyShapeSource, pixelHeight px: Int = 100) -> ShapeMask? {
        let ms = Double(px) / 220
        guard let (sil, sw, sh) = silhouette(source, px: px) else { return nil }
        let pad = Int((Double(sh) * 2.2).rounded())   // room for the wide area the shape gathers from
        let w = sw + pad * 2, h = sh + pad * 2
        var alpha = [Float](repeating: 0, count: w * h)
        for y in 0..<sh { for x in 0..<sw { alpha[(y + pad) * w + x + pad] = sil[y * sw + x] } }
        let body = blur(alpha, w, h, radius: 70 * ms, scale: 2)                             // the shape's domed body
        // thick, solid shapes (a heart, an emoji) get soft cloud edges like the clouds around them;
        // thin strokes (text) stay crisp enough to read
        let thick = Double(min(1, max(0, ((body.max() ?? 0) / 255 - 0.6) / 0.3)))
        let near = blur(alpha, w, h, radius: (16 + 8 * thick) * ms), wide = blur(alpha, w, h, radius: 44 * ms, scale: 2)
        // the wide area: a very wide blur, flattened (square root) so it reaches well out, ~1 at the shape, and faded to exactly 0 over the
        // outer part of the margin (the patch blends into the ordinary clouds there)
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
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
            ctx.setFillColor(gray: 0, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.textPosition = CGPoint(x: 1, y: (CGFloat(h) - (ascent + descent)) / 2 + descent)   // vertically centred baseline
            CTLineDraw(line, ctx)
            guard let data = ctx.data else { return nil }
            let p = data.bindMemory(to: UInt8.self, capacity: w * h)
            // CGContext memory is top-down already
            return ((0..<(w * h)).map { Float(p[$0]) }, w, h)
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
