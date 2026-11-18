import SwiftUI
import MetalKit

/// SwiftUI view that fills its frame with the drifting sky.
///
///     SkyView(SkyOptions(coverage: 0.6))
///         .ignoresSafeArea()
///
/// Changing the options value updates the sky live.
public struct SkyView {
    public var options: SkyOptions
    public init(_ options: SkyOptions = SkyOptions()) { self.options = options }

    @MainActor
    public final class Coordinator: NSObject, MTKViewDelegate {
        var renderer: SkyRenderer?
        private var last: CFTimeInterval = 0

        public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
            renderer?.resize(width: Int(size.width), height: Int(size.height), pixelsPerPoint: Self.scale(of: view))
        }

        public func draw(in view: MTKView) {
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

    @MainActor public func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    func makeMTKView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.preferredFramesPerSecond = options.fps
        view.enableSetNeedsDisplay = false
        view.isPaused = false
        view.delegate = context.coordinator
        context.coordinator.renderer = try? SkyRenderer(device: view.device, options: options)
        return view
    }

    @MainActor
    func update(_ view: MTKView, context: Context) {
        context.coordinator.renderer?.options = options
        view.preferredFramesPerSecond = options.fps
    }
}

#if os(macOS)
extension SkyView: NSViewRepresentable {
    public func makeNSView(context: Context) -> MTKView { makeMTKView(context: context) }
    public func updateNSView(_ nsView: MTKView, context: Context) { update(nsView, context: context) }
}
#else
extension SkyView: UIViewRepresentable {
    public func makeUIView(context: Context) -> MTKView { makeMTKView(context: context) }
    public func updateUIView(_ uiView: MTKView, context: Context) { update(uiView, context: context) }
}
#endif
