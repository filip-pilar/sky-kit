// A small macOS demo of the Swift port:  swift run SkyDemo
// Type words (commas chain them) and press Form, pick a symbol, or click a cloud to form them on it: each click uses
// the next id, so up to three shapes are up at once.
#if os(macOS)
import SwiftUI
import AppKit
import Combine
import SkyKit

@main
struct SkyDemoApp: App {
    init() {
        // A command-line executable starts as a background process; make it a regular app with a window.
        NSApplication.shared.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApplication.shared.activate(ignoringOtherApps: true) }
    }
    var body: some Scene {
        WindowGroup("SkyKit demo") { DemoView().frame(minWidth: 640, minHeight: 480) }
    }
}

struct DemoView: View {
    @StateObject private var sky = SkyController()
    @State private var text = "hello, sky"
    @State private var symbol: SkySymbol?            // the last symbol picked: clicks form it instead of the words
    @State private var next = 1                       // clicks go round ids b, c, a, …
    @State private var states: [String: SkyShapeState] = [:]
    private let ids = ["a", "b", "c"]
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack(alignment: .bottom) {
            SkyView(SkyOptions(planes: true), controller: sky).ignoresSafeArea()
            GeometryReader { geo in   // (a clear layer takes the clicks; the Metal view underneath doesn't pass them on)
                Color.clear.contentShape(Rectangle()).gesture(SpatialTapGesture().onEnded { click($0.location, in: geo.size) })
            }
            panel.padding(12).frame(width: 520).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14)).padding(16)
        }
        .onReceive(tick) { _ in states = sky.shapeStates }
        .onAppear { form() }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Words, separated by commas", text: $text).textFieldStyle(.roundedBorder).onSubmit { symbol = nil; form() }
                Button("Form") { symbol = nil; form() }.keyboardShortcut(.defaultAction)
                Button("Melt") { next = 0; sky.releaseShape() }.disabled(states.isEmpty)
            }
            HStack(spacing: 6) {
                ForEach(SkySymbol.allCases, id: \.self) { s in
                    Button { symbol = s; next = 1; sky.showShape(.symbol(s), size: 0.42, id: "a") } label: {
                        if let img = s.image(height: 40) { Image(decorative: img, scale: 2).renderingMode(.template).frame(maxWidth: .infinity, minHeight: 24) }
                    }
                    .help(s.rawValue.capitalized)
                }
            }
            Text(status).font(.callout.weight(.semibold)).lineLimit(1).truncationMode(.tail)
        }
    }

    private var words: [String] { text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    /// The words (or the last symbol) as id `id`, at a clicked point (x, y: 0…1 of the view, y up) or the default spot.
    private func form(_ id: String = "a", at point: (x: Double, y: Double)? = nil) {
        if id == "a" { next = 1 }
        if let symbol { sky.showShape(.symbol(symbol), x: point?.x, y: point?.y, size: 0.42, id: id); return }
        for (i, w) in (words.isEmpty ? ["☁"] : words).enumerated() {
            sky.showShape(.text(w), x: point?.x, y: point?.y, queue: i > 0, id: id)
        }
    }
    private func click(_ p: CGPoint, in size: CGSize) {
        let id = ids[next]; next = (next + 1) % ids.count
        form(id, at: (Double(p.x / size.width), 1 - Double(p.y / size.height)))
    }
    private var status: String {
        let names: [SkyShapeState.Phase: String] = [.waiting: "Starting", .forming: "Forming", .holding: "Holding", .melting: "Melting back"]
        let parts = ids.compactMap { states[$0] }.compactMap { st in names[st.phase].map { $0 + (st.label.map { " “\($0)”" } ?? "") } }
        return parts.isEmpty ? "Type words or pick a symbol, then click a cloud" : parts.joined(separator: "  ·  ")
    }
}
#else
// The window demo is macOS-only; on iOS use SkyView inside your own app.
@main enum SkyDemoApp { static func main() {} }
#endif
