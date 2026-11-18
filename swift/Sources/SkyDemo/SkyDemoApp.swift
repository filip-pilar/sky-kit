// A small macOS demo:  swift run SkyDemo
#if os(macOS)
import SwiftUI
import AppKit
import SkyKit

@main
struct SkyDemoApp: App {
    init() {
        // A command-line executable starts as a background process; make it a regular app with a window.
        NSApplication.shared.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApplication.shared.activate(ignoringOtherApps: true) }
    }
    var body: some Scene {
        WindowGroup("SkyKit demo") { DemoView().frame(minWidth: 640, minHeight: 420) }
    }
}

struct DemoView: View {
    @State private var options = SkyOptions(interactive: true, planes: true)
    @State private var text = "hello"
    @StateObject private var sky = SkyController()

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            SkyView(options, controller: sky).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 8) {
                Text("Hello, sky").font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    .shadow(color: .blue.opacity(0.4), radius: 8)
                HStack {
                    Text("Clouds"); Slider(value: $options.coverage, in: 0...1).frame(width: 140)
                    Text("Speed"); Slider(value: $options.speed, in: 0...4).frame(width: 140)
                }
                Picker("Palette", selection: $options.palette) {
                    ForEach(SkyOptions.Palette.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }.pickerStyle(.segmented).frame(width: 300)
                HStack {
                    Toggle("Pointer pushes clouds", isOn: $options.interactive)
                    Toggle("Planes", isOn: $options.planes)
                    Button("Fly a plane") { sky.flyPlane() }
                }
                HStack {
                    TextField("Text", text: $text).frame(width: 140)
                    Button("Form it in the clouds") { sky.showShape(.text(text.isEmpty ? "☁" : text)) }
                }
            }
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding(20)
        }
    }
}
#else
// The window demo is macOS-only; on iOS use SkyView inside your own app.
@main enum SkyDemoApp { static func main() {} }
#endif
