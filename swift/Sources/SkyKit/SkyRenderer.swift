import Foundation
import Metal
import CoreGraphics
import QuartzCore
import simd

/// Renders the sky with Metal. Same pipeline as the web version:
/// each cloud layer is painted into snapshot textures a bit wider than the view; every frame
/// only slides them and crossfades to the next snapshot, which is painted a strip per frame.
public final class SkyRenderer {
    public enum RendererError: Error { case noDevice, pipeline(String), readback }

    public var options: SkyOptions {
        didSet { optionsChanged(from: oldValue) }
    }
    /// Seconds of sky time so far.
    public private(set) var simTime: Double = 0
    /// Set by the host view; when true and options.respectReducedMotion is on, the sky holds still.
    public var reduceMotion = false

    public let device: MTLDevice
    let queue: MTLCommandQueue
    private let library: MTLLibrary
    private let cloudPipeline: MTLRenderPipelineState
    private var compositePipelines: [MTLPixelFormat: MTLRenderPipelineState] = [:]
    private let emptyTexture: MTLTexture

    // Same constants as web/src/sky.js
    private static let dt = 2.0, strips = 24, margin = 0.3, maxGusts = 12, planeSpeed = 0.06
    private static let qualityFactor: [SkyOptions.Quality: Double] = [.high: 1.25, .balanced: 1.0, .low: 0.75]
    private struct LayerDef { let scale: Double, seed: SIMD2<Double>, speed: Double, morph: Double, haze: Double, farMask: Double, push: Double }
    private static let layerDefs = [
        LayerDef(scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1, push: 0.4),
        LayerDef(scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0, farMask: 0, push: 1.0),
    ]
    private final class Snap { let tex: MTLTexture; var time = 0.0; var x0 = 0.0; var strip = SkyRenderer.strips; init(_ t: MTLTexture) { tex = t } }
    private struct Layer { let def: LayerDef; var snaps: [Snap] }

    private var layers: [Layer] = []
    private var width = 0, height = 0, pixelsPerPoint = 1.0
    private var unit = 1.0, viewH = 1.0, cacheW = 1, cacheH = 1, winW = 1.0
    private var needsSetup = true, needsRebuild = false

    // extras
    private struct Gust { var x, y, dx, dy: Double; var born: CFTimeInterval }
    private struct Plane { var x, y, dx, dy: Double; var age = 0.0 }
    private struct Shape { let texture: MTLTexture; var rect: SIMD4<Float>; var t0: Double; let form, hold, fade: Double }
    private struct PendingShape { let mask: ShapeMask; let x, y, size, form, hold, fade: Double }
    private var gusts: [Gust] = []
    private var lastPointer: (x: Double, y: Double, t: CFTimeInterval)?
    private var planes: [Plane] = []
    private var nextPlane = 8.0
    private var shape: Shape?
    private var pendingShape: PendingShape?

    // GPU parameter blocks (all float4, so Swift and Metal layouts match)
    private struct GPUColors { var top: SIMD4<Float>, mid: SIMD4<Float>, low: SIMD4<Float> }
    private struct CloudParams { var a, b, c, d, shapeRect: SIMD4<Float>; var sky: GPUColors }
    private struct CompositeParams { var a, far, near, scroll: SIMD4<Float>; var sky: GPUColors }

