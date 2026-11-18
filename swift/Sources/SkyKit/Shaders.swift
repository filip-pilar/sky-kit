// Metal port of web/src/sky.js (CLOUD_FS and COMPOSITE_FS). Keep the two in sync.
//
// Conventions that differ from WebGL and are converted here:
//  - Metal's [[position]] has its origin at the top-left; all math uses GL-style
//    coordinates (origin bottom-left): frag = (pos.x, targetHeight - pos.y).
//  - dfdy follows the flipped y axis, so its sign is negated.
//  - Texture row 0 is the top in Metal, so snapshots and the shape mask are sampled at v = 1 - y.
// Compiled at runtime with fast math off so the noise hash matches WebGL as closely as GPUs allow.

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

// top.w = gradient: 0 = even blue, 1 = deep blue fading to a pale horizon
struct SkyColors { float4 top; float4 mid; float4 low; };
static float3 skyAt(float v, constant SkyColors& c) {
    float3 col = mix(c.low.rgb, c.mid.rgb, smoothstep(0.0, 0.5, v));
    col = mix(col, c.top.rgb, smoothstep(0.4, 1.0, v));
    return mix(mix(c.mid.rgb, c.top.rgb, 0.4), col, c.top.w);
}

// a = (win0.x, win0.y, unitsPerPixel, viewH)   b = (morph, scale, coverage, shadow)
// c = (haze, farMask, seed.x, seed.y)           d = (target height in pixels, shape amount, 0, 0)
// shapeRect = cloud-space (x0, y0, width, height) of the shape image
struct CloudParams { float4 a; float4 b; float4 c; float4 d; float4 shapeRect; SkyColors sky; };

// ---- shapes (the mask texture has top-down rows, so it is sampled at 1 - y)
static float2 shapeAt(float2 p, constant CloudParams& P, texture2d<float> shape) {
    float2 su = (p - P.shapeRect.xy) / P.shapeRect.zw;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return float2(0.0);
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return shape.sample(s, float2(su.x, 1.0 - su.y)).rg;
}
// While a shape forms, the clouds around it drift in toward it; as it melts they drift back out.
static float2 gatherWarp(float2 p, constant CloudParams& P, texture2d<float> shape) {
    float amt = P.d.y;
    if (amt <= 0.0) return p;
    float2 m = shapeAt(p, P, shape);
    if (m.y <= 0.001) return p;
    float e = 0.035;
    float2 grad = float2(shapeAt(p + float2(e, 0.0), P, shape).y - shapeAt(p - float2(e, 0.0), P, shape).y,
                         shapeAt(p + float2(0.0, e), P, shape).y - shapeAt(p - float2(0.0, e), P, shape).y) / (2.0 * e);
    float2 toward = grad / (length(grad) + 1.5);
    return p - toward * 0.3 * amt * m.y * (1.0 - smoothstep(0.1, 0.6, m.x));
}
// The silhouette is built out of cloud puffs that condense one by one (reverse order while melting);
// the clouds around it thin out because they were drawn in.
static float withShape(float v, float2 p, float thr, float bil, constant CloudParams& P, texture2d<float> shape) {
    float amt = P.d.y;
    if (amt <= 0.0) return v;
    float2 m = shapeAt(p, P, shape);
    if (m.y <= 0.001) return v;
    float big = fbm(p * 9.0 + float2(3.7, 1.9), 3);
    float small = fbm(p * 26.0 + float2(8.1, 2.3), 2);
    float order = clamp(big * 1.2 + 0.5, 0.0, 1.0);
    float grow = smoothstep(order * 0.75, order * 0.75 + 0.2, amt);
    v = mix(v, v * 0.5 - 0.2, m.y * (1.0 - m.x) * amt);
    float fill = thr + (m.x - 0.55) * 0.55 + big * 0.35 + small * 0.15 + (bil - 0.35) * 0.2;
    float h = clamp(0.5 + 0.5 * (fill - v) / 0.1, 0.0, 1.0);
    float both = mix(v, fill, h) + 0.1 * h * (1.0 - h);
    return mix(v, both, grow * smoothstep(0.02, 0.2, m.x));
}

static float2 cumulus(float2 p, float scale, float2 seed, float cov, float morph, constant CloudParams& P, texture2d<float> shape) {
    float2 q = gatherWarp(p, P, shape) * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
    float base = fbm(q * 0.7 + w * 0.6, 4);
    float bil = billow(q * 2.0 + w, 3);
    float thr = mix(0.22, -0.12, cov);
    float v = withShape(base + 0.15 * (bil - 0.35), p, thr, bil, P, shape);
    float D = smoothstep(thr, thr + 0.22, v);
    float dome = smoothstep(thr, thr + 0.7, v);
    float inShape = P.d.y > 0.0 ? shapeAt(p, P, shape).x * P.d.y : 0.0;
    return float2(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * scale);
}
static float cumulusLite(float2 p, float scale, float2 seed, float cov, float morph, constant CloudParams& P, texture2d<float> shape) {
    float2 q = p * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
    float thr = mix(0.22, -0.12, cov);
    float v = withShape(fbm(q * 0.7 + w * 0.6, 3), p, thr, 0.35, P, shape);
    return smoothstep(thr, thr + 0.22, v);
}

