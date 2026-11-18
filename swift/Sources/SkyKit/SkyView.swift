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
    public init() {}

    /// Send a plane across. Points are 0…1 of the view with y = 0 at the bottom; nil = from a random side.
    public func flyPlane(from: CGPoint? = nil, to: CGPoint? = nil) { renderer?.flyPlane(from: from, to: to) }
    /// Clouds gather into a shape, hold it, then melt back into ordinary clouds. Needs speed > 0.
    public func showShape(_ source: SkyShapeSource, x: Double = 0.5, y: Double = 0.6, size: Double = 0.32,
                          form: Double = 4, hold: Double = 6, fade: Double = 8) {
        renderer?.showShape(source, x: x, y: y, size: size, form: form, hold: hold, fade: fade)
    }
    public func clearShape() { renderer?.clearShape() }
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
        GeometryReader { geo in
            SkyMetalView(options: options, controller: controller)
                .onContinuousHover(coordinateSpace: .local) { phase in
                    guard options.interactive else { return }
                    switch phase {
                    case .active(let p): controller.renderer?.pointerMoved(to: p, in: geo.size)
                    case .ended: controller.renderer?.pointerEnded()
                    }
                }
                .simultaneousGesture(DragGesture(minimumDistance: 0)
                    .onChanged { v in if options.interactive { controller.renderer?.pointerMoved(to: v.location, in: geo.size) } }
                    .onEnded { _ in controller.renderer?.pointerEnded() },
                    including: options.interactive ? .all : .subviews)
        }
    }
}

struct SkyMetalView {
    var options: SkyOptions
    var controller: SkyController

    @MainActor
    final class Coordinator: NSObject, MTKViewDelegate {
        var renderer: SkyRenderer?
        private var last: CFTimeInterval = 0

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
            renderer?.resize(width: Int(size.width), height: Int(size.height), pixelsPerPoint: Self.scale(of: view))
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
        context.coordinator.renderer = renderer
        controller.renderer = renderer
        return view
    }

    @MainActor
    func update(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.options = options
        controller.renderer = context.coordinator.renderer
        view.preferredFramesPerSecond = options.fps
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
