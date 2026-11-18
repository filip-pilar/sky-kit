import Foundation
import simd

/// Picks the nearby clouds a shape is made from (port of planShape in sky.js; keep the two identical).
///
/// Input: a low-resolution map of the near clouds around the shape (how opaque each cell is, the most
/// over the shape's lifetime), rows bottom-up. Output: up to 4 whole clouds, each with clear sky around
/// it, and the part of the shape each one becomes.
struct ShapePlan {
    struct Copy {
        var box: SIMD4<Double>      // home box: centre x, y, half width, half height (cloud space)
        var centre: SIMD2<Double>   // the cloud's centre (density weighted)
        var target: SIMD2<Double>   // where its centre goes: the middle of its part of the shape
        var reach: Double           // how far its part of the shape extends from its centre
        var radius: Double          // the cloud's own size (radius of a disc of the same area)
        var rank: Int               // 0 = closest to the shape (it goes first)
    }
    static let step = 0.02          // cloud units per map cell
    static let margin = 0.035       // clear sky kept around each picked cloud's box (cloud units)

    /// - grid: opacity 0…255 per cell, `gw` × `gh`, rows bottom-up, cell (0, 0) centred at `origin` + step / 2
    /// - sil: the shape's silhouette box (x0, y0, x1, y1), cloud units; silH = its height; need = its area
    /// - viewH: the view's height (clouds mostly above or below it count less: they would arrive from out of view)
    static func plan(grid: [UInt8], gw: Int, gh: Int, origin: SIMD2<Double>, sil: SIMD4<Double>, silH: Double, need: Double, viewH: Double) -> [Copy] {
        let n = gw * gh
        guard n > 0, grid.count >= n else { return [] }
        let cloud = grid.map { $0 > 8 }
        // grow every cloud by R cells: clouds whose grown areas touch belong together (and a picked cloud
        // then has at least R cells of clear sky around it)
        let R = 2
        var rowMax = [Bool](repeating: false, count: n), grown = [Bool](repeating: false, count: n)
        for y in 0..<gh { for x in 0..<gw where cloud[y * gw + x] {
            for xx in max(0, x - R)...min(gw - 1, x + R) { rowMax[y * gw + xx] = true }
        } }
        for y in 0..<gh { for x in 0..<gw where rowMax[y * gw + x] {
            for yy in max(0, y - R)...min(gh - 1, y + R) { grown[yy * gw + x] = true }
        } }
        // label the grown areas (4-neighbour flood fill, scanning bottom-up)
        var label = [Int](repeating: -1, count: n)
        var count = 0
        for start in 0..<n where grown[start] && label[start] < 0 {
            var stack = [start]; label[start] = count
            while let i = stack.popLast() {
                let x = i % gw, y = i / gw
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < gw && ny < gh {
                    let j = ny * gw + nx
                    if grown[j] && label[j] < 0 { label[j] = count; stack.append(j) }
                }
            }
            count += 1
        }
        struct Blob { var cells = 0; var seen = 0; var wsum = 0.0; var cx = 0.0; var cy = 0.0; var x0 = Int.max, y0 = Int.max, x1 = -1, y1 = -1; var border = false }
        var blobs = [Blob](repeating: Blob(), count: count)
        for i in 0..<n where label[i] >= 0 {
            let x = i % gw, y = i / gw, l = label[i]
            if x == 0 || y == 0 || x == gw - 1 || y == gh - 1 { blobs[l].border = true }
            guard cloud[i] else { continue }
            let w = Double(grid[i])
            let cy = origin.y + (Double(y) + 0.5) * step
            blobs[l].cells += 1; blobs[l].wsum += w
            if cy >= 0 && cy <= viewH { blobs[l].seen += 1 }
            blobs[l].cx += w * Double(x); blobs[l].cy += w * Double(y)
            blobs[l].x0 = min(blobs[l].x0, x); blobs[l].x1 = max(blobs[l].x1, x)
            blobs[l].y0 = min(blobs[l].y0, y); blobs[l].y1 = max(blobs[l].y1, y)
        }
        let cell = step * step
        func centre(_ b: Blob) -> SIMD2<Double> {
            SIMD2(origin.x + (b.cx / b.wsum + 0.5) * step, origin.y + (b.cy / b.wsum + 0.5) * step)
        }
        func distToShape(_ c: SIMD2<Double>) -> Double {
            let dx = max(0, max(sil.x - c.x, c.x - sil.z)), dy = max(0, max(sil.y - c.y, c.y - sil.w))
            return (dx * dx + dy * dy).squareRoot()
        }
        // candidates: whole clouds (not cut by the map's edge), not far from the shape, mostly in view, not a
        // bank several times what the shape needs; closer and bigger first. If none qualifies, look again
        // with looser limits, then wider still (a shape should be made from some cloud whenever there is one).
        var cand: [(score: Double, index: Int, dist: Double)] = []
        for (dMax, areaMax, seenMin) in [(2.0, 3.0, 0.5), (3.5, 8.0, 0.25), (5.0, 12.0, 0.2)] where cand.isEmpty {
            for (l, b) in blobs.enumerated() where !b.border && b.cells >= 4 {
                let area = Double(b.cells) * cell, d = distToShape(centre(b)), seen = Double(b.seen) / Double(b.cells)
                guard d <= dMax * silH, seen >= seenMin, area <= areaMax * need else { continue }
                cand.append((area * exp(-d / (0.8 * silH)) / (1 + max(0, area / need - 1.5)) * seen, l, d))
            }
        }
        cand.sort { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index }
        // a picked cloud's box, with its margin, must hold no other cloud (it would be carried along) and
        // must not overlap another picked cloud's box
        let M = Int((margin / step).rounded(.up))
        func boxCells(_ b: Blob) -> (Int, Int, Int, Int) { (b.x0 - M, b.y0 - M, b.x1 + M, b.y1 + M) }
        func holdsOthers(_ l: Int) -> Bool {
            let (x0, y0, x1, y1) = boxCells(blobs[l])
            for y in max(0, y0)...min(gh - 1, y1) { for x in max(0, x0)...min(gw - 1, x1) {
                let i = y * gw + x
                if cloud[i] && label[i] != l { return true }
            } }
            return false
        }
        struct Pick { var box: SIMD4<Double>; var centre: SIMD2<Double>; var radius: Double; var dist: Double; var cells: (Int, Int, Int, Int) }
        func overlapsPicked(_ c: (Int, Int, Int, Int), _ picked: [Pick]) -> Bool {
            picked.contains { p in c.0 <= p.cells.2 && p.cells.0 <= c.2 && c.1 <= p.cells.3 && p.cells.1 <= c.3 }
        }
        var picked: [Pick] = []
        var have = 0.0
        for c in cand {
            if picked.count >= 4 || (have >= need && picked.count >= min(2, cand.count)) { break }
            let b = blobs[c.index], cells = boxCells(b)
            if overlapsPicked(cells, picked) || holdsOthers(c.index) { continue }
            let box = SIMD4(origin.x + Double(b.x0 + b.x1 + 1) / 2 * step, origin.y + Double(b.y0 + b.y1 + 1) / 2 * step,
                            Double(b.x1 - b.x0 + 1) / 2 * step, Double(b.y1 - b.y0 + 1) / 2 * step)
            picked.append(Pick(box: box, centre: centre(b), radius: (Double(b.cells) * cell / .pi).squareRoot(), dist: c.dist, cells: cells))
            have += Double(b.cells) * cell
        }
        // no separate cloud qualifies (they have all joined into big masses): the shape grows out of the
        // nearest big cloud instead, from its point closest to the shape (that cloud stays put; a box of
        // size 0 moves nothing)
        if picked.isEmpty {
            var best: (d: Double, c: SIMD2<Double>)? = nil
            for y in 0..<gh { for x in 0..<gw where cloud[y * gw + x] {
                let c = SIMD2(origin.x + (Double(x) + 0.5) * step, origin.y + (Double(y) + 0.5) * step)
                guard c.y >= 0 && c.y <= viewH else { continue }
                let d = distToShape(c)
                if d <= 5 * silH && (best == nil || d < best!.d) { best = (d, c) }
            } }
            guard let b = best else { return [] }
            let far = [SIMD2(sil.x, sil.y), SIMD2(sil.z, sil.y), SIMD2(sil.x, sil.w), SIMD2(sil.z, sil.w)].map { simd_distance($0, b.c) }.max()!
            return [Copy(box: SIMD4(b.c.x, b.c.y, 0, 0), centre: b.c, target: b.c, reach: far, radius: 0, rank: 0)]
        }
        // the order clouds go in (closest first) and their parts of the shape (left to right, matching
        // the clouds' order left to right, so their paths don't cross)
        let byDist = picked.indices.sorted { picked[$0].dist != picked[$1].dist ? picked[$0].dist < picked[$1].dist : $0 < $1 }
        var rank = [Int](repeating: 0, count: picked.count)
        for (r, pi) in byDist.enumerated() { rank[pi] = r }
        let order = picked.indices.sorted { picked[$0].centre.x != picked[$1].centre.x ? picked[$0].centre.x < picked[$1].centre.x : $0 < $1 }
        let k = Double(picked.count), sw = sil.z - sil.x, sh = sil.w - sil.y
        var out: [Copy] = []
        for (slot, pi) in order.enumerated() {
            let p = picked[pi]
            let target = SIMD2(sil.x + (Double(slot) + 0.5) / k * sw, sil.y + sh / 2)
            out.append(Copy(box: p.box, centre: p.centre, target: target, reach: sw / (2 * k) + sh / 2, radius: p.radius, rank: rank[pi]))
        }
        return out
    }
}