    public init(device: MTLDevice? = MTLCreateSystemDefaultDevice(), options: SkyOptions = SkyOptions()) throws {
        guard let device, let queue = device.makeCommandQueue() else { throw RendererError.noDevice }
        self.device = device
        self.queue = queue
        self.options = options
        let compile = MTLCompileOptions()
        if #available(macOS 15.0, iOS 18.0, *) { compile.mathMode = .safe } else { compile.fastMathEnabled = false }
        do { library = try device.makeLibrary(source: SkyShaders.source, options: compile) }
        catch { throw RendererError.pipeline("\(error)") }
        cloudPipeline = try Self.makePipeline(device, library, fragment: "sky_cloud", format: .rgba8Unorm)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
        d.usage = [.shaderRead]
        guard let empty = device.makeTexture(descriptor: d) else { throw RendererError.noDevice }
        var zero: [UInt8] = [0, 0, 0, 0]
        empty.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &zero, bytesPerRow: 4)
        emptyTexture = empty
    }

    private static func makePipeline(_ device: MTLDevice, _ lib: MTLLibrary, fragment: String, format: MTLPixelFormat) throws -> MTLRenderPipelineState {
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "sky_fullscreen")
        d.fragmentFunction = lib.makeFunction(name: fragment)
        d.colorAttachments[0].pixelFormat = format
        do { return try device.makeRenderPipelineState(descriptor: d) }
        catch { throw RendererError.pipeline("\(fragment): \(error)") }
    }
    private func compositePipeline(for format: MTLPixelFormat) throws -> MTLRenderPipelineState {
        if let p = compositePipelines[format] { return p }
        let p = try Self.makePipeline(device, library, fragment: "sky_composite", format: format)
        compositePipelines[format] = p
        return p
    }

    // MARK: - Sizing and options

    /// Call when the drawable size changes (pixels) and with the screen's pixels-per-point.
    public func resize(width: Int, height: Int, pixelsPerPoint: Double) {
        let w = max(1, width), h = max(1, height)
        guard w != self.width || h != self.height || pixelsPerPoint != self.pixelsPerPoint else { return }
        self.width = w; self.height = h; self.pixelsPerPoint = pixelsPerPoint
        needsSetup = true
    }

    private func optionsChanged(from old: SkyOptions) {
        if old.direction != options.direction { shape = nil; pendingShape = nil }   // a placed shape belongs to the old drift
        if old.cloudScale != options.cloudScale || old.quality != options.quality { needsSetup = true }
        else if old.coverage != options.coverage || old.shadow != options.shadow || old.seed != options.seed
                    || old.direction != options.direction || old.palette != options.palette || old.colors != options.colors { needsRebuild = true }
    }

    /// Jump to a moment of sky time (the clouds are repainted for that moment on the next update).
    public func seek(to time: Double) { simTime = max(0, time); layers = []; needsSetup = true }

    private var dir: Double { options.direction == .right ? -1 : 1 }
    private var effectiveSpeed: Double { options.respectReducedMotion && reduceMotion ? 0 : options.speed }
    /// True while anything is moving (the host can pause its display link otherwise).
    public var isAnimating: Bool { effectiveSpeed > 0 || !gusts.isEmpty }

    private func setup() {
        let q = min(1, max(0.35, (Self.qualityFactor[options.quality] ?? 1.25) / pixelsPerPoint))
        unit = cloudUnit(width: Double(width), height: Double(height), cloudScale: options.cloudScale)
        viewH = Double(height) / unit
        cacheH = max(1, Int((Double(height) * q).rounded()))
        let upp = viewH / Double(cacheH)
        cacheW = Int(ceil((Double(width) / unit + 2 * Self.margin) / upp))
        winW = Double(cacheW) * upp
        let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: cacheW, height: cacheH, mipmapped: false)
        desc.usage = [.renderTarget, .shaderRead]
        desc.storageMode = .private
        let starts = layers.map { $0.snaps.first?.time ?? simTime }
        layers = Self.layerDefs.enumerated().map { i, def in
            let t0 = i < starts.count ? starts[i] : simTime
            let snaps = (0..<3).map { k -> Snap in
                let s = Snap(device.makeTexture(descriptor: desc)!)
                place(def, s, time: t0 + Double(k) * Self.dt)
                return s
            }
            return Layer(def: def, snaps: snaps)
        }
    }
    private func place(_ def: LayerDef, _ s: Snap, time: Double) { s.time = time; s.x0 = dir * def.speed * time - Self.margin }

    // MARK: - Painting

    private func gpuColors() -> GPUColors {
        let c = options.resolvedColors
        return GPUColors(top: SIMD4(c.top, 0), mid: SIMD4(c.mid, 0), low: SIMD4(c.low, 0))
    }
    private func shapeAmount(at t: Double) -> Double {
        guard let s = shape else { return 0 }
        let a = t - s.t0
        func smooth(_ x: Double) -> Double { let v = min(max(x, 0), 1); return v * v * (3 - 2 * v) }
        if a <= 0 { return 0 }
        if a < s.form { return smooth(a / s.form) }
        if a < s.form + s.hold { return 1 }
        return 1 - smooth((a - s.form - s.hold) / s.fade)
    }
    private func paint(_ def: LayerDef, isNear: Bool, _ s: Snap, strip: Int, _ cb: MTLCommandBuffer) {
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = s.tex
        rp.colorAttachments[0].loadAction = strip >= 0 ? .load : .dontCare   // keep the strips painted so far
        rp.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { return }
        enc.setRenderPipelineState(cloudPipeline)
        if strip >= 0 {
            let x = cacheW * strip / Self.strips, x2 = cacheW * (strip + 1) / Self.strips
            enc.setScissorRect(MTLScissorRect(x: x, y: 0, width: max(1, x2 - x), height: cacheH))
        }
        let seed = def.seed + SIMD2(options.seed * 7.31, options.seed * 3.17)
        let amt = isNear ? shapeAmount(at: s.time) : 0
        var p = CloudParams(
            a: SIMD4(Float(s.x0), 0, Float(viewH / Double(cacheH)), Float(viewH)),
            b: SIMD4(Float(s.time * def.morph), Float(def.scale), Float(options.coverage), Float(options.shadow)),
            c: SIMD4(Float(def.haze), Float(def.farMask), Float(seed.x), Float(seed.y)),
            d: SIMD4(Float(cacheH), Float(amt), 0, 0),
            shapeRect: shape?.rect ?? SIMD4(0, 0, 1, 1),
            sky: gpuColors())
        enc.setFragmentBytes(&p, length: MemoryLayout<CloudParams>.stride, index: 0)
        enc.setFragmentTexture(amt > 0 ? shape?.texture ?? emptyTexture : emptyTexture, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }
    private func rebuildAll(_ cb: MTLCommandBuffer) {
        for (i, l) in layers.enumerated() {
            let t0 = l.snaps[0].time
            for (k, s) in l.snaps.enumerated() { place(l.def, s, time: t0 + Double(k) * Self.dt); paint(l.def, isNear: i == 1, s, strip: -1, cb); s.strip = Self.strips }
        }
    }
    private func advance(_ i: Int, _ cb: MTLCommandBuffer) {
        while simTime >= layers[i].snaps[1].time {
            let a = layers[i].snaps[0], b = layers[i].snaps[1], c = layers[i].snaps[2]
            while c.strip < Self.strips { paint(layers[i].def, isNear: i == 1, c, strip: c.strip, cb); c.strip += 1 }
            place(layers[i].def, a, time: c.time + Self.dt); a.strip = 0
            layers[i].snaps = [b, c, a]
        }
        let c = layers[i].snaps[2]
        if c.strip < Self.strips { paint(layers[i].def, isNear: i == 1, c, strip: c.strip, cb); c.strip += 1 }
    }

    // MARK: - Per-frame API

    /// Advance the sky by `dt` real seconds and paint the next snapshot strips into `commandBuffer`.
    public func update(dt: Double, commandBuffer cb: MTLCommandBuffer) {
        if needsSetup { setup(); rebuildAll(cb); needsSetup = false; needsRebuild = false }
        if needsRebuild { rebuildAll(cb); needsRebuild = false }
        if let p = pendingShape { pendingShape = nil; placeShape(p) }
        let sdt = max(0, min(dt, 0.1)) * effectiveSpeed
        simTime += sdt
        updatePlanes(sdt)
        for i in layers.indices { advance(i, cb) }
    }

    /// Draw the current frame into `target` (any color texture the size passed to `resize`).
    public func draw(to target: MTLTexture, commandBuffer cb: MTLCommandBuffer) throws {
        guard layers.count == 2 else { return }
        let pipeline = try compositePipeline(for: target.pixelFormat)
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = target
        rp.colorAttachments[0].loadAction = .dontCare
        rp.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { return }
        enc.setRenderPipelineState(pipeline)
        // offsets of the view inside each snapshot, subtracted here in double precision (stays exact on long runs)
        func win(_ l: Layer) -> SIMD4<Float> {
            let scroll = dir * l.def.speed * simTime
            return SIMD4(Float(scroll - l.snaps[0].x0), Float(scroll - l.snaps[1].x0), Float(winW),
                         Float(min(1, max(0, (simTime - l.snaps[0].time) / Self.dt))))
        }
        var p = CompositeParams(
            a: SIMD4(Float(width), Float(height), Float(unit), Float(viewH)),
            far: win(layers[0]), near: win(layers[1]),
            scroll: SIMD4(0, 0, Float(layers[0].def.push), Float(layers[1].def.push)),
            sky: gpuColors())
        var extra = extraParams(now: CACurrentMediaTime())
        enc.setFragmentBytes(&p, length: MemoryLayout<CompositeParams>.stride, index: 0)
        enc.setFragmentBytes(&extra, length: MemoryLayout<SIMD4<Float>>.stride * extra.count, index: 1)
        enc.setFragmentTexture(layers[0].snaps[0].tex, index: 0); enc.setFragmentTexture(layers[0].snaps[1].tex, index: 1)
        enc.setFragmentTexture(layers[1].snaps[0].tex, index: 2); enc.setFragmentTexture(layers[1].snaps[1].tex, index: 3)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    /// ExtraParams in the shader: 12 gusts, 2 planes, info, info2 (16 float4).
    private func extraParams(now: CFTimeInterval) -> [SIMD4<Float>] {
        gusts.removeAll { now - $0.born > 5 }
        var out = [SIMD4<Float>](repeating: .zero, count: 16)
        for (i, g) in gusts.prefix(Self.maxGusts).enumerated() {
            let age = now - g.born
            let env = min(age / 0.15, 1) * exp(-max(age - 0.15, 0) / 1.1)   // push, then settle back
            out[i] = SIMD4(Float(g.x), Float(g.y), Float(g.dx * env), Float(g.dy * env))
        }
        var ages: [Float] = [-1, -1]
        for (i, pl) in planes.prefix(2).enumerated() {
            out[12 + i] = SIMD4(Float(pl.x), Float(pl.y), Float(pl.dx), Float(pl.dy))
            ages[i] = Float(pl.age)
        }
        out[14] = SIMD4(Float(min(gusts.count, Self.maxGusts)), ages[0], ages[1], Float(Self.planeSpeed))
        out[15] = SIMD4(Float(options.trailLife), Float(-dir * layers[0].def.speed), 0, 0)
        return out
    }

    // MARK: - Pointer push

    /// Report the pointer position (points, top-left origin, within a view of `size` points).
    /// Moving the pointer pushes the clouds along, then they settle back. Needs options.interactive.
    public func pointerMoved(to point: CGPoint, in size: CGSize) {
        guard options.interactive, unit > 0 else { return }
        let x = Double(point.x) * pixelsPerPoint / unit
        let y = Double(size.height - point.y) * pixelsPerPoint / unit
        let now = CACurrentMediaTime()
        guard let last = lastPointer else { lastPointer = (x, y, now); return }
        let dt = max(now - last.t, 0.008)
        let dx = x - last.x, dy = y - last.y
        guard hypot(dx, dy) > 0.015 else { return }
        var vx = dx / dt, vy = dy / dt
        let sp = hypot(vx, vy), cap = 0.6
        if sp > cap { vx *= cap / sp; vy *= cap / sp }
        gusts.append(Gust(x: x, y: y, dx: vx * 0.09, dy: vy * 0.09, born: now))
        if gusts.count > Self.maxGusts { gusts.removeFirst() }
        lastPointer = (x, y, now)
    }
    /// Call when the pointer leaves the view.
    public func pointerEnded() { lastPointer = nil }

    // MARK: - Planes

    /// Send a plane across. Points are 0…1 of the view with y = 0 at the bottom; nil = from a random side.
    public func flyPlane(from: CGPoint? = nil, to: CGPoint? = nil) {
        guard unit > 0 else { return }
        let vw = Double(width) / unit
        if let from, let to {
            launchPlane(x: Double(from.x) * vw, y: Double(from.y) * viewH,
                        dx: Double(to.x - from.x) * vw, dy: Double(to.y - from.y) * viewH)
        } else { randomPlane() }
    }
    private func launchPlane(x: Double, y: Double, dx: Double, dy: Double) {
        let l = max(hypot(dx, dy), 1e-9)
        if planes.count >= 2 { planes.removeFirst() }
        planes.append(Plane(x: x, y: y, dx: dx / l, dy: dy / l))
    }
    private func randomPlane() {
        let vw = Double(width) / unit
        let fromLeft = Bool.random(), y = viewH * Double.random(in: 0.5...0.9), ang = Double.random(in: -0.175...0.175)
        launchPlane(x: fromLeft ? -0.05 : vw + 0.05, y: y, dx: cos(ang) * (fromLeft ? 1 : -1), dy: sin(ang))
    }
    private func updatePlanes(_ dt: Double) {
        guard unit > 0 else { return }
        let vw = Double(width) / unit
        for i in planes.indices { planes[i].age += dt }
        planes.removeAll { $0.age > (vw + 0.6) / Self.planeSpeed + options.trailLife * 3 }
        if options.planes, dt > 0 {
            nextPlane -= dt
            if nextPlane <= 0 { randomPlane(); nextPlane = Double.random(in: 25...60) }
        }
    }

    // MARK: - Shapes

    /// Clouds gather into a shape, hold it, then melt back into ordinary clouds while drifting.
    /// x, y: centre, 0…1 of the view (y = 0 at the bottom); size: fraction of the view height; times in seconds.
    /// Needs speed > 0: shapes form as the sky moves on.
    @discardableResult
    public func showShape(_ source: SkyShapeSource, x: Double = 0.5, y: Double = 0.6, size: Double = 0.32,
                          form: Double = 4, hold: Double = 6, fade: Double = 8) -> Bool {
        guard let mask = ShapeMask.make(source) else { return false }
        let p = PendingShape(mask: mask, x: x, y: y, size: size, form: form, hold: hold, fade: fade)
        if layers.count == 2 { placeShape(p) } else { pendingShape = p }
        return true
    }
    public func clearShape() { shape = nil; pendingShape = nil }

    private func placeShape(_ p: PendingShape) {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: p.mask.width, height: p.mask.height, mipmapped: false)
        d.usage = [.shaderRead]
        guard let tex = device.makeTexture(descriptor: d) else { return }
        p.mask.rgba.withUnsafeBytes { tex.replace(region: MTLRegionMake2D(0, 0, p.mask.width, p.mask.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: p.mask.width * 4) }
        let near = layers[1]
        let t0 = near.snaps[2].time                       // first snapshot not painted yet
        let vw = Double(width) / unit
        let hUnits = p.size * viewH * Double(p.mask.height) / Double(p.mask.silhouetteHeight)
        let wUnits = hUnits * Double(p.mask.width) / Double(p.mask.height)
        let cx = p.x * vw + dir * near.def.speed * t0, cy = p.y * viewH
        shape = Shape(texture: tex, rect: SIMD4(Float(cx - wUnits / 2), Float(cy - hUnits / 2), Float(wUnits), Float(hUnits)),
                      t0: t0, form: p.form, hold: p.hold, fade: p.fade)
    }

    // MARK: - Offscreen

    /// Render a still image offscreen: simulates `seconds` of sky time at 30 fps, then draws.
    /// `prepare` runs once the sky is set up (e.g. to start a shape or a plane). Useful for wallpapers, thumbnails, tests.
    public func renderImage(width: Int, height: Int, pixelsPerPoint: Double = 2, seconds: Double = 0,
                            prepare: ((SkyRenderer) -> Void)? = nil) throws -> CGImage {
        resize(width: width, height: height, pixelsPerPoint: pixelsPerPoint)
        let frames = Int((seconds * 30).rounded())
        let saved = reduceMotion; reduceMotion = false
        defer { reduceMotion = saved }
        for i in 0...frames {   // first frame sets up at the current time, then 1/30 s steps (like the web version's _step)
            guard let cb = queue.makeCommandBuffer() else { throw RendererError.readback }
            update(dt: i == 0 ? 0 : 1.0 / 30.0, commandBuffer: cb)
            cb.commit()
            if i == 0, let prepare { prepare(self) }
        }
        let desc = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: false)
        desc.usage = [.renderTarget]; desc.storageMode = .private
        guard let tex = device.makeTexture(descriptor: desc),
              let buf = device.makeBuffer(length: width * height * 4, options: .storageModeShared),
              let cb = queue.makeCommandBuffer() else { throw RendererError.readback }
        try draw(to: tex, commandBuffer: cb)
        guard let blit = cb.makeBlitCommandEncoder() else { throw RendererError.readback }
        blit.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                  sourceSize: MTLSize(width: width, height: height, depth: 1),
                  to: buf, destinationOffset: 0, destinationBytesPerRow: width * 4, destinationBytesPerImage: width * height * 4)
        blit.endEncoding()
        cb.commit(); cb.waitUntilCompleted()
        let data = Data(bytes: buf.contents(), count: width * height * 4) as CFData
        guard let provider = CGDataProvider(data: data),
              let img = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        else { throw RendererError.readback }
        return img
    }
}
