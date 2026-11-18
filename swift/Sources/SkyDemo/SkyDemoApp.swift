// A small macOS demo:  swift run SkyDemo
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
        WindowGroup("SkyKit demo") { DemoView().frame(minWidth: 720, minHeight: 560) }
    }
}

struct DemoView: View {
    @State private var options = SkyOptions(planes: true)
    @StateObject private var sky = SkyController()
    // words and shapes
    @State private var text = "hello, sky"
    @State private var form = 5.0
    @State private var hold = 5.0
    @State private var melt = 7.0
    @State private var pause = 1.0
    @State private var density = 0.5
    @State private var size = 0.3
    @State private var loop = false
    @State private var chain: [String] = []          // the words being shown, for Loop
    @State private var state = SkyShapeState.idle
    @State private var tab = Tab.word
    enum Tab: String, CaseIterable { case word = "Word", sky = "Sky" }
    private static let holdForever = 21.0             // the Hold slider's last step: hold until Stop
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            SkyView(options, controller: sky).ignoresSafeArea()
            panel
                .padding(14)
                .frame(width: 400)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                .padding(20)
        }
        .onReceive(tick) { _ in
            // Loop: queue the words again while the last one is up
            let st = sky.shapeState
            if loop, !chain.isEmpty, st.next.isEmpty, [.forming, .holding, .melting].contains(st.phase) { queue(chain, first: false) }
            state = sky.shapeState
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("Words, separated by commas", text: $text).textFieldStyle(.roundedBorder).onSubmit(formWords)
                Button("Form it", action: formWords).keyboardShortcut(.defaultAction)
                // Stop: whatever is forming, holding or morphing melts back into its cloud now, and nothing queued follows
                Button("Stop") { chain = []; sky.releaseShape() }.disabled(state.phase == .none)
            }
            HStack {
                Text(status).font(.callout.weight(.semibold)).lineLimit(1).truncationMode(.tail)
                Spacer()
                Toggle("Loop", isOn: $loop).toggleStyle(.checkbox)
            }
            HStack(spacing: 6) {
                ForEach(SkySymbol.allCases, id: \.self) { s in
                    Button { chain = []; sky.showShape(.symbol(s), size: size * 1.3, form: form, hold: holdValue, fade: melt, density: density) } label: {
                        symbolIcon(s).frame(maxWidth: .infinity, minHeight: 26)
                    }
                    .help(s.rawValue.capitalized)
                    .accessibilityLabel(s.rawValue.capitalized)
                }
            }
            Picker("", selection: $tab) { ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented).labelsHidden()
            if tab == .word {
                slider("Form", $form, 1...15, step: 0.5) { "\(trim($0))s" }
                slider("Hold", $hold, 0...Self.holdForever, step: 0.5) { $0 >= Self.holdForever ? "∞" : "\(trim($0))s" }
                slider("Melt", $melt, 1...15, step: 0.5) { "\(trim($0))s" }
                slider("Pause", $pause, 0...5, step: 0.5) { $0 == 0 ? "morph" : "\(trim($0))s" }
                slider("Density", $density, 0...1, step: 0.05) { "\(Int(($0 * 100).rounded()))%" }
                slider("Size", $size, 0.15...0.5, step: 0.01) { "\(Int(($0 * 100).rounded()))%" }
                Text("Commas chain words. Pause 0 morphs one straight into the next; Hold ∞ keeps it until Stop.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                slider("Clouds", $options.coverage, 0...1, step: 0.01) { "\(Int(($0 * 100).rounded()))%" }
                slider("Speed", $options.speed, 0...4, step: 0.05) { "\(trim($0))×" }
                slider("Fade", $options.gradient, 0...1, step: 0.01) { "\(Int(($0 * 100).rounded()))%" }
                Picker("Palette", selection: $options.palette) {
                    ForEach(SkyOptions.Palette.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }.pickerStyle(.segmented)
                HStack {
                    Toggle("Planes", isOn: $options.planes)
                    Button("Fly a plane") { sky.flyPlane() }
                }
            }
        }
    }

    private var holdValue: Double { hold >= Self.holdForever ? .infinity : hold }
    private func formWords() {
        let words = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        chain = words.isEmpty ? ["☁"] : words
        queue(chain, first: true)   // the first takes over from whatever is on screen, without a jump
    }
    private func queue(_ words: [String], first: Bool) {
        for (i, w) in words.enumerated() {
            sky.showShape(.text(w), size: size, form: form, hold: holdValue, fade: melt, density: density, queue: !(first && i == 0), pause: pause)
        }
    }
    private var status: String {
        let names: [SkyShapeState.Phase: String] = [.waiting: "Starting", .forming: "Forming", .holding: "Holding", .melting: "Melting back"]
        guard state.phase != .none, let name = names[state.phase] else { return "Type words or pick a symbol" }
        let quote = { (s: String) in s == "image" ? s : "“\(s)”" }
        return name + (state.label.map { " " + quote($0) } ?? "") + (state.next.isEmpty ? "" : " · next: " + state.next.map(quote).joined(separator: ", "))
    }
    private func symbolIcon(_ s: SkySymbol) -> some View {
        Group {
            if let img = s.image(height: 40) { Image(decorative: img, scale: 2).renderingMode(.template) } else { Text(s.rawValue) }
        }
    }
    private func slider(_ name: String, _ value: Binding<Double>, _ range: ClosedRange<Double>, step: Double,
                        format: @escaping (Double) -> String) -> some View {
        HStack {
            Text(name).frame(width: 58, alignment: .leading)
            // (rounded to the step by hand: a stepped Slider draws a tick for every step)
            Slider(value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = ($0 / step).rounded() * step }), in: range)
            Text(format(value.wrappedValue)).monospacedDigit().frame(width: 52, alignment: .trailing)
        }
    }
    private func trim(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
}
#else
// The window demo is macOS-only; on iOS use SkyView inside your own app.
@main enum SkyDemoApp { static func main() {} }
#endif
