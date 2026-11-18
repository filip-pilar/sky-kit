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
// c = (haze, farMask, seed.x, seed.y)           d = (target height in pixels, shape forming 0..1, melting 0..1, thickness)
// shapeRect = cloud-space (x0, y0, width, height) of the shape image
// srcRect = cloud-space (x0, y0, width, height) of the map of the cloud the shape is made from; e = (density, 0, 0, 0)
// e = (density, 1 = turning straight from the previous shape, its thickness, 0); prevRect = cloud-space rect of its mask
struct CloudParams { float4 a; float4 b; float4 c; float4 d; float4 shapeRect; SkyColors sky; float4 srcRect; float4 e; float4 prevRect; };

// ---- shapes (the mask texture has top-down rows, so it is sampled at 1 - y)
// A shape is part of the same cloud field: while it is on screen the near clouds over its wide area
// are rendered live every frame, and the shape only changes the density before it is turned into
// cloud and shaded. Forming: a front sweeps in from the edge of the wide area; cloud piles up ahead
// of it into a bank and the sky behind it empties (that cloud went into the shape), so the cloud
// gathers from all around and ends as the shape, which condenses puff by puff. Melting: the shape
// swells out into a broad soft mass that thins away while the clouds around it come back.
// d.y = forming progress (stays 1 while holding and melting), d.z = melting progress, d.w = thickness
// (0 = thin strokes like text, 1 = a solid shape like a heart).
static float4 maskAt(float2 su, texture2d<float> shape) {
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return shape.sample(s, float2(su.x, 1.0 - su.y));
}
// R = the shape (softened), G = near halo, B = very wide blur (the shape's body),
// A = the wide area the shape gathers from and dissolves into (0 at the image's edge)
static float4 shapeAt(float2 p, constant CloudParams& P, texture2d<float> shape) {
    float2 su = (p - P.shapeRect.xy) / P.shapeRect.zw;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return float4(0.0);
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return shape.sample(s, float2(su.x, 1.0 - su.y));
}
// the cloud the shape is made from: 1 on it (its map has bottom-up rows), so only that cloud gives way
static float4 prevAt(float2 p, constant CloudParams& P, texture2d<float> prev) {   // the previous shape's mask (same layout)
    float2 su = (p - P.prevRect.xy) / P.prevRect.zw;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return float4(0.0);
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return prev.sample(s, float2(su.x, 1.0 - su.y));
}
static float srcAt(float2 p, constant CloudParams& P, texture2d<float> src) {
    float2 su = (p - P.srcRect.xy) / P.srcRect.zw;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return 0.0;
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return src.sample(s, su).r;
}
static float smax(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
static float smin(float a, float b, float k) { return -smax(-a, -b, k); }
static float2 gatherFrom(float2 p, constant CloudParams& P, texture2d<float> shape, thread float2& toward) { toward = float2(0.0); return p; }   // (shapes no longer pull clouds in)
// the density of a shape's own cloud: its outline wobbles at puff scale (stroke width varies like a lumpy
// cloud); bumps about a letter-stroke wide; solid shapes (t near 1) also get a domed body (densest in the
// middle, so it shades round, from body) and cauliflower lumps that shape the outline
static float shapeFill(float R, float body, float t, float thr, float v, float bil, float lumps, float big, float small, float density) {
    if (R <= 0.001) return thr - 0.3;
    // how far above the cloud threshold: the outline, then (solid shapes) a low dome broken up inside into lumps
    // and see-through gaps like a real cloud's (the outline itself stays readable), fine detail, and (mostly for
    // text) thicker where the sky's own cloud is thick
    float inner = smoothstep(0.55, 0.95, R) * t;
    float edge = (R - 0.5) * mix(0.5, 0.45, t);
    float rest = ((body - 0.5) * 0.2 + 0.03) * t + (lumps * 0.5 - 0.08) * inner
               + big * (mix(0.3, 0.15, t) + 0.15 * inner) + small * mix(0.15, 0.1, t) + (bil - 0.35) * 0.2
               + clamp(v - thr, -0.3, 0.3) * mix(0.25, 0.1, t);
    // density: low = wispy and see-through (the inside fades more than the outline), high = solid. The noise is
    // never made stronger, and the core of every thin part (a dot, a stroke) keeps a minimum density that grows
    // with the setting, so nothing the shape is made of can vanish; wide insides (body high) may still open up
    float lo = density * 2.0, hi = density * 2.0 - 1.0;
    float ex = density < 0.5 ? edge * mix(0.6, 1.0, lo) + rest * mix(0.35, 1.0, lo) + (density - 0.5) * 0.06
                             : edge * mix(1.0, 1.3, hi) + rest + hi * 0.06;
    ex = max(ex, smoothstep(0.7, 0.95, R) * (1.0 - 0.85 * smoothstep(0.5, 0.85, body)) * mix(0.02, 0.18, density));
    return mix(thr - 0.3, thr + ex, smoothstep(0.0, 0.1, R));
}
// v: the near clouds' density here; p: position. The shape sits on a real cloud and that cloud reshapes
// into it, puff by puff. Melting runs it back, so the shape turns into the same cloud again, which stays
// (and keeps drifting and changing like the others). Other clouds are left alone. When it follows another
// shape directly (e.y = 1), it is there from the start and that shape's outline turns into its own,
// puff by puff. own: how much of the density here is the shape's; shR: the shape's silhouette here.
static float withShape(float v, float2 p, float thr, float bil, float2 so, bool lite, constant CloudParams& P, texture2d<float> shape,
                       texture2d<float> srcMap, texture2d<float> prev, thread float& own, thread float& shR) {
    own = 0.0; shR = 0.0;
    if (P.d.y <= 0.0) return v;
    bool morph = P.e.y > 0.0;
    float4 m = shapeAt(p, P, shape), mp = morph ? prevAt(p, P, prev) : float4(0.0);
    float src = srcAt(p, P, srcMap);
    if (m.y <= 0.0 && mp.y <= 0.0 && src <= 0.0) return v;
    float t = P.d.w;
    float form = morph ? 1.0 - P.d.z : P.d.y * (1.0 - P.d.z);   // rises while forming, falls while melting
    float cloudy = smoothstep(thr - 0.25, thr + 0.1, v);              // 1 on the cloud
    float rag = lite ? 0.5 : fbm(p * 6.0 + float2(3.1, 5.9), 2) + 0.5;
    float when = clamp(smoothstep(0.25, 0.75, rag) * 0.7 + (1.0 - cloudy) * 0.2, 0.0, 0.75);   // puff by puff, spread over the whole time; on the cloud a little sooner
    float S = smoothstep(when, when + 0.25, form);
    // the previous shape's outline → this one's, puff by puff, first where the previous shape is, then outward
    // from it (its mask's wide blur, A, says how near it is), so a longer word grows out of the shorter one
    float whenK = clamp((1.0 - mp.w) * 0.6 + smoothstep(0.25, 0.75, rag) * 0.4, 0.0, 0.75);
    float K = morph ? smoothstep(whenK, whenK + 0.25, P.d.y) : 1.0;
    float R = 0.0, fill = thr - 0.3;
    shR = mix(mp.x, m.x, K);
    if (m.y > 0.0 || mp.y > 0.0) {
      // (the outline wobbles by a few mask pixels, so the wobble scales with the shape and can't tear its small parts)
      float2 wob = lite ? float2(0.0) : float2(fbm(p * 6.5 + float2(2.3, 8.9), 2), fbm(p * 6.5 + float2(7.7, 1.3), 2))
                                        * (P.shapeRect.w / float(shape.get_height())) * mix(4.5, 6.5, t);
      float4 ms = shapeAt(p + wob, P, shape), mps = K < 1.0 ? prevAt(p + wob, P, prev) : float4(0.0);
      R = mix(mps.x, ms.x, K);
      if (R > 0.001) {
        float lumps = lite ? 0.0 : fbm(p * 5.5 + float2(5.1, 7.3), 3);
        float big = lite ? 0.0 : fbm(p * 9.0 + float2(3.7, 1.9), 3);
        float small = lite ? 0.0 : fbm(p * 26.0 + float2(8.1, 2.3), 2);
        fill = shapeFill(ms.x, ms.z, t, thr, v, bil, lumps, big, small, P.e.x);
        if (K < 1.0) fill = mix(shapeFill(mps.x, mps.z, P.e.z, thr, v, bil, lumps, big, small, P.e.x), fill, K);
      }
    }
    // the shape replaces the cloud it is made from, which thins out evenly (so it shrinks along its own puffy
    // edges) while the shape grows puff by puff; any other cloud it touches is only added to, never cut into
    src = smoothstep(0.1, 0.9, src + 0.35 * (rag - 0.5));             // where it fades out, a puffy edge
    float w = max(S * smoothstep(0.0, 0.1, R), smoothstep(0.05, 0.85, form + 0.1 * (rag - 0.5)) * src);
    own = w * max(src, smoothstep(-0.05, 0.05, fill - v));
    return mix(v, mix(max(v, fill), fill, src), w);
}

static float4 cumulus(float2 p, float2 pg, float2 so, float scale, float2 seed, float cov, float morph, constant CloudParams& P, texture2d<float> shape, texture2d<float> srcMap, texture2d<float> prev) {
    float2 q = pg * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
    float base = fbm(q * 0.7 + w * 0.6, 4);
    float bil = billow(q * 2.0 + w, 3);
    float thr = mix(0.22, -0.12, cov);
    float own, shR;
    float v = withShape(base + 0.15 * (bil - 0.35), p, thr, bil, so, false, P, shape, srcMap, prev, own, shR);
    // a shape's rim fades out slowly like other clouds' edges (more for solid shapes); the outline stays put
    float rim = own * (1.0 - 0.6 * smoothstep(0.35, 0.8, shR)) * mix(0.6, 1.0, P.d.w) * (P.e.y > 0.0 ? 1.0 : smoothstep(0.0, 0.5, P.d.y)) * (1.0 - smoothstep(0.2, 0.6, P.d.z));
    float D = smoothstep(thr, thr + 0.22 + 0.55 * rim, v);
    float dome = smoothstep(thr, thr + 0.7, v);
    float inShape = shR * own * (1.0 - P.d.w);                        // softer fine texture inside thin shapes (text)
    return float4(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * scale, own, shR);
}
static float cumulusLite(float2 p, float2 pg, float2 so, float scale, float2 seed, float cov, float morph, constant CloudParams& P, texture2d<float> shape, texture2d<float> srcMap, texture2d<float> prev) {
    float2 q = pg * float2(2.2, 3.4) / scale + seed;
    float2 w = float2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
    float thr = mix(0.22, -0.12, cov);
    float own, shR;
    float v = withShape(fbm(q * 0.7 + w * 0.6, 3), p, thr, 0.35, so, true, P, shape, srcMap, prev, own, shR);
    return smoothstep(thr, thr + 0.22, v);
}

fragment float4 sky_cloud(VOut in [[stage_in]], constant CloudParams& P [[buffer(0)]], texture2d<float> shape [[texture(0)]], texture2d<float> srcMap [[texture(1)]],
                          texture2d<float> prev [[texture(2)]]) {
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
    float2 toward;
    float2 pg = gatherFrom(p, P, shape, toward), dg = pg - p;         // same nudge for the shadow samples
    float2 so = toward * mix(0.07, 0.13, P.d.w) * smoothstep(0.1, 0.8, P.d.z);   // melting: its pieces drift outward
    float4 D0 = cumulus(p, pg, so, scale, seed, cov, P.b.x, P, shape, srcMap, prev);
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
    for (int i = 1; i <= 4; i++) { float2 ps = p + L2 * 0.028 * float(i) * scale; occ += cumulusLite(ps, ps + dg, so, scale, seed, cov, P.b.x, P, shape, srcMap, prev); }
    c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * P.b.w);
    c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * P.b.w * (1.0 - s));
    // a thin shape barely shades itself: give its body the tone a big cloud's body has (a solid one shades itself, so less)
    if (P.d.y > 0.0) c = mix(c, SHADE, D0.w * D0.z * mix(0.7, 0.25, P.d.w) * P.b.w);
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
// patch = view-relative (x0, y0, width, height) of the live patch over a shape; patch2 = (on, blend border width, texture u, v extent of this frame's clouds)
// mask = view-relative (x0, y0, width, height) of the whole shape mask; shapeAM = (forming, melting, thickness, 0)
struct CompositeParams { float4 a; float4 far; float4 near; float4 patch; float4 patch2; float4 mask; float4 shapeAM; SkyColors sky; };

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
        float fade = exp(-ta / life) * smoothstep(0.0, 0.8, ta) / (1.0 + ta * 0.06)
                   * smoothstep(0.0, 0.05 + wdt * 6.0, along);              // the trail fades in from where the plane started (no straight cut once it has spread)
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
                              texture2d<float> nearA [[texture(2)]], texture2d<float> nearB [[texture(3)]],
                              texture2d<float> patch [[texture(4)]], texture2d<float> mask [[texture(5)]]) {
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
    if (P.patch2.x > 0.0) {
        float2 d = min(p - P.patch.xy, P.patch.xy + P.patch.zw - p);
        float k = smoothstep(0.0, P.patch2.y, min(d.x, d.y));            // the patch matches the snapshot at its border
        if (k > 0.0) {
            constexpr sampler s(filter::linear, address::clamp_to_edge);
            float2 su = (p - P.patch.xy) / P.patch.zw;
            near = mix(near, patch.sample(s, float2(su.x, 1.0 - su.y) * P.patch2.zw), k);
        }
    }
    col = col * (1.0 - near.a) + near.rgb;
    col += (hash12(frag) - 0.5) / 255.0;
    return float4(col, 1.0);
}
"""#
}
