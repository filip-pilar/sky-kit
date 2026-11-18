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
    private static let margin = 0.3, planeSpeed = 0.06
    private static let qualityFactor: [SkyOptions.Quality: Double] = [.high: 1.25, .balanced: 1.0, .low: 0.75]
    /// dt: seconds of sky time between snapshots; strips: frames used to paint one snapshot.
    private struct LayerDef { let scale: Double, seed: SIMD2<Double>, speed: Double, morph: Double, haze: Double, farMask: Double, dt: Double, strips: Int }
    private static let layerDefs = [
        LayerDef(scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1, dt: 2.0, strips: 24),
        LayerDef(scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0, farMask: 0, dt: 2.0, strips: 24),
    ]
    private final class Snap { let tex: MTLTexture; var time = 0.0; var x0 = 0.0; var strip: Int; init(_ t: MTLTexture, strips: Int) { tex = t; strip = strips } }
    private struct Layer { let def: LayerDef; var snaps: [Snap] }

    private var layers: [Layer] = []
    private var width = 0, height = 0, pixelsPerPoint = 1.0
    private var unit = 1.0, viewH = 1.0, cacheW = 1, cacheH = 1, winW = 1.0
    private var needsSetup = true, needsRebuild = false

    // extras
    private struct Plane { var x, y, dx, dy: Double; var age = 0.0 }
    /// A shape and its live patch: the near clouds over the shape's area, rendered every drawn frame.
    private final class Shape {
        let texture: MTLTexture; let rect: SIMD4<Double>; let t0, form, hold, fade: Double
        let thickness: Double, blend: Double   // blend: width of the patch's blend border (inside the mask's all-zero margin)
        var patch: MTLTexture?; var patchView = SIMD4<Double>(0, 0, 1, 1); var patchUV = SIMD2<Double>(1, 1); var patchReady = false
        var density = 0.5                                   // how dense the finished shape is (0.5 = like the clouds around)
        var src: MTLTexture?; var srcRect = SIMD4<Double>(0, 0, 1, 1)   // map of the cloud it is made from (only that cloud gives way)
        var cloudAt = SIMD2<Double>(0, 0)                   // where that cloud is (the next queued shape forms on it)
        var prev: (texture: MTLTexture, rect: SIMD4<Double>, thickness: Double)?   // the shape it turns straight from
        var area = SIMD4<Double>(0, 0, 1, 1)                // the live patch's area (both shapes while one turns into the other)
        init(texture: MTLTexture, rect: SIMD4<Double>, t0: Double, form: Double, hold: Double, fade: Double, thickness: Double, blend: Double) {
            self.texture = texture; self.rect = rect; self.t0 = t0; self.form = form; self.hold = hold; self.fade = fade
            self.thickness = thickness; self.blend = blend
        }
        var holdEnd: Double { t0 + form + hold }
        var end: Double { t0 + form + hold + fade }
    }
    private struct PendingShape {
        let mask: ShapeMask; let x, y, size, form, hold, fade, density: Double; var pause: Double
        var near: SIMD2<Double>? = nil    // form on the cloud there (the previous shape's)
        var startAt: Double? = nil        // start forming then (the previous shape's end + pause)
        var from: Shape? = nil            // turn straight from this shape (pause 0)
    }
    private var planes: [Plane] = []
    private var nextPlane = 8.0
    private var shape: Shape?
    private var pendingShape: PendingShape?
    private var shapeQueue: [PendingShape] = []   // shapes waiting to form once the current one has melted

    // GPU parameter blocks (all float4, so Swift and Metal layouts match)
    private struct GPUColors { var top: SIMD4<Float>, mid: SIMD4<Float>, low: SIMD4<Float> }
    private struct CloudParams { var a, b, c, d, shapeRect: SIMD4<Float>; var sky: GPUColors; var srcRect, e, prevRect: SIMD4<Float> }
    private struct CompositeParams { var a, far, near, patch, patch2, mask, shapeAM: SIMD4<Float>; var sky: GPUColors }

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
        if old.direction != options.direction { shape = nil; pendingShape = nil; shapeQueue.removeAll() }   // a placed shape belongs to the old drift
        if old.cloudScale != options.cloudScale || old.quality != options.quality { needsSetup = true }
        else if old.coverage != options.coverage || old.shadow != options.shadow || old.seed != options.seed
                    || old.direction != options.direction || old.palette != options.palette || old.colors != options.colors
                    || old.gradient != options.gradient { needsRebuild = true }
    }

    /// Jump to a moment of sky time (the clouds are repainted for that moment on the next update).
    public func seek(to time: Double) { simTime = max(0, time); layers = []; needsSetup = true }

    private var dir: Double { options.direction == .right ? -1 : 1 }
    private var effectiveSpeed: Double { options.respectReducedMotion && reduceMotion ? 0 : options.speed }
    /// True while the sky is moving (the host can pause its display link otherwise).
    public var isAnimating: Bool { effectiveSpeed > 0 }

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
                let s = Snap(device.makeTexture(descriptor: desc)!, strips: def.strips)
                place(def, s, time: t0 + Double(k) * def.dt)
                return s
            }
            return Layer(def: def, snaps: snaps)
        }
    }
    private func place(_ def: LayerDef, _ s: Snap, time: Double) { s.time = time; s.x0 = dir * def.speed * time - Self.margin }

    // MARK: - Painting

    private func gpuColors() -> GPUColors {
        let c = options.resolvedColors
        let gradient = Float(min(1, max(0, options.gradient)))
        return GPUColors(top: SIMD4(c.top, gradient), mid: SIMD4(c.mid, 0), low: SIMD4(c.low, 0))
    }
    private static func ease(_ x: Double) -> Double {   // gentle ends, but no long dead start
        let v = min(max(x, 0), 1); return 0.5 * v + 0.5 * v * v * (3 - 2 * v)
    }
    /// Forming progress (stays 1 while holding and melting).
    private func shapeAmount(at t: Double) -> Double {
        guard let s = shape, t > s.t0 else { return 0 }
        return Self.ease((t - s.t0) / s.form)
    }
    /// Melting progress.
    private func shapeMelt(at t: Double) -> Double {
        guard let s = shape else { return 0 }
        return Self.ease((t - s.t0 - s.form - s.hold) / s.fade)
    }
    private func cloudParams(_ def: LayerDef, x0: Double, y0: Double, time: Double, targetHeight: Int, amount: Double, melt: Double = 0, upp: Double? = nil) -> CloudParams {
        let seed = def.seed + SIMD2(options.seed * 7.31, options.seed * 3.17)
        return CloudParams(
            a: SIMD4(Float(x0), Float(y0), Float(upp ?? viewH / Double(cacheH)), Float(viewH)),
            b: SIMD4(Float(time * def.morph), Float(def.scale), Float(options.coverage), Float(options.shadow)),
            c: SIMD4(Float(def.haze), Float(def.farMask), Float(seed.x), Float(seed.y)),
            d: SIMD4(Float(targetHeight), Float(amount), Float(melt), Float(shape?.thickness ?? 0)),
            shapeRect: SIMD4<Float>(shape?.rect ?? SIMD4(0, 0, 1, 1)),
            sky: gpuColors(),
            srcRect: SIMD4<Float>(shape?.srcRect ?? SIMD4(0, 0, 1, 1)),
            e: SIMD4(Float(shape?.density ?? 0.5), amount > 0 && shape?.prev != nil ? 1 : 0, Float(shape?.prev?.thickness ?? 0), 0),
            prevRect: SIMD4<Float>(shape?.prev?.rect ?? SIMD4(0, 0, 1, 1)))
    }
    private func paint(_ def: LayerDef, _ s: Snap, strip: Int, _ cb: MTLCommandBuffer) {
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = s.tex
        rp.colorAttachments[0].loadAction = strip >= 0 ? .load : .dontCare   // keep the strips painted so far
        rp.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { return }
        enc.setRenderPipelineState(cloudPipeline)
        if strip >= 0 {
            let x = cacheW * strip / def.strips, x2 = cacheW * (strip + 1) / def.strips
            enc.setScissorRect(MTLScissorRect(x: x, y: 0, width: max(1, x2 - x), height: cacheH))
        }
        var p = cloudParams(def, x0: s.x0, y0: 0, time: s.time, targetHeight: cacheH, amount: 0)
        enc.setFragmentBytes(&p, length: MemoryLayout<CloudParams>.stride, index: 0)
        enc.setFragmentTexture(emptyTexture, index: 0); enc.setFragmentTexture(emptyTexture, index: 1); enc.setFragmentTexture(emptyTexture, index: 2)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }
    /// While a shape is on screen, the near clouds over its wide area are rendered live (same resolution
    /// as the snapshots) with the shape folded into the cloud density. Only the on-screen part is drawn.
    private func paintPatch(_ cb: MTLCommandBuffer) {
        guard let sh = shape else { return }
        sh.patchReady = false
        let amt = shapeAmount(at: simTime), melt = shapeMelt(at: simTime)
        guard amt > 0, melt < 1, layers.count == 2 else { return }
        let upp = viewH / Double(cacheH), r = sh.area, fade = sh.blend
        let scroll = dir * layers[1].def.speed * simTime, vw = Double(width) / unit
        let x0 = max(r.x, scroll - fade), x1 = min(r.x + r.z, scroll + vw + fade)
        let y0 = max(r.y, -fade), y1 = min(r.y + r.w, viewH + fade)
        guard x1 > x0, y1 > y0 else { return }
        let w = max(1, min(4096, Int(ceil((x1 - x0) / upp)))), h = max(1, min(4096, Int(ceil((y1 - y0) / upp))))
        // one texture big enough for the largest clip, so a shape sliding off screen doesn't reallocate every frame
        let tw = max(w, min(4096, Int(ceil(min(r.z, vw + 2 * fade) / upp)) + 2))
        let th = max(h, min(4096, Int(ceil(min(r.w, viewH + 2 * fade) / upp)) + 2))
        if (sh.patch?.width ?? 0) < tw || (sh.patch?.height ?? 0) < th {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: tw, height: th, mipmapped: false)
            d.usage = [.renderTarget, .shaderRead]; d.storageMode = .private
            sh.patch = device.makeTexture(descriptor: d)
        }
        guard let tex = sh.patch else { return }
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = tex
        rp.colorAttachments[0].loadAction = .dontCare
        rp.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { return }
        enc.setRenderPipelineState(cloudPipeline)
        // Metal's viewport origin is the top-left: draw into the top-left w×h of the texture; the shader's
        // y flip uses the texture height, so pass that and start the window at the bottom of the texture
        enc.setViewport(MTLViewport(originX: 0, originY: 0, width: Double(w), height: Double(h), znear: 0, zfar: 1))
        var p = cloudParams(layers[1].def, x0: x0, y0: y0, time: simTime, targetHeight: h, amount: amt, melt: melt)
        enc.setFragmentBytes(&p, length: MemoryLayout<CloudParams>.stride, index: 0)
        enc.setFragmentTexture(sh.texture, index: 0); enc.setFragmentTexture(sh.src ?? emptyTexture, index: 1)
        enc.setFragmentTexture(sh.prev?.texture ?? emptyTexture, index: 2)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        sh.patchView = SIMD4(x0 - scroll, y0, Double(w) * upp, Double(h) * upp)   // view-relative rect of what was drawn
        sh.patchUV = SIMD2(Double(w) / Double(tex.width), Double(h) / Double(tex.height))
        sh.patchReady = true
    }
    private func rebuildAll(_ cb: MTLCommandBuffer) {
        for l in layers {
            let t0 = l.snaps[0].time
            for (k, s) in l.snaps.enumerated() {
                place(l.def, s, time: t0 + Double(k) * l.def.dt); paint(l.def, s, strip: -1, cb); s.strip = l.def.strips
            }
        }
    }
    private func advance(_ i: Int, _ cb: MTLCommandBuffer) {
        let def = layers[i].def
        while simTime >= layers[i].snaps[1].time {
            let a = layers[i].snaps[0], b = layers[i].snaps[1], c = layers[i].snaps[2]
            while c.strip < def.strips { paint(def, c, strip: c.strip, cb); c.strip += 1 }
            place(def, a, time: c.time + def.dt); a.strip = 0
            layers[i].snaps = [b, c, a]
        }
        let c = layers[i].snaps[2]
        if c.strip < def.strips { paint(def, c, strip: c.strip, cb); c.strip += 1 }
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
        if let sh = shape {
            if simTime > sh.holdEnd && shapeMelt(at: simTime) < 0.05, var n = shapeQueue.first, n.pause == 0 {
                // pause 0: the next shape takes over right away and this one's outline turns straight into it
                shapeQueue.removeFirst(); n.from = sh; placeShape(n)
            } else if simTime > sh.end {
                // melted back into its cloud: the next queued shape forms on the same cloud after its pause
                shape = nil
                if !shapeQueue.isEmpty { var n = shapeQueue.removeFirst(); n.near = sh.cloudAt; n.startAt = sh.end + max(0, n.pause); placeShape(n) }
            }
        }
    }

    /// Draw the current frame into `target` (any color texture the size passed to `resize`).
    public func draw(to target: MTLTexture, commandBuffer cb: MTLCommandBuffer) throws {
        guard layers.count == 2 else { return }
        let pipeline = try compositePipeline(for: target.pixelFormat)
        paintPatch(cb)
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
                         Float(min(1, max(0, (simTime - l.snaps[0].time) / l.def.dt))))
        }
        var patch = SIMD4<Float>(0, 0, 1, 1), patch2 = SIMD4<Float>(0, 0, 0, 0)
        if let sh = shape, sh.patchReady {
            patch = SIMD4<Float>(sh.patchView)
            patch2 = SIMD4(1, Float(sh.blend), Float(sh.patchUV.x), Float(sh.patchUV.y))   // blend inside the mask's all-zero margin
        }
        var mask = SIMD4<Float>(0, 0, 1, 1), shapeAM = SIMD4<Float>(0, 0, 0, 0)
        if let sh = shape {
            let a = shapeAmount(at: simTime), mt = shapeMelt(at: simTime)
            if a > 0, mt < 1 {
                let scroll = dir * layers[1].def.speed * simTime   // subtracted in double precision
                mask = SIMD4(Float(sh.rect.x - scroll), Float(sh.rect.y), Float(sh.rect.z), Float(sh.rect.w))
                shapeAM = SIMD4(Float(a), Float(mt), Float(sh.thickness), 0)
            }
        }
        var p = CompositeParams(
            a: SIMD4(Float(width), Float(height), Float(unit), Float(viewH)),
            far: win(layers[0]), near: win(layers[1]), patch: patch, patch2: patch2, mask: mask, shapeAM: shapeAM,
            sky: gpuColors())
        var extra = extraParams()
        enc.setFragmentBytes(&p, length: MemoryLayout<CompositeParams>.stride, index: 0)
        enc.setFragmentBytes(&extra, length: MemoryLayout<SIMD4<Float>>.stride * extra.count, index: 1)
        enc.setFragmentTexture(layers[0].snaps[0].tex, index: 0); enc.setFragmentTexture(layers[0].snaps[1].tex, index: 1)
        enc.setFragmentTexture(layers[1].snaps[0].tex, index: 2); enc.setFragmentTexture(layers[1].snaps[1].tex, index: 3)
        enc.setFragmentTexture(shape?.patchReady == true ? shape?.patch : emptyTexture, index: 4)
        enc.setFragmentTexture(shapeAM.x > 0 ? shape?.texture : emptyTexture, index: 5)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    /// ExtraParams in the shader: 2 planes, info, info2 (4 float4).
    private func extraParams() -> [SIMD4<Float>] {
        var out = [SIMD4<Float>](repeating: .zero, count: 4)
        var ages: [Float] = [-1, -1]
        for (i, pl) in planes.prefix(2).enumerated() {
            out[i] = SIMD4(Float(pl.x), Float(pl.y), Float(pl.dx), Float(pl.dy))
            ages[i] = Float(pl.age)
        }
        out[2] = SIMD4(ages[0], ages[1], Float(Self.planeSpeed), Float(options.trailLife))
        out[3] = SIMD4(Float(-dir * layers[0].def.speed), 0, 0, 0)
        return out
    }

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

    /// A real cloud near (x, y) reshapes into the shape, holds it, then reshapes back into itself.
    /// x, y: centre, 0…1 of the view (y = 0 at the bottom); size: fraction of the view height; times in seconds;
    /// density 0…1 (0.5 = like the clouds around). queue: wait for the current shape, then form on the same cloud
    /// (word, cloud, next word, cloud, …); pause: seconds the cloud shows in between (0 = the current shape's outline
    /// turns straight into this one after its hold). Needs speed > 0: shapes form as the sky moves on.
    @discardableResult
    public func showShape(_ source: SkyShapeSource, x: Double = 0.5, y: Double = 0.6, size: Double = 0.32,
                          form: Double = 5, hold: Double = 5, fade: Double = 7, density: Double = 0.5, queue: Bool = false, pause: Double = 1) -> Bool {
        guard let mask = ShapeMask.make(source) else { return false }
        let p = PendingShape(mask: mask, x: x, y: y, size: size, form: form, hold: hold, fade: fade, density: min(1, max(0, density)), pause: max(0, pause))
        if queue && (shape != nil || pendingShape != nil || !shapeQueue.isEmpty) { shapeQueue.append(p); return true }
        shapeQueue.removeAll()
        if layers.count == 2 { takeOver(p) } else { pendingShape = p }
        return true
    }
    /// A shape that isn't queued takes over from the one on screen without a jump: if that one is holding, it turns
    /// straight into the new one now; while it is still forming or already melting, the new one comes right after it.
    private func takeOver(_ p: PendingShape) {
        if let sh = shape {
            let amt = shapeAmount(at: simTime), melt = shapeMelt(at: simTime)
            if amt > 0 && melt < 1 {
                var n = p
                if amt >= 1 && melt <= 0 { n.from = sh; placeShape(n) } else { n.pause = 0; shapeQueue.insert(n, at: 0) }
                return
            }
        }
        placeShape(p)
    }
    public func clearShape() { shape = nil; pendingShape = nil; shapeQueue.removeAll() }

    private func placeShape(_ p: PendingShape) {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: p.mask.width, height: p.mask.height, mipmapped: false)
        d.usage = [.shaderRead]
        guard let tex = device.makeTexture(descriptor: d) else { return }
        p.mask.rgba.withUnsafeBytes { tex.replace(region: MTLRegionMake2D(0, 0, p.mask.width, p.mask.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: p.mask.width * 4) }
        let near = layers[1], from = p.from
        let t0 = from != nil ? simTime : max(simTime + 0.2, p.startAt ?? 0)
        let vw = Double(width) / unit
        // size is a fraction of the view height, shrunk if needed so the shape fits 70% of the view width
        let silH = min(p.size * viewH, 0.7 * vw * Double(p.mask.silhouetteHeight) / Double(p.mask.silhouetteWidth))
        let hUnits = silH * Double(p.mask.height) / Double(p.mask.silhouetteHeight)
        let wUnits = hUnits * Double(p.mask.width) / Double(p.mask.height)
        // the shape drifts with the clouds: place it so it is at (x, y) halfway through its hold
        let tMid = t0 + p.form + p.hold / 2, scroll = dir * near.def.speed * tMid
        var cx = p.x * vw + scroll, cy = p.y * viewH
        // put it on a real cloud near there: that cloud turns into the shape, and back into itself
        let k = hUnits / Double(p.mask.height), hw = Double(p.mask.silhouetteWidth) * k / 2, hh = silH / 2
        let tEnd = t0 + p.form + p.hold + p.fade, s0 = dir * near.def.speed * t0, s1 = dir * near.def.speed * tEnd
        let fits = 2 * hw + 0.06 < vw
        let allowed = SIMD4(fits ? scroll + hw + 0.03 : scroll + vw / 2, hh + 0.03, fits ? scroll + vw - hw - 0.03 : scroll + vw / 2, viewH - hh - 0.03)
        let found = from != nil ? nil : cloudNear(x: p.near?.x ?? cx, y: p.near?.y ?? cy, need: p.mask.silhouetteArea * k * k, times: [t0, tMid, tEnd],
                                                  x0: min(s0, s1) - 0.3, x1: max(s0, s1) + vw + 0.3, allowed: allowed, box: SIMD2(hw, hh), same: p.near != nil)
        if let from { cx = from.rect.x + from.rect.z / 2; cy = from.rect.y + from.rect.w / 2 }   // right where the previous shape is
        else if let found { cx = found.centre.x; cy = found.centre.y }
        if from != nil || found != nil {
            cx = min(max(cx, allowed.x), allowed.z)
            cy = min(max(cy, allowed.y), allowed.w)
        }
        let rect = SIMD4(cx - wUnits / 2, cy - hUnits / 2, wUnits, hUnits)
        var blend = 0.15 * Double(p.mask.pad) * hUnits / Double(p.mask.height)   // inside the masks' all-zero margins
        if let from { blend = min(blend, from.blend) }
        let sh = Shape(texture: tex, rect: rect, t0: t0, form: p.form, hold: p.hold, fade: p.fade, thickness: p.mask.thickness, blend: blend)
        sh.density = p.density
        sh.area = rect
        if let from {
            // the previous shape's cloud and mask carry over: its outline turns into this one's
            sh.src = from.src; sh.srcRect = from.srcRect; sh.cloudAt = from.cloudAt
            sh.prev = (from.texture, from.rect, from.thickness)
            let r = from.rect, lo = SIMD2(min(r.x, rect.x), min(r.y, rect.y))
            sh.area = SIMD4(lo.x, lo.y, max(r.x + r.z, rect.x + rect.z) - lo.x, max(r.y + r.w, rect.y + rect.w) - lo.y)
        } else {
            sh.src = found?.src; sh.srcRect = found?.srcRect ?? SIMD4(0, 0, 1, 1)
            sh.cloudAt = found?.centre ?? SIMD2(cx, cy)
        }
        shape = sh
    }

    /// The cloud to put a shape on (findCloud), from a map of the near clouds over x0…x1 (all that is on screen
    /// while the shape lives) at the moment it starts forming, times[0]; its centre, and a map of that cloud grown
    /// a little into where it reaches later on (sourceCells), so only that cloud gives way (srcRect: cloud-space x0, y0, w, h).
    private func cloudNear(x: Double, y: Double, need: Double, times: [Double], x0: Double, x1: Double, allowed: SIMD4<Double>, box: SIMD2<Double>, same: Bool)
        -> (centre: SIMD2<Double>, src: MTLTexture, srcRect: SIMD4<Double>)? {
        let step = 0.02, y0 = -0.02
        let gw = min(400, Int(ceil((x1 - x0) / step))), gh = Int(ceil((viewH + 0.04) / step))
        guard gh > 4, layers.count == 2,
              let buf = device.makeBuffer(length: gw * gh * 4 * times.count, options: .storageModeShared),
              let cb = queue.makeCommandBuffer() else { return nil }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: gw, height: gh, mipmapped: false)
        d.usage = [.renderTarget]; d.storageMode = .private
        for (i, t) in times.enumerated() {
            guard let tex = device.makeTexture(descriptor: d) else { return nil }
            let rp = MTLRenderPassDescriptor()
            rp.colorAttachments[0].texture = tex; rp.colorAttachments[0].loadAction = .dontCare; rp.colorAttachments[0].storeAction = .store
            guard let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { return nil }
            enc.setRenderPipelineState(cloudPipeline)
            var p = cloudParams(layers[1].def, x0: x0, y0: y0, time: t, targetHeight: gh, amount: 0, upp: step)
            enc.setFragmentBytes(&p, length: MemoryLayout<CloudParams>.stride, index: 0)
            enc.setFragmentTexture(emptyTexture, index: 0); enc.setFragmentTexture(emptyTexture, index: 1); enc.setFragmentTexture(emptyTexture, index: 2)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            enc.endEncoding()
            guard let blit = cb.makeBlitCommandEncoder() else { return nil }
            blit.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: gw, height: gh, depth: 1),
                      to: buf, destinationOffset: i * gw * gh * 4, destinationBytesPerRow: gw * 4, destinationBytesPerImage: gw * gh * 4)
            blit.endEncoding()
        }
        cb.commit(); cb.waitUntilCompleted()
        let px = buf.contents().bindMemory(to: UInt8.self, capacity: gw * gh * 4 * times.count)
        var grid = [UInt8](repeating: 0, count: gw * gh), later = grid
        for i in times.indices { for yy in 0..<gh { for xx in 0..<gw {   // texture rows are top-down; the maps are bottom-up
            let a = px[i * gw * gh * 4 + ((gh - 1 - yy) * gw + xx) * 4 + 3]
            if i == 0 { grid[yy * gw + xx] = a }
            later[yy * gw + xx] = max(later[yy * gw + xx], a)
        } } }
        guard let best = Self.findCloud(grid: grid, gw: gw, gh: gh, origin: SIMD2(x0, y0), step: step, want: SIMD2(x, y), need: need, allowed: allowed, box: box, same: same)
        else { return nil }
        // where the shape will sit (placeShape clamps it the same way)
        let centre = SIMD2(min(max(best.centre.x, allowed.x), allowed.z), min(max(best.centre.y, allowed.y), allowed.w))
        let mine = Self.sourceCells(label: best.label, comp: best.comp, later: later, gw: gw, gh: gh,
                                    c: (centre - SIMD2(x0, y0)) / step, b: box / step, step: step)
        var mask = [UInt8](repeating: 0, count: gw * gh * 4)   // rows bottom-up, as sampled
        for i in 0..<(gw * gh) { mask[i * 4] = mine[i] }
        let sd = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: gw, height: gh, mipmapped: false)
        sd.usage = [.shaderRead]
        guard let src = device.makeTexture(descriptor: sd) else { return nil }
        mask.withUnsafeBytes { src.replace(region: MTLRegionMake2D(0, 0, gw, gh), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: gw * 4) }
        return (centre, src, SIMD4(x0, y0, Double(gw) * step, Double(gh) * step))
    }
    /// The map of the cloud a shape is made from (port of sourceCells in sky.js; keep the two identical): its cells
    /// (label == comp), grown up to 4 cells into where any cloud reaches later on (later > 8) but not into other
    /// clouds, then softened (3×3), and fading out from 0.05 to 0.3 cloud units away from the shape's box (centre
    /// c and half size b, in cells), so of a big cloud only the part near the shape gives way. 0…255 per cell,
    /// same layout as the maps.
    static func sourceCells(label: [Int32], comp: Int32, later: [UInt8], gw: Int, gh: Int, c: SIMD2<Double>, b: SIMD2<Double>, step: Double) -> [UInt8] {
        let n = gw * gh
        var depth = [Int8](repeating: -1, count: n)
        var front: [Int] = []
        for i in 0..<n where label[i] == comp { depth[i] = 0; front.append(i) }
        var d: Int8 = 1
        while d <= 4 && !front.isEmpty {
            var next: [Int] = []
            for i in front {
                let x = i % gw, y = i / gw
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < gw && ny < gh {
                    let j = ny * gw + nx
                    if depth[j] < 0 && later[j] > 8 && label[j] < 0 { depth[j] = d; next.append(j) }
                }
            }
            front = next; d += 1
        }
        var out = [UInt8](repeating: 0, count: n)
        for y in 0..<gh { for x in 0..<gw {
            var k = 0
            for dy in -1...1 { for dx in -1...1 where depth[min(gh - 1, max(0, y + dy)) * gw + min(gw - 1, max(0, x + dx))] >= 0 { k += 1 } }
            let ex = max(abs(Double(x) + 0.5 - c.x) - b.x, 0), ey = max(abs(Double(y) + 0.5 - c.y) - b.y, 0)
            let t = min(max(((ex * ex + ey * ey).squareRoot() * step - 0.05) / 0.25, 0), 1)
            out[y * gw + x] = UInt8((255.0 * Double(k) / 9.0 * (1 - t * t * (3 - 2 * t))).rounded())
        } }
        return out
    }
    /// The cloud a shape is placed on (port of findCloud in sky.js; keep the two identical): of the clouds in
    /// the map (rows bottom-up), the one nearest to `want` whose size is closest to `need` and that best fills a
    /// box the shape's size (half width, half height `box`) with no other cloud in or right next to it, somewhere
    /// inside `allowed` (x0, y0, x1, y1: where the shape's centre can be so it stays in view). `same`: strongly
    /// prefer the cloud at `want` (a queued shape reuses the last one's cloud). Returns that spot,
    /// the label of every cell (-1 = no cloud) and the picked cloud's label (nil when there is no cloud).
    static func findCloud(grid: [UInt8], gw: Int, gh: Int, origin: SIMD2<Double>, step: Double, want: SIMD2<Double>, need: Double,
                          allowed: SIMD4<Double>, box: SIMD2<Double>, same: Bool = false) -> (centre: SIMD2<Double>, label: [Int32], comp: Int32)? {
        let n = gw * gh, W = gw + 1
        var label = [Int32](repeating: -1, count: n), sat = [Int32](repeating: 0, count: W * (gh + 1)), all = sat
        let bw = max(1, Int((box.x / step).rounded())), bh = max(1, Int((box.y / step).rounded()))
        func sum(_ t: [Int32], _ xa: Int, _ ya: Int, _ xb: Int, _ yb: Int) -> Double {
            let xa = max(0, xa), ya = max(0, ya), xb = min(gw, xb), yb = min(gh, yb)
            return Double(t[yb * W + xb] - t[ya * W + xb] - t[yb * W + xa] + t[ya * W + xa])
        }
        for y in 0..<gh {
            var row: Int32 = 0
            for x in 0..<gw { if grid[y * gw + x] > 8 { row += 1 }; all[(y + 1) * W + x + 1] = all[y * W + x + 1] + row }
        }
        var best: (score: Double, c: SIMD2<Double>, comp: Int32)? = nil
        var comp: Int32 = 0
        for start in 0..<n where grid[start] > 8 && label[start] < 0 {
            let id = comp; comp += 1
            var stack = [start], mine: [Int] = []; label[start] = id
            var border = false, atWant = false
            let q = (want - origin) / step
            while let i = stack.popLast() {
                let x = i % gw, y = i / gw
                mine.append(i)
                if x == 0 || x == gw - 1 { border = true }
                if abs(Double(x) + 0.5 - q.x) <= 2.5 && abs(Double(y) + 0.5 - q.y) <= 2.5 { atWant = true }
                for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] where nx >= 0 && ny >= 0 && nx < gw && ny < gh {
                    let j = ny * gw + nx
                    if grid[j] > 8 && label[j] < 0 { label[j] = id; stack.append(j) }
                }
            }
            let area = Double(mine.count) * step * step
            if area < 0.05 * need { continue }                                     // a speck
            // where on this cloud the shape sits: the spot (on the cloud, in view) with the most of it under the box
            // and the least of other clouds in or right next to it (they would merge with the shape)
            for y in 0..<gh {
                var row: Int32 = 0
                for x in 0..<gw { if label[y * gw + x] == id { row += 1 }; sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row }
            }
            var spot: (s: Double, c: SIMD2<Double>)? = nil
            for i in mine {
                let x = i % gw, y = i / gw
                let fill = sum(sat, x - bw, y - bh, x + bw + 1, y + bh + 1) / Double((2 * bw + 1) * (2 * bh + 1))
                let other = (sum(all, x - bw - 3, y - bh - 3, x + bw + 4, y + bh + 4) - sum(sat, x - bw - 3, y - bh - 3, x + bw + 4, y + bh + 4)) / Double((2 * bw + 7) * (2 * bh + 7))
                let c = SIMD2(origin.x + (Double(x) + 0.5) * step, origin.y + (Double(y) + 0.5) * step)
                let ox = max(allowed.x - c.x, 0, c.x - allowed.z), oy = max(allowed.y - c.y, 0, c.y - allowed.w)
                let s = max(0, fill - 1.5 * other) * exp(-(ox * ox + oy * oy).squareRoot() / 0.1)
                if spot == nil || s > spot!.s { spot = (s, c) }
            }
            guard let spot else { continue }
            let c = spot.c
            let score = exp(-((c.x - want.x) * (c.x - want.x) + (c.y - want.y) * (c.y - want.y)).squareRoot() / 0.35) * exp(-0.6 * abs(log(area / need)))
                      * (0.05 + spot.s) * (border ? 0.5 : 1) * (same && atWant ? 4 : 1)
            if best == nil || score > best!.score { best = (score, c, id) }
        }
        guard let best else { return nil }
        return (best.c, label, best.comp)
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
