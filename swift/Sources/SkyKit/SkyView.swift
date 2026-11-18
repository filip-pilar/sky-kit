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
    public init() {}

    /// Send a plane across. Points are 0…1 of the view with y = 0 at the bottom; nil = from a random side.
    public func flyPlane(from: CGPoint? = nil, to: CGPoint? = nil) { renderer?.flyPlane(from: from, to: to); wake?() }
    /// A real cloud nearby reshapes into a shape, holds it, then reshapes back into itself. density 0…1
    /// (0.5 = like the clouds around); queue: form after the current shape, on the same cloud, `pause` seconds after it
    /// has melted (0 = its outline turns straight into this one). Needs speed > 0.
    public func showShape(_ source: SkyShapeSource, x: Double = 0.5, y: Double = 0.6, size: Double = 0.32,
                          form: Double = 5, hold: Double = 5, fade: Double = 7, density: Double = 0.5, queue: Bool = false, pause: Double = 1) {
        renderer?.showShape(source, x: x, y: y, size: size, form: form, hold: hold, fade: fade, density: density, queue: queue, pause: pause)
        wake?()
    }
    public func clearShape() { renderer?.clearShape() }
    /// Melt the shape on screen back into its cloud now (from wherever it is) and drop the queued ones.
    public func releaseShape() { renderer?.releaseShape(); wake?() }
    /// What the shapes are doing right now (phase, what's on screen, what's next).
    public var shapeState: SkyShapeState { renderer?.shapeState ?? .idle }
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
