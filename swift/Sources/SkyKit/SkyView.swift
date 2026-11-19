import SwiftUI
import MetalKit

/// Lets your code act on a sky: send planes, form shapes.
///
///     @StateObject private var sky = SkyController()
///     SkyView(options, controller: sky)
///     Button("Hi") { sky.showShape(.text("hi")) }
@MainActor
public final class SkyController: ObservableObject {
    weak var renderer: SkyRenderer?
    var wake: (() -> Void)?
    /// Shapes are built here, in call order, so the main thread never waits for one (tens of milliseconds each).
    private static let builder = DispatchQueue(label: "SkyKit.shapes", qos: .userInitiated)
    /// Bumped (per id) by a shape that isn't queued, clearShape and releaseShape: builds started before then are dropped.
    private var tickets: [String: Int] = [:], epoch = 0
    public init() {}

    /// Send a plane across. Points are 0…1 of the view with y = 0 at the bottom; nil = from a random side.
    public func flyPlane(from: CGPoint? = nil, to: CGPoint? = nil) { renderer?.flyPlane(from: from, to: to); wake?() }
    /// A real cloud nearby reshapes into a shape, holds it, then reshapes back into itself. density 0…1
    /// (0.5 = like the clouds around); queue: form after the current shape, on the same cloud, `pause` seconds after it
    /// has melted (0 = its outline turns straight into this one). id: shapes with different ids are on screen side by
    /// side (up to 3), each with its own queue; a 4th id takes over the one used longest ago. Needs speed > 0. The
    /// shape is built in the background.
    public func showShape(_ source: SkyShapeSource, x: Double? = nil, y: Double? = nil, size: Double = 0.32,
                          form: Double = 5, hold: Double = 5, fade: Double = 7, density: Double = 0.5, queue: Bool = false, pause: Double = 1,
                          id: String = "") {
        if !queue { tickets[id, default: 0] += 1 }
        let t = tickets[id, default: 0], e = epoch, label = source.label
        Self.builder.async {
            let mask = ShapeMask.make(source)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { [weak self] in
                    guard let self, let mask, t == self.tickets[id, default: 0], e == self.epoch else { return }
                    self.renderer?.show(mask, label: label, x: x, y: y, size: size, form: form, hold: hold, fade: fade,
                                        density: density, queue: queue, pause: pause, id: id)
                    self.wake?()
                }
            }
        }
    }
    /// Remove the shape with this id (or all of them) at once, and the ones queued after it.
    public func clearShape(id: String? = nil) { drop(id); renderer?.clearShape(id: id); wake?() }
    /// Melt the shape with this id (or all of them) back into its cloud now (from wherever it is) and drop the queued ones.
    public func releaseShape(id: String? = nil) { drop(id); renderer?.releaseShape(id: id); wake?() }
    private func drop(_ id: String?) { if let id { tickets[id, default: 0] += 1 } else { epoch += 1 } }
    /// What the shape without an id is doing right now (phase, what's on screen, what's next).
    public var shapeState: SkyShapeState { renderer?.shapeState ?? .idle }
    /// The same for every id in use ("" is the shape without an id).
    public var shapeStates: [String: SkyShapeState] { renderer?.shapeStates ?? [:] }
    /// The clouds at the current moment as an image, rendered offscreen at any size (planes and shapes not included).
    public func snapshot(width: Int, height: Int, pixelsPerPoint: Double = 2) -> CGImage? {
        guard let r = renderer, let copy = try? SkyRenderer(device: r.device, options: r.options) else { return nil }
        copy.seek(to: r.simTime)
        return try? copy.renderImage(width: width, height: height, pixelsPerPoint: pixelsPerPoint)
    }
}

/// SwiftUI view that fills its frame with the drifting sky.
///
///     SkyView(SkyOptions(coverage: 0.6))
///         .ignoresSafeArea()
///
/// Changing the options value updates the sky live.
public struct SkyView: View {
    public var options: SkyOptions
    private let external: SkyController?
    @StateObject private var own = SkyController()

