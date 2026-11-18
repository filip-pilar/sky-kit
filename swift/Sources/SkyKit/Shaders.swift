// Metal port of web/src/sky.js (CLOUD_FS and COMPOSITE_FS). Keep the two in sync.
//
// Conventions that differ from WebGL and are converted here:
//  - Metal's [[position]] has its origin at the top-left; all math uses GL-style
//    coordinates (origin bottom-left): frag = (pos.x, targetHeight - pos.y).
//  - dfdy follows the flipped y axis, so its sign is negated.
//  - Texture row 0 is the top in Metal, so snapshots are sampled at v = 1 - y.
// Compiled at runtime with fast math off so the noise hash matches WebGL bit for bit (as near as GPUs allow).

enum SkyShaders {
    static let source = #"""
#include <metal_stdlib>
using namespace metal;

struct VOut { float4 pos [[position]]; };

vertex VOut sky_fullscreen(uint vid [[vertex_id]]) {
    float2 p = float2(vid == 1 ? 3.0 : -1.0, vid == 2 ? 3.0 : -1.0);
    VOut o; o.pos = float4(p, 0.0, 1.0); return o;
}

constant float2x2 ROT = float2x2(float2(0.8, -0.6), float2(0.6, 0.8));

static float hash12(float2 p) {
    float3 p3 = fract(float3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
static float2 hash22(float2 p) {
    float3 p3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
static float gnoise(float2 p) {
    float2 i = floor(p), f = fract(p);
    float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(hash22(i) * 2.0 - 1.0, f);
    float b = dot(hash22(i + float2(1, 0)) * 2.0 - 1.0, f - float2(1, 0));
    float c = dot(hash22(i + float2(0, 1)) * 2.0 - 1.0, f - float2(0, 1));
    float d = dot(hash22(i + float2(1, 1)) * 2.0 - 1.0, f - float2(1, 1));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
static float fbm(float2 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * gnoise(p); p = ROT * p * 2.03 + float2(1.7, 9.2); a *= 0.5; }
    return s;
}
static float billow(float2 p, int oct) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * abs(gnoise(p)) * 1.4; n += a; p = ROT * p * 2.03 + float2(4.3, 1.1); a *= 0.5; }
    return s / n;
}

struct SkyColors { float4 top; float4 mid; float4 low; };
static float3 skyAt(float v, constant SkyColors& c) {
    float3 col = mix(c.low.rgb, c.mid.rgb, smoothstep(0.0, 0.5, v));
    return mix(col, c.top.rgb, smoothstep(0.4, 1.0, v));
}

static float2 cumulus(float2 p, float scale, float2 seed, float cov, float morph) {
    float2 q = p * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
    float base = fbm(q * 0.7 + w * 0.6, 4);
    float bil = billow(q * 2.0 + w, 3);
    float v = base + 0.15 * (bil - 0.35);
    float thr = mix(0.22, -0.12, cov);
    float D = smoothstep(thr, thr + 0.22, v);
    float dome = smoothstep(thr, thr + 0.7, v);
    return float2(D, (0.05 * dome + 0.012 * D * bil) * scale);
}
static float cumulusLite(float2 p, float scale, float2 seed, float cov, float morph) {
    float2 q = p * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
    float v = fbm(q * 0.7 + w * 0.6, 3);
    float thr = mix(0.22, -0.12, cov);
    return smoothstep(thr, thr + 0.22, v);
}

// a = (win0.x, win0.y, unitsPerPixel, viewH)   b = (morph, scale, coverage, shadow)
// c = (haze, farMask, seed.x, seed.y)           d = (target height in pixels, 0, 0, 0)
struct CloudParams { float4 a; float4 b; float4 c; float4 d; SkyColors sky; };

fragment float4 sky_cloud(VOut in [[stage_in]], constant CloudParams& P [[buffer(0)]]) {
    const float3 LIT = float3(1.0, 0.98, 0.94), SHADE = float3(0.635, 0.722, 0.902), RIM = float3(1.0, 0.925, 0.8);
    const float3 L = float3(-0.50, 0.70, 0.52);
    float2 frag = float2(in.pos.x, P.d.x - in.pos.y);
    float upp = P.a.z, viewH = P.a.w;
    float2 p = P.a.xy + frag * upp;
    float vv = p.y / viewH;
    float3 sky = skyAt(vv, P.sky);
    float scale = P.b.y;
    float2 seed = P.c.zw;
    float cov = P.b.z * mix(1.0, 0.75 + 0.35 * smoothstep(0.8, 0.1, vv), P.c.y);
    float2 D0 = cumulus(p, scale, seed, cov, P.b.x);
    float alpha = smoothstep(0.0, 0.61, D0.x);
    float2 grad = float2(dfdx(D0.y), -dfdy(D0.y)) / upp;
    if (alpha < 0.002) return float4(0.0);
    float3 n = normalize(float3(-grad * 0.7, 1.0));
    float2 L2 = normalize(L.xy);
    float t = clamp(dot(n, normalize(L)) * 0.5 + 0.5, 0.0, 1.0);
    float s = smoothstep(0.25, 0.8, t);
    float f = min(s * 2.0, 1.999);
    s = mix(s, (floor(f) + smoothstep(0.4, 0.6, fract(f))) / 2.0, 0.3);
    float3 c = mix(SHADE, LIT, s);
    float occ = 0.0;
    for (int i = 1; i <= 4; i++) occ += cumulusLite(p + L2 * 0.028 * float(i) * scale, scale, seed, cov, P.b.x);
    c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * P.b.w);
    c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * P.b.w * (1.0 - s));
    float edge = 1.0 - smoothstep(0.0, 0.3, D0.x);
    float facing = clamp(dot(normalize(n.xy + 1e-5), L2), 0.0, 1.0);
    c += RIM * edge * facing * 0.45;
    c = mix(c, sky, edge * (1.0 - facing) * 0.35);
    c += gnoise(p * 160.0) * 0.012;
    c = mix(c, mix(sky, float3(1.0), 0.4), P.c.x);
    return float4(min(c, float3(1.0)) * alpha, alpha);
}

