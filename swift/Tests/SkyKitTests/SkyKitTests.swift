import XCTest
import Metal
@testable import SkyKit

// Only what the regression scenes can't see (bun run regress renders both ports pixel by pixel): Swift's lanes
// for several ids, and the controller building shapes in the background.
final class SkyKitTests: XCTestCase {
    /// Shapes with different ids are on screen together; releasing one id leaves the others; a 4th id takes over the
    /// one used longest ago; and a shape with no room beside the others takes over instead of overlapping.
    func testShapesWithIds() throws {
        guard MTLCreateSystemDefaultDevice() != nil else { throw XCTSkip("no Metal device") }
        let r = try SkyRenderer()
        func run(_ s: Double) throws { _ = try r.renderImage(width: 640, height: 400, seconds: s) }
        try run(0)
        XCTAssertTrue(r.showShape(.symbol(.heart), x: 0.2, size: 0.15, hold: 60, id: "a"))
        XCTAssertTrue(r.showShape(.symbol(.star), x: 0.6, size: 0.15, hold: 60, id: "b"))
        try run(1)
        XCTAssertEqual(Set(r.shapeStates.keys), ["a", "b"])
        r.releaseShape(id: "a")
        try run(9)   // (it melts within its fade)
        XCTAssertEqual(Set(r.shapeStates.keys), ["b"])
        XCTAssertTrue(r.showShape(.symbol(.sun), size: 0.15, hold: 60, id: "c"))
        XCTAssertTrue(r.showShape(.symbol(.moon), size: 0.15, hold: 60, id: "d"))
        try run(1)
        XCTAssertEqual(Set(r.shapeStates.keys), ["b", "c", "d"])
        XCTAssertTrue(r.showShape(.symbol(.bolt), size: 0.15, hold: 60, id: "e"))   // (b was used longest ago)
        try run(1)
        XCTAssertEqual(Set(r.shapeStates.keys), ["c", "d", "e"])
        r.clearShape(id: "c")
        XCTAssertEqual(Set(r.shapeStates.keys), ["d", "e"])
        r.clearShape()
        XCTAssertTrue(r.shapeStates.isEmpty)
        // two hearts too big to fit side by side: the second takes over the first
        XCTAssertTrue(r.showShape(.symbol(.heart), size: 0.9, hold: 60, id: "p"))
        try run(1)
        XCTAssertTrue(r.showShape(.symbol(.heart), size: 0.9, hold: 60, id: "q"))
        try run(1)
        XCTAssertEqual(Set(r.shapeStates.keys), ["q"])
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
