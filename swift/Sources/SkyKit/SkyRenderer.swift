import Foundation
import Metal
import CoreGraphics
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

    // Same constants as web/src/sky.js
    private static let dt = 2.0, strips = 24, margin = 0.3
    private static let qualityFactor: [SkyOptions.Quality: Double] = [.high: 1.25, .balanced: 1.0, .low: 0.75]
    private struct LayerDef { let scale: Double, seed: SIMD2<Double>, speed: Double, morph: Double, haze: Double, farMask: Double }
    private static let layerDefs = [
        LayerDef(scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1),
        LayerDef(scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0, farMask: 0),
    ]
    private final class Snap { let tex: MTLTexture; var time = 0.0; var x0 = 0.0; var strip = SkyRenderer.strips; init(_ t: MTLTexture) { tex = t } }
    private struct Layer { let def: LayerDef; var snaps: [Snap] }

    private var layers: [Layer] = []
    private var width = 0, height = 0, pixelsPerPoint = 1.0
    private var unit = 1.0, viewH = 1.0, cacheW = 1, cacheH = 1, winW = 1.0
    private var needsSetup = true, needsRebuild = false

    // GPU parameter blocks (all float4, so Swift and Metal layouts match)
    private struct GPUColors { var top: SIMD4<Float>, mid: SIMD4<Float>, low: SIMD4<Float> }
    private struct CloudParams { var a, b, c, d: SIMD4<Float>; var sky: GPUColors }
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
        cloudPipeline = try Self.makePipeline(device, library, fragment: "sky_cloud", format: .rgba8Unorm, blending: false)
    }

    private static func makePipeline(_ device: MTLDevice, _ lib: MTLLibrary, fragment: String, format: MTLPixelFormat, blending: Bool) throws -> MTLRenderPipelineState {
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "sky_fullscreen")
        d.fragmentFunction = lib.makeFunction(name: fragment)
        d.colorAttachments[0].pixelFormat = format
        do { return try device.makeRenderPipelineState(descriptor: d) }
        catch { throw RendererError.pipeline("\(fragment): \(error)") }
    }
    private func compositePipeline(for format: MTLPixelFormat) throws -> MTLRenderPipelineState {
        if let p = compositePipelines[format] { return p }
        let p = try Self.makePipeline(device, library, fragment: "sky_composite", format: format, blending: false)
        compositePipelines[format] = p
        return p
    }

    // MARK: - Sizing and options

    /// Call when the drawable size changes (pixels) and with the screen's pixels-per-point.
    public func resize(width: Int, height: Int, pixelsPerPoint: Double) {
        guard width != self.width || height != self.height || pixelsPerPoint != self.pixelsPerPoint else { return }
        self.width = max(1, width); self.height = max(1, height); self.pixelsPerPoint = pixelsPerPoint
        needsSetup = true
    }

    private func optionsChanged(from old: SkyOptions) {
        if old.cloudScale != options.cloudScale || old.quality != options.quality { needsSetup = true }
        else if old.coverage != options.coverage || old.shadow != options.shadow || old.seed != options.seed
                    || old.direction != options.direction || old.palette != options.palette || old.colors != options.colors { needsRebuild = true }
    }

    private var dir: Double { options.direction == .right ? -1 : 1 }
    private var effectiveSpeed: Double { options.respectReducedMotion && reduceMotion ? 0 : options.speed }
    /// True when the sky is moving (the host can stop its display link otherwise).
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
    private func paint(_ def: LayerDef, _ s: Snap, strip: Int, _ cb: MTLCommandBuffer) {
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
        var p = CloudParams(
            a: SIMD4(Float(s.x0), 0, Float(viewH / Double(cacheH)), Float(viewH)),
            b: SIMD4(Float(s.time * def.morph), Float(def.scale), Float(options.coverage), Float(options.shadow)),
            c: SIMD4(Float(def.haze), Float(def.farMask), Float(seed.x), Float(seed.y)),
            d: SIMD4(Float(cacheH), 0, 0, 0),
            sky: gpuColors())
        enc.setFragmentBytes(&p, length: MemoryLayout<CloudParams>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }
    private func rebuildAll(_ cb: MTLCommandBuffer) {
        for l in layers {
            let t0 = l.snaps[0].time
            for (k, s) in l.snaps.enumerated() { place(l.def, s, time: t0 + Double(k) * Self.dt); paint(l.def, s, strip: -1, cb); s.strip = Self.strips }
        }
    }
    private func advance(_ i: Int, _ cb: MTLCommandBuffer) {
        while simTime >= layers[i].snaps[1].time {
            let a = layers[i].snaps[0], b = layers[i].snaps[1], c = layers[i].snaps[2]
            while c.strip < Self.strips { paint(layers[i].def, c, strip: c.strip, cb); c.strip += 1 }
            place(layers[i].def, a, time: c.time + Self.dt); a.strip = 0
            layers[i].snaps = [b, c, a]
        }
        let c = layers[i].snaps[2]
        if c.strip < Self.strips { paint(layers[i].def, c, strip: c.strip, cb); c.strip += 1 }
    }

    // MARK: - Per-frame API

    /// Advance the sky by `dt` real seconds and paint the next snapshot strips into `commandBuffer`.
    public func update(dt: Double, commandBuffer cb: MTLCommandBuffer) {
        if needsSetup { setup(); rebuildAll(cb); needsSetup = false; needsRebuild = false }
        if needsRebuild { rebuildAll(cb); needsRebuild = false }
        simTime += max(0, min(dt, 0.1)) * effectiveSpeed
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
        func win(_ l: Layer) -> SIMD4<Float> {
            SIMD4(Float(l.snaps[0].x0), Float(l.snaps[1].x0), Float(winW), Float(min(1, max(0, (simTime - l.snaps[0].time) / Self.dt))))
        }
        var p = CompositeParams(
            a: SIMD4(Float(width), Float(height), Float(unit), Float(viewH)),
            far: win(layers[0]), near: win(layers[1]),
            scroll: SIMD4(Float(dir * layers[0].def.speed * simTime), Float(dir * layers[1].def.speed * simTime), 0, 0),
            sky: gpuColors())
        enc.setFragmentBytes(&p, length: MemoryLayout<CompositeParams>.stride, index: 0)
        enc.setFragmentTexture(layers[0].snaps[0].tex, index: 0); enc.setFragmentTexture(layers[0].snaps[1].tex, index: 1)
        enc.setFragmentTexture(layers[1].snaps[0].tex, index: 2); enc.setFragmentTexture(layers[1].snaps[1].tex, index: 3)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    // MARK: - Offscreen

    /// Render a still image offscreen: simulates `seconds` of sky time at 30 fps, then draws.
    /// Useful for wallpapers, thumbnails and tests.
    public func renderImage(width: Int, height: Int, pixelsPerPoint: Double = 2, seconds: Double = 0) throws -> CGImage {
        resize(width: width, height: height, pixelsPerPoint: pixelsPerPoint)
        let frames = Int((seconds * 30).rounded())
        let saved = reduceMotion; reduceMotion = false
        defer { reduceMotion = saved }
        // first frame sets up at time 0, then step in 1/30 s increments (like the web version's _step)
        for i in 0...frames {
            guard let cb = queue.makeCommandBuffer() else { throw RendererError.readback }
            update(dt: i == 0 ? 0 : 1.0 / 30.0, commandBuffer: cb)
            cb.commit()
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