// a = (width, height, unit, viewH)   far/near = (window start A, window start B, window width, fade)
// scroll = (far, near, 0, 0)
struct CompositeParams { float4 a; float4 far; float4 near; float4 scroll; SkyColors sky; };

static float4 layerAt(texture2d<float> A, texture2d<float> B, float4 w, float scroll, float2 p, float viewH) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float cx = p.x + scroll;
    float vy = 1.0 - p.y / viewH;
    float4 a = A.sample(s, float2((cx - w.x) / w.z, vy));
    float4 b = B.sample(s, float2((cx - w.y) / w.z, vy));
    return mix(a, b, w.w);
}

fragment float4 sky_composite(VOut in [[stage_in]], constant CompositeParams& P [[buffer(0)]],
                              texture2d<float> farA [[texture(0)]], texture2d<float> farB [[texture(1)]],
                              texture2d<float> nearA [[texture(2)]], texture2d<float> nearB [[texture(3)]]) {
    float2 frag = float2(in.pos.x, P.a.y - in.pos.y);
    float2 p = frag / P.a.z;
    float2 ph = frag / P.a.y;
    float3 col = skyAt(frag.y / P.a.y, P.sky);
    float sd = length(ph - float2(0.10 * P.a.x / P.a.y, 1.05));
    col += float3(1.0, 0.97, 0.88) * (0.20 * exp(-sd * 2.2) + 0.22 * exp(-sd * 9.0));
    float4 far = layerAt(farA, farB, P.far, P.scroll.x, p, P.a.w);
    col = col * (1.0 - far.a) + far.rgb;
    float4 near = layerAt(nearA, nearB, P.near, P.scroll.y, p, P.a.w);
    col = col * (1.0 - near.a) + near.rgb;
    col += (hash12(frag) - 0.5) / 255.0;
    return float4(col, 1.0);
}
"""#
}
