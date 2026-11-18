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
// c = (haze, farMask, seed.x, seed.y)           d = (target height in pixels, 1 while a shape is active, 0, thickness)
// shapeRect = cloud-space (x0, y0, width, height) of the shape image
// copyBox[k] = home box of picked cloud k: centre x, y, half width, half height (cloud space); a piece torn
//              off a big cloud: centre x, y, -radius, radius
// copyMove[k] = its offset from home now (x, y), how far it has turned into the shape (0..1), how far it has travelled (0..1)
// copyTarget[k] = the cloud's centre now (x, y); how far its part of the shape reaches from there; the cloud's own radius
// (the shape starts growing within 40% of it)
// shapeExtra = (number of picked clouds, how far the shape is formed when there are none, 0, 0)
struct CloudParams { float4 a; float4 b; float4 c; float4 d; float4 shapeRect; SkyColors sky;
                     float4 copyBox[4]; float4 copyMove[4]; float4 copyTarget[4]; float4 shapeExtra; };

// ---- shapes (the mask texture has top-down rows, so it is sampled at 1 - y)
// A shape is made from the clouds near it. When it is placed, the renderer picks 2-4 nearby clouds (whole
// clouds with clear sky around them) and a part of the shape for each. While the shape is on screen the
// near clouds over its area are rendered live every frame: each picked cloud leaves its place and travels
// as an exact copy of itself (the same density, read from its home position in the noise) to its part of
// the shape, where its density blends into the shape's, so its outline flows into the letters, growing
// out from where the cloud is. Melting runs this backwards and the clouds travel home, so the sky ends
// exactly as it would have been.
static float4 shapeAt(float2 p, constant CloudParams& P, texture2d<float> shape) {
    float2 su = (p - P.shapeRect.xy) / P.shapeRect.zw;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return float4(0.0);
    constexpr sampler s(filter::linear, address::clamp_to_edge);
    return shape.sample(s, float2(su.x, 1.0 - su.y));
}
static float smax(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
static float smin(float a, float b, float k) { return -smax(-a, -b, k); }
// the near clouds' density at p (no shape): x = density, y = billow (their fine texture)
static float2 nearCloud(float2 p, constant CloudParams& P) {
    float2 q = p * float2(2.2, 3.4) / P.b.y + P.c.zw;
    float2 w = float2(fbm(q * 0.5 + P.b.x, 3), fbm(q * 0.5 + 5.2 - P.b.x, 3));
    float bil = billow(q * 2.0 + w, 3);
    return float2(fbm(q * 0.7 + w * 0.6, 4) + 0.15 * (bil - 0.35), bil);
}
static float nearCloudLite(float2 p, constant CloudParams& P) {
    float2 q = p * float2(2.2, 3.4) / P.b.y + P.c.zw;
    float2 w = float2(fbm(q * 0.5 + P.b.x, 2), fbm(q * 0.5 + 5.2 - P.b.x, 2));
    return fbm(q * 0.7 + w * 0.6, 3);
}
static float boxW(float2 q, float4 box, float m) { float2 a = abs(q); return (1.0 - smoothstep(box.z, box.z + m, a.x)) * (1.0 - smoothstep(box.w, box.w + m, a.y)); }
static float boxDist(float2 q, float4 box) { return length(max(abs(q) - box.zw, float2(0.0))); }

// v, bil: the near clouds here. Returns the density with the shape; S = how much of the cloud here is the
// shape's own (its soft rim and tone apply only to that, never to the clouds arriving or around it).
// lite: for the soft self-shadow samples (no fine noise: they run four times per pixel)
static float withShape(float v, thread float& bil, float2 p, float thr, bool lite, thread float& S, constant CloudParams& P, texture2d<float> shape) {
    S = 0.0;
    if (P.d.y <= 0.0) return v;
    float t = P.d.w;
    int n = int(P.shapeExtra.x + 0.5);
    // the picked clouds: each has left its home box and is somewhere on its way, as an exact copy
    float hole = 0.0, dent = 0.0, vC = thr - 1.0, bilC = bil;
    const float MARGIN = 0.035;                                       // clear sky around a picked cloud's box (as in the planner)
    float rag = lite ? 0.0 : fbm(p * 7.0 + float2(3.1, 5.9), 2) * 0.12;   // (how ragged the growth front is)
    for (int k = 0; k < 4; k++) {
        if (k >= n) break;
        float4 box = P.copyBox[k], mv = P.copyMove[k], tg = P.copyTarget[k];
        float2 home = p - box.xy, q = home - mv.xy;
        float wc, dq, g = 1.0;
        if (box.z < 0.0) {
            // a round piece of a big cloud: soft edged, it detaches gradually and leaves a soft dent
            float r = box.w;
            g = smoothstep(0.0, 0.15, mv.w);
            dent = max(dent, (1.0 - smoothstep(0.45 * r, r, length(home))) * g);
            wc = (1.0 - smoothstep(0.45 * r, r, length(q))) * g;
            dq = max(0.0, length(q) - 0.45 * r);
        } else {
            hole = max(hole, boxW(home, box, MARGIN));
            wc = boxW(q, box, MARGIN);
            dq = boxDist(q, box);
        }
        float vb = thr - 0.3;                                         // (clear sky, away from the copy)
        if (wc > 0.0) {
            float bb = 0.35;
            if (lite) vb = nearCloudLite(p - mv.xy, P); else { float2 c = nearCloud(p - mv.xy, P); vb = c.x; bb = c.y; }
            vb = mix(thr - 0.3, vb, wc);
            bilC = mix(bilC, bb, wc * smoothstep(thr - 0.2, thr + 0.2, vb));
        }
        // the cloud gives itself to the shape steadily as it turns into it (and takes itself back while melting)
        vC = max(vC, vb - 1.5 * dq - mv.z * mv.z * 0.5);
        // the shape forms behind a ragged front that grows out from the cloud, and shrinks back into it
        // while melting
        const float band = 0.12;
        float d = max(0.0, length(p - tg.xy) - 0.4 * tg.w) + rag;
        S = max(S, smoothstep(0.0, 1.0, (mv.z * (tg.z + band) - d) / band));
    }
    if (n == 0) S = P.shapeExtra.y;
    float amb = mix(v, -1.0, hole) - dent * 0.7;
    float4 m = shapeAt(p, P, shape);
    // near thin strokes (text) other cloud turns into thin wisps (dense cloud thins so the letters stay
    // readable, faint cloud thickens a little); a solid shape just merges with the clouds it touches
    float outside = 1.0 - smoothstep(0.3, 0.65, m.x);
    amb = mix(amb, smin(amb + 0.12, thr + 0.06, 0.08), m.y * outside * smoothstep(0.0, 0.6, S) * (1.0 - t));
    // the shape's own cloud: its outline wobbles at puff scale (stroke width varies like a lumpy cloud);
    // bumps about a letter-stroke wide; solid shapes also get a domed body (densest in the middle, so it
    // shades round) and cauliflower lumps that shape the outline
    float fill = -1.0;
    if (m.y > 0.0) {
        float2 wob = lite ? float2(0.0) : float2(fbm(p * 6.5 + float2(2.3, 8.9), 2), fbm(p * 6.5 + float2(7.7, 1.3), 2)) * mix(0.025, 0.06, t);
        float4 ms = shapeAt(p + wob, P, shape);
        if (ms.x > 0.001) {
            float lumps = lite ? 0.0 : fbm(p * 5.5 + float2(5.1, 7.3), 3);
            float big = lite ? 0.0 : fbm(p * 9.0 + float2(3.7, 1.9), 3);
            float small = lite ? 0.0 : fbm(p * 26.0 + float2(8.1, 2.3), 2);
            fill = thr + (ms.x - 0.5) * mix(0.5, 0.45, t) + ((ms.z - 0.5) * 0.3 + lumps * 0.3 + 0.05) * t
                 + big * mix(0.3, 0.15, t) + small * mix(0.15, 0.05, t) + (bil - 0.35) * 0.2;
            fill = mix(-1.0, fill, smoothstep(0.0, 0.1, ms.x));
        }
    }
    // the travelling clouds turn into the shape: the shape grows behind the front while the clouds give way
    float vL = mix(thr - 0.3, fill, S);
    float vS = smax(vC, vL, 0.06);
    // (the shape's own cloud: where it, not another cloud, is the cloud, and not where it meets a dense
    // cloud, so its soft rim doesn't show sky between them)
    float other = max(vC, amb);
    S = S * smoothstep(-0.06, 0.06, vL - other) * (1.0 - smoothstep(thr - 0.05, thr + 0.15, other));
    bil = mix(bil, bilC, smoothstep(-0.08, 0.08, vS - amb) * (1.0 - S));   // fine texture by which one is the cloud here
    return smax(amb, vS, 0.05);
}

// x = density, y = height (for shading); S = how far a shape has formed here
static float2 cumulus(float2 p, float thr, thread float& S, constant CloudParams& P, texture2d<float> shape) {
    float2 c = nearCloud(p, P);
    float bil = c.y;
    float v = withShape(c.x, bil, p, thr, false, S, P, shape);
    float4 m = P.d.y > 0.0 ? shapeAt(p, P, shape) : float4(0.0);
    // a shape's rim fades out slowly like other clouds' edges (more for solid shapes); the outline stays put
    float rim = smoothstep(0.0, 0.3, m.y) * (1.0 - 0.6 * smoothstep(0.35, 0.8, m.x)) * mix(0.6, 1.0, P.d.w) * smoothstep(0.0, 0.5, S);
    float D = smoothstep(thr, thr + 0.22 + 0.55 * rim, v);
    float dome = smoothstep(thr, thr + 0.7, v);
    float inShape = m.x * S;                                          // softer fine texture inside a shape
    return float2(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * P.b.y);
}
static float cumulusLite(float2 p, float thr, constant CloudParams& P, texture2d<float> shape) {
    float bil = 0.35, S;
    float v = withShape(nearCloudLite(p, P), bil, p, thr, true, S, P, shape);
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
    float cov = P.b.z * mix(1.0, 0.75 + 0.35 * (1.0 - smoothstep(0.1, 0.8, vv)), P.c.y);   // edges in order: reversed edges are undefined
    float thr = mix(0.22, -0.12, cov);
    float S;
    float2 D0 = cumulus(p, thr, S, P, shape);
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
    for (int i = 1; i <= 4; i++) occ += cumulusLite(p + L2 * 0.028 * float(i) * scale, thr, P, shape);
    c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * P.b.w);
    c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * P.b.w * (1.0 - s));
    // a shape is thin, so it barely shades itself: give its body the tone a big cloud's body has
    if (P.d.y > 0.0) c = mix(c, SHADE, shapeAt(p, P, shape).x * S * 0.7 * P.b.w);
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