    public init(_ options: SkyOptions = SkyOptions(), controller: SkyController? = nil) {
        self.options = options
        self.external = controller
    }

    public var body: some View {
        let controller = external ?? own
        SkyMetalView(options: options, controller: controller)
    }
}

struct SkyMetalView {
    var options: SkyOptions
    var controller: SkyController

    @MainActor
    final class Coordinator: NSObject, MTKViewDelegate {
        var renderer: SkyRenderer?
        weak var view: MTKView?
        private var last: CFTimeInterval = 0
        private var motionObserver: NSObjectProtocol?

        override init() {
            super.init()
            #if os(macOS)
            motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wake() }
            }
            #else
            motionObserver = NotificationCenter.default.addObserver(
                forName: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wake() }
            }
            #endif
        }
        deinit {
            if let motionObserver {
                #if os(macOS)
                NSWorkspace.shared.notificationCenter.removeObserver(motionObserver)
                #else
                NotificationCenter.default.removeObserver(motionObserver)
                #endif
            }
        }

        /// Resume drawing after an idle pause.
        func wake() {
            guard let view, view.isPaused else { return }
            last = 0
            view.isPaused = false
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
            renderer?.resize(width: Int(size.width), height: Int(size.height), pixelsPerPoint: Self.scale(of: view))
            wake()
        }

        func draw(in view: MTKView) {
            guard let renderer, let drawable = view.currentDrawable, let cb = renderer.queue.makeCommandBuffer() else { return }
            let now = CACurrentMediaTime()
            let dt = last == 0 ? 0 : now - last
            last = now
            renderer.reduceMotion = Self.systemReducesMotion
            renderer.resize(width: Int(view.drawableSize.width), height: Int(view.drawableSize.height), pixelsPerPoint: Self.scale(of: view))
            renderer.update(dt: dt, commandBuffer: cb)
            try? renderer.draw(to: drawable.texture, commandBuffer: cb)
            cb.present(drawable)
            cb.commit()
            if view.preferredFramesPerSecond != renderer.frameRate { view.preferredFramesPerSecond = renderer.frameRate }
            if !renderer.isAnimating { view.isPaused = true }   // nothing moving: stop until something wakes us
        }

        static func scale(of view: MTKView) -> Double {
            #if os(macOS)
            return Double(view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
            #else
            return Double(view.contentScaleFactor)
            #endif
        }
        static var systemReducesMotion: Bool {
            #if os(macOS)
            return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            #else
            return UIAccessibility.isReduceMotionEnabled
            #endif
        }
    }

    @MainActor func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    func makeMTKView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.preferredFramesPerSecond = options.fps
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        view.delegate = context.coordinator
        let renderer = try? SkyRenderer(device: view.device, options: options)
        let coordinator = context.coordinator
        coordinator.renderer = renderer
        coordinator.view = view
        controller.renderer = renderer
        controller.wake = { [weak coordinator] in coordinator?.wake() }
        return view
    }

    @MainActor
    func update(_ view: MTKView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.renderer?.options != options { coordinator.renderer?.options = options }
        controller.renderer = coordinator.renderer
        controller.wake = { [weak coordinator] in coordinator?.wake() }
        view.preferredFramesPerSecond = options.fps
        coordinator.wake()
    }
}

#if os(macOS)
extension SkyMetalView: NSViewRepresentable {
    func makeNSView(context: Context) -> MTKView { makeMTKView(context: context) }
    func updateNSView(_ nsView: MTKView, context: Context) { update(nsView, context: context) }
}
#else
extension SkyMetalView: UIViewRepresentable {
    func makeUIView(context: Context) -> MTKView { makeMTKView(context: context) }
    func updateUIView(_ uiView: MTKView, context: Context) { update(uiView, context: context) }
}
#endif