fragment float4 sky_cloud(VOut in [[stage_in]], constant CloudParams& P [[buffer(0)]], texture2d<float> shape [[texture(0)]]) {
    const float3 LIT = float3(1.0, 0.98, 0.94), SHADE = float3(0.635, 0.722, 0.902), RIM = float3(1.0, 0.925, 0.8);
    const float3 L = float3(-0.50, 0.70, 0.52);
    float2 frag = float2(in.pos.x, P.d.x - in.pos.y);
    float upp = P.a.z, viewH = P.a.w;
    float2 p = P.a.xy + frag * upp;
    float vv = p.y / viewH;
    float3 sky = skyAt(vv, P.sky);
    float scale = P.b.y;
    float2 seed = P.c.zw;
    float cov = P.b.z * mix(1.0, 0.75 + 0.35 * (1.0 - smoothstep(0.1, 0.8, vv)), P.c.y);   // edges in order: reversed edges are undefined
    float2 D0 = cumulus(p, scale, seed, cov, P.b.x, P, shape);
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
    for (int i = 1; i <= 4; i++) occ += cumulusLite(p + L2 * 0.028 * float(i) * scale, scale, seed, cov, P.b.x, P, shape);
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

// a = (width, height, unit, viewH)
// far/near = (scroll - start of A, scroll - start of B, window width, fade); offsets computed on the CPU in double precision
struct CompositeParams { float4 a; float4 far; float4 near; SkyColors sky; };

// plane[i] = (start x, start y, dir x, dir y)   info = (plane A age, plane B age, plane speed, trail life)
// info2 = (trail drift, 0, 0, 0)
struct ExtraParams { float4 plane[2]; float4 info; float4 info2; };

static float vnoise(float x) {
    float i = floor(x), f = fract(x);
    return mix(hash12(float2(i, 7.1)), hash12(float2(i + 1.0, 7.1)), f * f * (3.0 - 2.0 * f));
}
static float contrails(float2 p, constant ExtraParams& E, thread float& planeDot) {
    float tr = 0.0; planeDot = 0.0;
    float speed = E.info.z, life = E.info.w, drift = E.info2.x;
    for (int i = 0; i < 2; i++) {
        float age = i == 0 ? E.info.x : E.info.y;
        if (age < 0.0) continue;
        float2 S = E.plane[i].xy, D = E.plane[i].zw;
        float head = age * speed;
        float2 rel = p - S;
        float2 hp = rel - D * head;
        planeDot = max(planeDot, exp(-dot(hp, hp) / (0.0035 * 0.0035)));
        float ta0 = (head - dot(rel, D)) / speed;
        float2 relw = rel - float2(drift * max(ta0, 0.0), 0.0);
        float along = dot(relw, D);
        float ta = (head - along) / speed;
        if (along < 0.0 || ta <= 0.0) continue;
        float across = dot(relw, float2(-D.y, D.x)) + (vnoise(along * 18.0 + float(i) * 13.0) - 0.5) * 0.008 * min(ta * 0.1, 1.0);
        float wdt = 0.0022 + ta * 0.0016;
        float sep = 0.0028 * exp(-ta * 0.35);
        float u1 = (across - sep) / wdt, u2 = (across + sep) / wdt;
        float fade = exp(-ta / life) * smoothstep(0.0, 0.8, ta) / (1.0 + ta * 0.06);
        tr = max(tr, 0.5 * (exp(-u1 * u1) + exp(-u2 * u2)) * fade);
    }
    return tr;
}

static float4 layerAt(texture2d<float> A, texture2d<float> B, float4 w, float2 p, float viewH) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    float vy = 1.0 - p.y / viewH;
    float4 a = A.sample(s, float2((p.x + w.x) / w.z, vy));
    float4 b = B.sample(s, float2((p.x + w.y) / w.z, vy));
    return mix(a, b, w.w);
}

fragment float4 sky_composite(VOut in [[stage_in]], constant CompositeParams& P [[buffer(0)]], constant ExtraParams& E [[buffer(1)]],
                              texture2d<float> farA [[texture(0)]], texture2d<float> farB [[texture(1)]],
                              texture2d<float> nearA [[texture(2)]], texture2d<float> nearB [[texture(3)]]) {
    float2 frag = float2(in.pos.x, P.a.y - in.pos.y);
    float2 p = frag / P.a.z;
    float2 ph = frag / P.a.y;
    float3 col = skyAt(frag.y / P.a.y, P.sky);
    float sd = length(ph - float2(0.10 * P.a.x / P.a.y, 1.05));
    col += float3(1.0, 0.97, 0.88) * (0.20 * exp(-sd * 2.2) + 0.22 * exp(-sd * 9.0));
    float4 far = layerAt(farA, farB, P.far, p, P.a.w);
    col = col * (1.0 - far.a) + far.rgb;
    if (E.info.x >= 0.0 || E.info.y >= 0.0) {
        float pd;
        float tr = contrails(p, E, pd);
        col = mix(col, float3(1.0), clamp(tr, 0.0, 1.0) * 0.85);
        col = mix(col, float3(0.95, 0.97, 1.0), pd * 0.9);
    }
    float4 near = layerAt(nearA, nearB, P.near, p, P.a.w);
    col = col * (1.0 - near.a) + near.rgb;
    col += (hash12(frag) - 0.5) / 255.0;
    return float4(col, 1.0);
}
"""#
}
