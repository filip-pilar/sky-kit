import XCTest
import CoreGraphics
import Metal
@testable import SkyKit

final class SkyKitTests: XCTestCase {
    func testSymbolPathData() {
        let box = SkySymbol.path("M10 20L90 20V80H10Z").boundingBox
        XCTAssertEqual(box, CGRect(x: 10, y: 20, width: 80, height: 60))
        let curve = SkySymbol.path("M0 0C0 10 10 10 10 0Q5 -5 0 0").boundingBoxOfPath
        XCTAssertEqual(curve.minX, 0, accuracy: 1e-9); XCTAssertEqual(curve.maxX, 10, accuracy: 1e-9)
        for s in SkySymbol.allCases { XCTAssertNotNil(s.image(height: 100), s.rawValue) }
    }

    /// A dot about as wide as the soft edge still has a clear core and its edge exactly on the outline.
    func testSmallPartsKeepACore() {
        let w = 64, h = 64
        var alpha = [Float](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w where hypot(Double(x) - 31.5, Double(y) - 31.5) < 7 { alpha[y * w + x] = 255 } }
        let r = ShapeMask.edgeChannel(alpha, w, h, soft: 5.6, smooth: 4)
        XCTAssertGreaterThan(r[32 * w + 32], 0.7 * 255, "the dot's centre")
        XCTAssertEqual(r[32 * w + 38] / 255, 0.5, accuracy: 0.15, "its edge sits at one half")
        XCTAssertEqual(r[2 * w + 2], 0, "far outside")
    }

    func testBlankShapesHaveNoArea() {
        XCTAssertLessThan(ShapeMask.make(.text(" "))?.silhouetteArea ?? 0, 1)
        XCTAssertGreaterThan(ShapeMask.make(.text("hi"))?.silhouetteArea ?? 0, 100)
        XCTAssertGreaterThan(ShapeMask.make(.text("❤️"))?.thickness ?? 0, 0.5, "an emoji is a solid shape")
    }

    /// Of two clouds, the one near the wanted spot and closer to the needed size wins, placed on its mass.
    func testFindCloud() {
        let gw = 60, gh = 40
        var grid = [UInt8](repeating: 0, count: gw * gh)
        func blob(_ cx: Int, _ cy: Int, _ r: Int) {
            for y in 0..<gh { for x in 0..<gw where (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r { grid[y * gw + x] = 200 } }
        }
        blob(15, 20, 6); blob(45, 20, 9)
        let step = 0.02, all = SIMD4(0.0, 0.0, Double(gw) * step, Double(gh) * step)
        let near = SkyRenderer.findCloud(grid: grid, gw: gw, gh: gh, origin: .zero, step: step, want: SIMD2(0.9, 0.4),
                                         need: 0.1, allowed: all, box: SIMD2(0.08, 0.05))
        XCTAssertEqual(near?.centre.x ?? 0, 0.9, accuracy: 0.1)
        XCTAssertNil(SkyRenderer.findCloud(grid: [UInt8](repeating: 0, count: gw * gh), gw: gw, gh: gh, origin: .zero, step: step,
                                           want: .zero, need: 0.1, allowed: all, box: SIMD2(0.08, 0.05)))
    }

    func testRendersAreDeterministic() throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("no Metal device") }
        let a = try SkyRenderer().renderImage(width: 320, height: 200, seconds: 4) { $0.showShape(.symbol(.star)) }
        let b = try SkyRenderer().renderImage(width: 320, height: 200, seconds: 4) { $0.showShape(.symbol(.star)) }
        XCTAssertEqual(a.dataProvider?.data, b.dataProvider?.data)
    }

    /// The controller builds shapes in the background but keeps their order (a queued word comes after the first).
    @MainActor
    func testControllerKeepsCallOrder() async throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("no Metal device") }
        let renderer = try SkyRenderer()
        _ = try renderer.renderImage(width: 320, height: 200)
        let sky = SkyController()
        sky.renderer = renderer
        sky.showShape(.text("one"))
        sky.showShape(.text("two"), queue: true)
        let deadline = Date().addingTimeInterval(30)   // (a debug build takes a second or two per mask)
        while sky.shapeState.next.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(sky.shapeState.label, "one")
        XCTAssertEqual(sky.shapeState.next, ["two"])
        sky.releaseShape()
        XCTAssertEqual(sky.shapeState.next, [])
    }
}
