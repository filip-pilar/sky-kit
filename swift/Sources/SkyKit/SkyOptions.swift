import simd

/// Settings for the sky. Mirrors the web package's options (same names, same defaults).
public struct SkyOptions: Equatable, Sendable {
    public enum Direction: Sendable { case left, right }
    public enum Palette: String, Sendable, CaseIterable { case summer, day, pastel }
    public enum Quality: Sendable { case high, balanced, low }

    /// 0 = still, 1 = gentle drift, 4 = brisk.
    public var speed: Double = 1
    /// 0 = almost clear … 1 = lots of cloud.
    public var coverage: Double = 0.6
    /// Shading inside clouds, 0 … 1.
    public var shadow: Double = 0.3
    /// Cloud size multiplier.
    public var cloudScale: Double = 1
    public var direction: Direction = .left
    /// Any number gives a different sky.
    public var seed: Double = 0
    public var palette: Palette = .summer
    /// Custom sky colours; override the palette when set.
    public var colors: SkyColors? = nil
    /// 0 = even blue sky, 1 = deep blue fading to a pale horizon.
    public var gradient: Double = 0
    /// Resolution of the cloud snapshots.
    public var quality: Quality = .high
    public var fps: Int = 60
    /// Occasional planes with contrails.
    public var planes = false
    /// Seconds a contrail lingers.
    public var trailLife: Double = 40
    /// Hold still when the system asks for reduced motion.
    public var respectReducedMotion = true

    public init(speed: Double = 1, coverage: Double = 0.6, shadow: Double = 0.3, cloudScale: Double = 1,
                direction: Direction = .left, seed: Double = 0, palette: Palette = .summer, colors: SkyColors? = nil,
                gradient: Double = 0, quality: Quality = .high, fps: Int = 60, planes: Bool = false,
                trailLife: Double = 40, respectReducedMotion: Bool = true) {
        self.speed = speed; self.coverage = coverage; self.shadow = shadow; self.cloudScale = cloudScale
        self.direction = direction; self.seed = seed; self.palette = palette; self.colors = colors; self.gradient = gradient
        self.quality = quality; self.fps = fps; self.planes = planes
        self.trailLife = trailLife; self.respectReducedMotion = respectReducedMotion
    }

    var resolvedColors: SkyColors { colors ?? SkyColors.palette(palette) }
}

/// Sky gradient colours, top to horizon, as linear 0…1 RGB (same values the web version uses).
public struct SkyColors: Equatable, Sendable {
    public var top: SIMD3<Float>
    public var mid: SIMD3<Float>
    public var low: SIMD3<Float>

    public init(top: SIMD3<Float>, mid: SIMD3<Float>, low: SIMD3<Float>) {
        self.top = top; self.mid = mid; self.low = low
    }
    /// Colours from hex strings like "#2a7be4".
    public init(top: String, mid: String, low: String) {
        self.init(top: .init(hex: top), mid: .init(hex: mid), low: .init(hex: low))
    }

    public static func palette(_ p: SkyOptions.Palette) -> SkyColors {
        switch p {
        case .day:    return SkyColors(top: "#2a7be4", mid: "#5fb0f4", low: "#cdeaff")
        case .summer: return SkyColors(top: "#1663d6", mid: "#3d9cf2", low: "#bfe4ff")
        case .pastel: return SkyColors(top: "#5a9ced", mid: "#93c7f6", low: "#e3f2ff")
        }
    }
}

extension SIMD3 where Scalar == Float {
    init(hex: String) {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt32(s, radix: 16) ?? 0
        self.init(Float((v >> 16) & 0xff) / 255, Float((v >> 8) & 0xff) / 255, Float(v & 0xff) / 255)
    }
}

/// One cloud unit in pixels for a w×h view (same formula as the web version).
public func cloudUnit(width w: Double, height h: Double, cloudScale: Double = 1) -> Double {
    min(max(h, w / 2.4), w * 0.9) * cloudScale
}
