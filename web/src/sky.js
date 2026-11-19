/**
 * sky-kit — endless drifting painterly clouds on a bright blue sky.
 *
 *   import { createSky } from 'sky-kit';
 *   const sky = createSky(document.querySelector('#hero'), { coverage: 0.6 });
 *   sky.set({ speed: 2 });  sky.pause();  sky.play();  sky.destroy();
 *   sky.flyPlane();  sky.showShape({ text: 'hello' });
 *
 * The sky fills `container` at full device resolution, redraws on resize, pauses when the
 * container is off-screen or the tab is hidden, and holds still for reduced-motion users.
 *
 * How it stays cheap: each cloud layer is painted into a snapshot image a bit wider than the
 * view. Every frame only slides those images and crossfades to the next snapshot (a moment of
 * sky time ahead), which is painted a strip per frame in the background. While a shape is on
 * screen, only the clouds around it are rendered live (see docs/ARCHITECTURE.md).
 */

export const PALETTES = {
  summer: { skyTop: '#1663d6', skyMid: '#3d9cf2', skyLow: '#bfe4ff' },
  day:    { skyTop: '#2a7be4', skyMid: '#5fb0f4', skyLow: '#cdeaff' },
  pastel: { skyTop: '#5a9ced', skyMid: '#93c7f6', skyLow: '#e3f2ff' },
};

export const SKY_DEFAULTS = {
  speed: 1,              // 0 = still, 1 = gentle drift, 4 = brisk
  coverage: 0.6,         // 0 = almost clear .. 1 = lots of cloud
  shadow: 0.3,           // shading inside clouds, 0 .. 1
  cloudScale: 1,         // cloud size multiplier
  direction: 'left',     // 'left' or 'right'
  seed: 0,               // any number: a different sky
  palette: 'summer',     // 'summer' | 'day' | 'pastel'; skyTop/skyMid/skyLow override it
  skyTop: null, skyMid: null, skyLow: null,
  gradient: 0,           // 0 = even blue sky, 1 = deep blue fading to a pale horizon
  quality: 'high',       // 'high' | 'balanced' | 'low' — resolution of the cloud snapshots
  fps: 60,               // frame cap
  planes: false,         // occasional planes with contrails
  trailLife: 40,         // seconds a contrail lingers
  respectReducedMotion: true,
};

const REBUILD_KEYS = ['coverage', 'shadow', 'seed', 'direction', 'palette', 'skyTop', 'skyMid', 'skyLow', 'gradient'];
const RESETUP_KEYS = ['cloudScale', 'quality'];
const QUALITY = { high: 1.25, balanced: 1.0, low: 0.75 };   // snapshot pixels per CSS pixel
const MARGIN = 0.3;        // extra cloud space on each side of the view, in cloud units
const PLANE_SPEED = 0.06;  // cloud units per second
// dt: seconds of sky time between snapshots; strips: frames used to paint one snapshot.
const LAYERS = [
  { scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1, dt: 2.0, strips: 24 },
  { scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0,  farMask: 0, dt: 2.0, strips: 24 },
];

/**
 * One cloud unit in pixels. Normally the view height; clamped so short wide banners and
 * tall narrow phones still get sensibly sized clouds.
 */
export function cloudUnit(w, h, cloudScale = 1) {
  return Math.min(Math.max(h, w / 2.4), w * 0.9) * cloudScale;
}

const VS = `#version 300 es
layout(location = 0) in vec2 a;
void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const COMMON = `
const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
uniform vec3 uSkyTop, uSkyMid, uSkyLow;
uniform float uGradient;      // 0 = even blue, 1 = deep blue fading to a pale horizon
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 skyAt(float v){          // v: 0 = bottom of view, 1 = top
  vec3 c = mix(uSkyLow, uSkyMid, smoothstep(0.0, 0.5, v));
  c = mix(c, uSkyTop, smoothstep(0.4, 1.0, v));
  return mix(mix(uSkyMid, uSkyTop, 0.4), c, uGradient);
}`;

const CLOUD_FS = `#version 300 es
precision highp float;
uniform vec2 uWin0;           // cloud-space position of the snapshot's bottom-left pixel
uniform float uUpp;           // cloud units per snapshot pixel
uniform float uViewH;         // view height in cloud units
uniform float uMorph, uScale, uCov, uShadow, uHaze, uFarMask;
uniform vec2 uSeed;
uniform sampler2D uShape;     // R = the shape (from the distance to its outline), G = near halo, B = very wide blur
                              // (the shape's body), A = how near the shape is (0 at the image's edge)
uniform vec4 uShapeRect;      // cloud-space x0, y0, width, height of the shape image
uniform float uShapeAmt;      // forming progress: 0 = no shape .. 1 = formed (stays 1 while holding and melting)
uniform float uShapeMelt;     // melting progress 0..1
uniform float uShapeThick;    // 0 = thin strokes (text) .. 1 = a solid shape (a heart, an emoji)
uniform float uShapeDensity; // how dense the finished shape is, 0..1 (0.5 = like the clouds around)
uniform sampler2D uSrc;       // the cloud the shape is made from (1 on it), so only that cloud gives way
uniform vec4 uSrcRect;       // cloud-space x0, y0, width, height of that map
uniform sampler2D uPrev;      // the previous shape's mask, while it turns straight into this one
uniform vec4 uPrevRect;       // cloud-space x0, y0, width, height of it
uniform vec2 uPrev2;          // (1 = turning straight from the previous shape, its thickness)
out vec4 outColor;
${COMMON}
const vec3 LIT = vec3(1.0, 0.98, 0.94), SHADE = vec3(0.635, 0.722, 0.902), RIM = vec3(1.0, 0.925, 0.8);
const vec3 L = vec3(-0.50, 0.70, 0.52);
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
  float c = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
  float d = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a * gnoise(p); p = ROT * p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
float billow(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a * abs(gnoise(p)) * 1.4; n += a; p = ROT * p * 2.03 + vec2(4.3, 1.1); a *= 0.5; }
  return s / n;
}

// ---- shapes: a shape only changes the near clouds' density before it is turned into cloud and shaded,
// so it is lit and textured like the clouds around it
vec4 shapeAt(vec2 p){
  vec2 su = (p - uShapeRect.xy) / uShapeRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return vec4(0.0);
  return texture(uShape, su);
}
vec4 prevAt(vec2 p){
  vec2 su = (p - uPrevRect.xy) / uPrevRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return vec4(0.0);
  return texture(uPrev, su);
}
float srcAt(vec2 p){
  vec2 su = (p - uSrcRect.xy) / uSrcRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return 0.0;
  return texture(uSrc, su).r;
}
// the density of a shape's own cloud at R (its silhouette), body (its wide blur) and thickness t
float shapeFill(float R, float body, float t, float thr, float v, float bil, float lumps, float big, float small){
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
  float d = uShapeDensity, lo = d * 2.0, hi = d * 2.0 - 1.0;
  float ex = d < 0.5 ? edge * mix(0.6, 1.0, lo) + rest * mix(0.35, 1.0, lo) + (d - 0.5) * 0.06
                     : edge * mix(1.0, 1.3, hi) + rest + hi * 0.06;
  ex = max(ex, smoothstep(0.7, 0.95, R) * (1.0 - 0.85 * smoothstep(0.5, 0.85, body)) * mix(0.02, 0.18, d));
  return mix(thr - 0.3, thr + ex, smoothstep(0.0, 0.1, R));
}
// v: the near clouds' density here; p: position. The shape sits on a real cloud and that cloud reshapes
// into it, puff by puff. Melting runs it back, so the shape turns into the same cloud again, which stays
// (and keeps drifting and changing like the others). Other clouds are left alone. When it follows another
// shape directly (uPrev2.x = 1), it is there from the start and that shape's outline turns into its own,
// puff by puff. own: how much of the density here is the shape's; shR: the shape's silhouette here.
float withShape(float v, vec2 p, float thr, float bil, bool lite, out float own, out float shR){
  own = 0.0; shR = 0.0;
  if (uShapeAmt <= 0.0) return v;
  bool morph = uPrev2.x > 0.0;
  vec4 m = shapeAt(p), mp = morph ? prevAt(p) : vec4(0.0);
  float src = srcAt(p);
  if (m.y <= 0.0 && mp.y <= 0.0 && src <= 0.0) return v;
  float t = uShapeThick;
  float form = morph ? 1.0 - uShapeMelt : uShapeAmt * (1.0 - uShapeMelt);   // rises while forming, falls while melting
  float cloudy = smoothstep(thr - 0.25, thr + 0.1, v);              // 1 on a cloud
  float rag = lite ? 0.5 : fbm(p * 6.0 + vec2(3.1, 5.9), 2) + 0.5;
  float when = clamp(smoothstep(0.25, 0.75, rag) * 0.7 + (1.0 - cloudy) * 0.2, 0.0, 0.75);   // puff by puff, spread over the whole time; on the cloud a little sooner
  float S = smoothstep(when, when + 0.25, form);
  // the previous shape's outline → this one's, puff by puff, first where the previous shape is, then outward
  // from it (its mask's wide blur, A, says how near it is), so a longer word grows out of the shorter one
  float whenK = clamp((1.0 - mp.w) * 0.6 + smoothstep(0.25, 0.75, rag) * 0.4, 0.0, 0.75);
  float K = morph ? smoothstep(whenK, whenK + 0.25, uShapeAmt) : 1.0;
  float R = 0.0, fill = thr - 0.3;
  shR = mix(mp.x, m.x, K);
  if (m.y > 0.0 || mp.y > 0.0){
    // the outline wobbles at puff scale by a few mask pixels (so it scales with the shape and can't tear small parts)
    vec2 wob = lite ? vec2(0.0) : vec2(fbm(p * 6.5 + vec2(2.3, 8.9), 2), fbm(p * 6.5 + vec2(7.7, 1.3), 2))
                                  * (uShapeRect.w / float(textureSize(uShape, 0).y)) * mix(4.5, 6.5, t);
    vec4 ms = shapeAt(p + wob), mps = K < 1.0 ? prevAt(p + wob) : vec4(0.0);
    R = mix(mps.x, ms.x, K);
    if (R > 0.001){
      float lumps = lite ? 0.0 : fbm(p * 5.5 + vec2(5.1, 7.3), 3);
      float big = lite ? 0.0 : fbm(p * 9.0 + vec2(3.7, 1.9), 3);
      float small = lite ? 0.0 : fbm(p * 26.0 + vec2(8.1, 2.3), 2);
      fill = shapeFill(ms.x, ms.z, t, thr, v, bil, lumps, big, small);
      if (K < 1.0) fill = mix(shapeFill(mps.x, mps.z, uPrev2.y, thr, v, bil, lumps, big, small), fill, K);
    }
  }
  // the shape replaces the cloud it is made from, which thins out evenly (so it shrinks along its own puffy
  // edges) while the shape grows puff by puff; any other cloud it touches is only added to, never cut into
  src = smoothstep(0.1, 0.9, src + 0.35 * (rag - 0.5));             // where it fades out, a puffy edge
  float w = max(S * smoothstep(0.0, 0.1, R), smoothstep(0.05, 0.85, form + 0.1 * (rag - 0.5)) * src);
  own = w * max(src, smoothstep(-0.05, 0.05, fill - v));
  return mix(v, mix(max(v, fill), fill, src), w);
}

vec4 cumulus(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
  float base = fbm(q * 0.7 + w * 0.6, 4);
  float bil = billow(q * 2.0 + w, 3);
  float thr = mix(0.22, -0.12, cov);
  float own, shR;
  float v = withShape(base + 0.15 * (bil - 0.35), p, thr, bil, false, own, shR);
  // a shape's rim fades out slowly like other clouds' edges (more for solid shapes); the outline stays put
  float rim = own * (1.0 - 0.6 * smoothstep(0.35, 0.8, shR)) * mix(0.6, 1.0, uShapeThick) * (uPrev2.x > 0.0 ? 1.0 : smoothstep(0.0, 0.5, uShapeAmt)) * (1.0 - smoothstep(0.2, 0.6, uShapeMelt));
  float D = smoothstep(thr, thr + 0.22 + 0.55 * rim, v);
  float dome = smoothstep(thr, thr + 0.7, v);
  float inShape = shR * own * (1.0 - uShapeThick);                   // softer fine texture inside thin shapes (text)
  return vec4(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * scale, own, shR);
}
float cumulusLite(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
  float thr = mix(0.22, -0.12, cov);
  float own, shR;
  float v = withShape(fbm(q * 0.7 + w * 0.6, 3), p, thr, 0.35, true, own, shR);
  return smoothstep(thr, thr + 0.22, v);
}
void main(){
  vec2 p = uWin0 + gl_FragCoord.xy * uUpp;
  float vv = p.y / uViewH;
  vec3 sky = skyAt(vv);
  float cov = uCov * mix(1.0, 0.75 + 0.35 * (1.0 - smoothstep(0.1, 0.8, vv)), uFarMask);   // edges in order: reversed edges are undefined in GLSL/Metal
  vec4 D0 = cumulus(p, uScale, uSeed, cov, uMorph);
  float alpha = smoothstep(0.0, 0.61, D0.x);
  vec2 grad = vec2(dFdx(D0.y), dFdy(D0.y)) / uUpp;
  if (alpha < 0.002){ outColor = vec4(0.0); return; }
  vec3 n = normalize(vec3(-grad * 0.7, 1.0));
  vec2 L2 = normalize(L.xy);
  float t = clamp(dot(n, normalize(L)) * 0.5 + 0.5, 0.0, 1.0);
  float s = smoothstep(0.25, 0.8, t);
  float f = min(s * 2.0, 1.999);
  s = mix(s, (floor(f) + smoothstep(0.4, 0.6, fract(f))) / 2.0, 0.3);
  vec3 c = mix(SHADE, LIT, s);
  float occ = 0.0;
  for (int i = 1; i <= 4; i++){ vec2 ps = p + L2 * 0.028 * float(i) * uScale; occ += cumulusLite(ps, uScale, uSeed, cov, uMorph); }
  c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * uShadow);
  c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * uShadow * (1.0 - s));
  // a thin shape barely shades itself: give its body the tone a big cloud's body has (a solid one shades itself, so less)
  if (uShapeAmt > 0.0) c = mix(c, SHADE, D0.w * D0.z * mix(0.7, 0.25, uShapeThick) * uShadow);
  float edge = 1.0 - smoothstep(0.0, 0.3, D0.x);
  float facing = clamp(dot(normalize(n.xy + 1e-5), L2), 0.0, 1.0);
  c += RIM * edge * facing * 0.45;
  c = mix(c, sky, edge * (1.0 - facing) * 0.35);
  c += gnoise(p * 160.0) * 0.012;
  c = mix(c, mix(sky, vec3(1.0), 0.4), uHaze);
  outColor = vec4(min(c, 1.0) * alpha, alpha);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uUnit, uViewH;
uniform sampler2D uFarA, uFarB, uNearA, uNearB;
uniform vec4 uFar, uNear;      // (scroll - start of A, scroll - start of B, window width, fade); offsets computed on the CPU in double precision
uniform vec4 uPlane[2];        // view-relative start x, y and direction
uniform vec2 uPlaneAge;        // seconds since launch, < 0 = none
uniform float uPlaneSpeed, uTrailLife, uTrailDrift;
uniform sampler2D uPatch;      // near clouds over the shape's area, rendered live this frame
uniform vec4 uShapeView;       // view-relative x0, y0, width, height of that area (it drifts with the clouds)
uniform float uPatchOn, uPatchFade;   // patch present; width of its blend border in cloud units
uniform vec2 uPatchUV;         // the part of the patch texture that holds this frame's clouds
out vec4 outColor;
${COMMON}
vec4 layerAt(sampler2D A, sampler2D B, vec4 w, vec2 p){
  float vy = p.y / uViewH;
  vec4 a = texture(A, vec2((p.x + w.x) / w.z, vy));
  vec4 b = texture(B, vec2((p.x + w.y) / w.z, vy));
  return mix(a, b, w.w);
}
float vnoise(float x){
  float i = floor(x), f = fract(x);
  return mix(hash12(vec2(i, 7.1)), hash12(vec2(i + 1.0, 7.1)), f * f * (3.0 - 2.0 * f));
}
float contrails(vec2 p, out float planeDot){
  float tr = 0.0; planeDot = 0.0;
  for (int i = 0; i < 2; i++){
    float age = i == 0 ? uPlaneAge.x : uPlaneAge.y;
    if (age < 0.0) continue;
    vec2 S = uPlane[i].xy, D = uPlane[i].zw;
    float head = age * uPlaneSpeed;
    vec2 rel = p - S;
    vec2 hp = rel - D * head;
    planeDot = max(planeDot, exp(-dot(hp, hp) / (0.0035 * 0.0035)));
    float ta0 = (head - dot(rel, D)) / uPlaneSpeed;
    vec2 relw = rel - vec2(uTrailDrift * max(ta0, 0.0), 0.0);   // the trail drifts with the wind
    float along = dot(relw, D);
    float ta = (head - along) / uPlaneSpeed;                    // seconds since the plane passed here
    if (along < 0.0 || ta <= 0.0) continue;
    float across = dot(relw, vec2(-D.y, D.x)) + (vnoise(along * 18.0 + float(i) * 13.0) - 0.5) * 0.008 * min(ta * 0.1, 1.0);
    float wdt = 0.0022 + ta * 0.0016;
    float sep = 0.0028 * exp(-ta * 0.35);                       // two engine trails that merge
    float u1 = (across - sep) / wdt, u2 = (across + sep) / wdt;
    float life = exp(-ta / uTrailLife) * smoothstep(0.0, 0.8, ta) / (1.0 + ta * 0.06)
               * smoothstep(0.0, 0.05 + wdt * 6.0, along);                   // the trail fades in from where the plane started (no straight cut once it has spread)
    tr = max(tr, 0.5 * (exp(-u1 * u1) + exp(-u2 * u2)) * life);
  }
  return tr;
}
void main(){
  vec2 p = gl_FragCoord.xy / uUnit;               // cloud units, view-relative
  vec2 ph = gl_FragCoord.xy / uRes.y;             // view-height units (for the sun glow)
  vec3 col = skyAt(gl_FragCoord.y / uRes.y);
  float sd = length(ph - vec2(0.10 * uRes.x / uRes.y, 1.05));
  col += vec3(1.0, 0.97, 0.88) * (0.20 * exp(-sd * 2.2) + 0.22 * exp(-sd * 9.0));
  vec4 far = layerAt(uFarA, uFarB, uFar, p);
  col = col * (1.0 - far.a) + far.rgb;
  if (uPlaneAge.x >= 0.0 || uPlaneAge.y >= 0.0){
    float pd;
    float tr = contrails(p, pd);
    col = mix(col, vec3(1.0), clamp(tr, 0.0, 1.0) * 0.85);
    col = mix(col, vec3(0.95, 0.97, 1.0), pd * 0.9);
  }
  vec4 near = layerAt(uNearA, uNearB, uNear, p);
  if (uPatchOn > 0.0){
    vec2 d = min(p - uShapeView.xy, uShapeView.xy + uShapeView.zw - p);
    float k = smoothstep(0.0, uPatchFade, min(d.x, d.y));            // the patch matches the snapshot at its border
    if (k > 0.0) near = mix(near, texture(uPatch, (p - uShapeView.xy) / uShapeView.zw * uPatchUV), k);
  }
  col = col * (1.0 - near.a) + near.rgb;
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

const hex = h => {   // '#rrggbb', 'rrggbb' or '#rgb'
  h = String(h).replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => (parseInt(h.slice(i, i + 2), 16) || 0) / 255);
};
const smooth01 = x => { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); };

/** White silhouette of text or an image on a transparent canvas (shape is `px` tall). */
function silhouette(src, px) {
  const c = document.createElement('canvas'), x = c.getContext('2d');
  if (typeof src === 'string') {
    const font = `800 ${px}px ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif`;
    x.font = font;
    const m = x.measureText(src);
    c.width = Math.ceil(m.width) + 2; c.height = Math.ceil(px * 1.15);
    x.font = font; x.textBaseline = 'middle'; x.fillStyle = '#fff';
    x.fillText(src, 1, c.height / 2);
  } else {
    const iw = src.naturalWidth || src.videoWidth || src.width, ih = src.naturalHeight || src.videoHeight || src.height;
    c.height = px; c.width = Math.max(2, Math.round(px * iw / ih));
    x.drawImage(src, 0, 0, c.width, c.height);
    const id = x.getImageData(0, 0, c.width, c.height), d = id.data;
    let transparent = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { transparent = true; break; }
    for (let i = 0; i < d.length; i += 4) {   // transparent images: use alpha; opaque ones: dark = shape
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      d[i + 3] = transparent ? d[i + 3] : Math.round((1 - lum) * 255);
      d[i] = d[i + 1] = d[i + 2] = 255;
    }
    x.putImageData(id, 0, 0);
  }
  return c;
}
/**
 * Squared distance transform (Felzenszwalb & Huttenlocher), in place: f holds a squared offset on the seed
 * pixels and 1e20 elsewhere, and ends up holding each pixel's squared distance (via the nearest seed, plus its
 * offset). Port: ShapeMask.edt in Swift.
 */
function edt(f, w, h) {
  const n = Math.max(w, h), g = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const line = len => {   // g → g, one line
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((g[q] + q * q) - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + g[v[k]]; }
    g.set(out.subarray(0, len));
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) g[y] = f[y * w + x]; line(h); for (let y = 0; y < h; y++) f[y * w + x] = g[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) g[x] = f[y * w + x]; line(w); for (let x = 0; x < w; x++) f[y * w + x] = g[x]; }
}
/**
 * The shape channel (R): 0.5 exactly on the silhouette's edge, rising to 1 within `soft` pixels inside it and
 * falling to 0 within `soft` pixels outside, from the distance to the edge, so every part of the shape, however
 * small (a dot, a thin stroke), keeps a solid core; lightly smoothed (blur radius `smooth`). 0..255.
 * Port: ShapeMask.edgeChannel.
 */
function edgeChannel(alpha, w, h, soft, smooth) {
  // the edge is where the (slightly smoothed, so any antialiasing looks alike) coverage crosses 1/2; the pixels
  // next to it are the seeds, each with its sub-pixel distance to it (coverage offset / slope)
  const n = w * h, c = blurAlpha(alpha, w, h, 1.7), f = new Float64Array(n), seed = new Float64Array(n), edge = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = c[i] / 255;
    f[i] = 1e20;
    if (Math.abs(v - 0.5) > 0.35) continue;
    const gx = (c[x < w - 1 ? i + 1 : i] - c[x > 0 ? i - 1 : i]) / 510, gy = (c[y < h - 1 ? i + w : i] - c[y > 0 ? i - w : i]) / 510;
    const d = (v - 0.5) / Math.max(0.05, Math.hypot(gx, gy));
    if (Math.abs(d) <= 2) { edge[i] = 1; f[i] = d * d; seed[i] = d; }
  }
  edt(f, w, h);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sd = edge[i] ? seed[i] : (c[i] >= 127.5 ? 1 : -1) * Math.sqrt(f[i]);   // signed distance, + inside
    r[i] = 255 * Math.min(1, Math.max(0, 0.5 + sd / (2 * soft)));
  }
  return blurAlpha(r, w, h, smooth);
}
/** Smooth blur of an alpha channel: three box-blur passes each way (close to a Gaussian). */
function blurAlpha(alpha, w, h, radius) {
  let a = Float32Array.from(alpha), b = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius / 1.7)), n = 2 * r + 1;
  const line = new Float32Array(Math.max(w, h) + 2 * r + 1);   // one line, padded by repeating its ends
  const pass = (src, dst, lines, len, stride, step) => {
    for (let i = 0; i < lines; i++) {
      const base = i * stride, first = src[base], last = src[base + (len - 1) * step];
      for (let k = 0; k < r; k++) line[k] = first;
      for (let j = 0; j < len; j++) line[r + j] = src[base + j * step];
      for (let k = 0; k <= r; k++) line[r + len + k] = last;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += line[k];
      for (let j = 0; j < len; j++) { dst[base + j * step] = acc / n; acc += line[j + n] - line[j]; }
    }
  };
  for (let k = 0; k < 3; k++) { pass(a, b, h, w, w, 1); pass(b, a, w, h, 1, w); }
  return a;
}

/**
 * Blur only the box [x0, x1) × [y0, y1) of the image (everything outside it is zero and stays zero).
 * Gives exactly the full-image result when the box's margin around the non-zero data is wider than the
 * blur reaches, and the box starts on a multiple of k.
 */
function blurIn(alpha, w, h, radius, k, x0, y0, x1, y1) {
  const bw = x1 - x0, bh = y1 - y0, sub = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) sub.set(alpha.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * bw);
  const b = blurAt(sub, bw, bh, radius, k), out = new Float32Array(w * h);
  for (let y = 0; y < bh; y++) out.set(b.subarray(y * bw, (y + 1) * bw), (y + y0) * w + x0);
  return out;
}
/** blurAlpha at 1/k resolution (box-averaged down, bilinear back up): wide blurs don't need every pixel. */
function blurAt(alpha, w, h, radius, k) {
  if (k <= 1) return blurAlpha(alpha, w, h, radius);
  const sw = Math.ceil(w / k), sh = Math.ceil(h / k), small = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) { const row = ((y / k) | 0) * sw; for (let x = 0; x < w; x++) small[row + ((x / k) | 0)] += alpha[y * w + x]; }
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] /= Math.min(k, w - x * k) * Math.min(k, h - y * k);
  const b = blurAlpha(small, sw, sh, radius / k), out = new Float32Array(w * h);
  const ix0 = new Int32Array(w), ix1 = new Int32Array(w), itx = new Float32Array(w);
  for (let x = 0; x < w; x++) { const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5)); ix0[x] = Math.floor(fx); ix1[x] = Math.min(sw - 1, ix0[x] + 1); itx[x] = fx - ix0[x]; }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5)), y0 = Math.floor(fy), ty = fy - y0;
    const r0 = y0 * sw, r1 = Math.min(sh - 1, y0 + 1) * sw, o = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = ix0[x], x1 = ix1[x], tx = itx[x];
      out[o + x] = (b[r0 + x0] * (1 - tx) + b[r0 + x1] * tx) * (1 - ty) + (b[r1 + x0] * (1 - tx) + b[r1 + x1] * tx) * ty;
    }
  }
  return out;
}
/**
 * The map of the cloud a shape is made from (port of SkyRenderer.sourceCells; keep the two identical): its
 * cells (`label` === `comp`), grown up to 4 cells into where any cloud reaches later on (`later` > 8) but not
 * into other clouds, then softened (3×3), and fading out from 0.05 to 0.3 cloud units away from the shape's
 * box (centre cx, cy and half size bw, bh, in cells), so of a big cloud only the part near the shape gives way.
 * 0..255 per cell, same layout as the maps.
 */
function sourceCells(label, comp, later, gw, gh, cx, cy, bw, bh, step) {
  const n = gw * gh, depth = new Int8Array(n).fill(-1);
  let front = [];
  for (let i = 0; i < n; i++) if (label[i] === comp) { depth[i] = 0; front.push(i); }
  for (let d = 1; d <= 4 && front.length; d++) {
    const next = [];
    for (const i of front) {
      const x = i % gw, y = (i - x) / gw;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (depth[j] < 0 && later[j] > 8 && label[j] < 0) { depth[j] = d; next.push(j); }
      }
    }
    front = next;
  }
  const out = new Uint8Array(n);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = Math.min(gw - 1, Math.max(0, x + dx)), sy = Math.min(gh - 1, Math.max(0, y + dy));
      if (depth[sy * gw + sx] >= 0) k++;
    }
    const d = Math.hypot(Math.max(Math.abs(x + 0.5 - cx) - bw, 0), Math.max(Math.abs(y + 0.5 - cy) - bh, 0)) * step;
    out[y * gw + x] = Math.round(255 * k / 9 * (1 - smooth01((d - 0.05) / 0.25)));
  }
  return out;
}
/**
 * The cloud a shape is placed on (port of SkyRenderer.findCloud in Swift; keep the two identical): of the
 * clouds in the map (opacity 0..255 per cell, rows bottom-up, cell (0, 0) starting at (ox, oy)), the one
 * nearest to (wx, wy) whose size is closest to `need` and that best fills a box the shape's size (half width,
 * half height `box`) with no other cloud in or right next to it, somewhere inside `allowed` (x0, y0, x1, y1:
 * where the shape's centre can be so it stays in view). `same`: strongly prefer the cloud at (wx, wy) (a
 * queued shape reuses the last one's cloud). Returns that spot, the cloud's id `comp` and the cells' ids
 * `label` (or null when there is no cloud).
 */
function findCloud(grid, gw, gh, ox, oy, step, wx, wy, need, allowed, box, same = false) {
  const n = gw * gh, W = gw + 1, label = new Int32Array(n).fill(-1), sat = new Int32Array(W * (gh + 1)), all = new Int32Array(W * (gh + 1));
  const bw = Math.max(1, Math.round(box[0] / step)), bh = Math.max(1, Math.round(box[1] / step));
  const sum = (t, xa, ya, xb, yb) => { xa = Math.max(0, xa); ya = Math.max(0, ya); xb = Math.min(gw, xb); yb = Math.min(gh, yb);
    return t[yb * W + xb] - t[ya * W + xb] - t[yb * W + xa] + t[ya * W + xa]; };
  for (let y = 0; y < gh; y++) { let row = 0; for (let x = 0; x < gw; x++) { if (grid[y * gw + x] > 8) row++; all[(y + 1) * W + x + 1] = all[y * W + x + 1] + row; } }
  let best = null, comp = 0;
  for (let start = 0; start < n; start++) {
    if (grid[start] <= 8 || label[start] >= 0) continue;
    const stack = [start], mine = []; label[start] = comp;
    let border = false, atWant = false;
    const qx = (wx - ox) / step, qy = (wy - oy) / step;
    while (stack.length) {
      const i = stack.pop(), x = i % gw, y = (i - x) / gw;
      mine.push(i);
      if (x === 0 || x === gw - 1) border = true;
      if (Math.abs(x + 0.5 - qx) <= 2.5 && Math.abs(y + 0.5 - qy) <= 2.5) atWant = true;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (grid[j] > 8 && label[j] < 0) { label[j] = comp; stack.push(j); }
      }
    }
    const area = mine.length * step * step, id = comp++;
    if (area < 0.05 * need) continue;                                  // a speck
    // where on this cloud the shape sits: the spot (on the cloud, in view) with the most of it under the box
    // and the least of other clouds in or right next to it (they would merge with the shape)
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) { if (label[y * gw + x] === id) row++; sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row; }
    }
    let spot = null;
    for (const i of mine) {
      const x = i % gw, y = (i - x) / gw;
      const fill = sum(sat, x - bw, y - bh, x + bw + 1, y + bh + 1) / ((2 * bw + 1) * (2 * bh + 1));
      const other = (sum(all, x - bw - 3, y - bh - 3, x + bw + 4, y + bh + 4) - sum(sat, x - bw - 3, y - bh - 3, x + bw + 4, y + bh + 4)) / ((2 * bw + 7) * (2 * bh + 7));
      const px = ox + (x + 0.5) * step, py = oy + (y + 0.5) * step;
      const out = Math.hypot(Math.max(allowed[0] - px, 0, px - allowed[2]), Math.max(allowed[1] - py, 0, py - allowed[3]));
      const s = Math.max(0, fill - 1.5 * other) * Math.exp(-out / 0.1);
      if (!spot || s > spot.s) spot = { s, x: px, y: py };
    }
    const score = Math.exp(-Math.hypot(spot.x - wx, spot.y - wy) / 0.35) * Math.exp(-0.6 * Math.abs(Math.log(area / need)))
                * (0.05 + spot.s) * (border ? 0.5 : 1) * (same && atWant ? 4 : 1);
    if (!best || score > best.score) best = { score, x: spot.x, y: spot.y, comp: id };
  }
  return best ? { ...best, label } : null;
}
/**
 * Built-in symbols for showShape({ symbol }) (port: SkySymbol.swift; keep the two identical). Each is a box
 * (x, y, width, height in its own units, about 100 tall) and parts: [kind, 'path', d] (absolute M L H V C Q Z only),
 * [kind, 'circle', cx, cy, r] or [kind, 'ellipse', cx, cy, rx, ry, degrees], kind 'fill' or 'line' (14 wide, round).
 * The heart is filled and becomes a solid cloud; the others are bold strokes that form like letters.
 */
export const SKY_SYMBOLS = {
  heart: { box: [0, 0, 100, 96], parts: [['fill', 'path', 'M50 94C30 78 3 60 3 34 3 16 16 4 31 4 42 4 49 14 50 30 51 14 58 4 69 4 84 4 97 16 97 34 97 60 70 78 50 94Z']] },
  star: { box: [-4, -2, 108, 104], parts: [['line', 'path', 'M50 7L62.3 36L94 38.2L70 59.5L78.2 90L50 73L21.8 90L30 59.5L6 38.2L37.7 36Z']] },
  sun: { box: [-4, -4, 108, 108], parts: [['line', 'circle', 50, 50, 18], ['line', 'path', 'M50 6V16M50 84V94M6 50H16M84 50H94M18.9 18.9L26 26M74 74L81.1 81.1M18.9 81.1L26 74M74 26L81.1 18.9']] },
  moon: { box: [-4, -4, 108, 108], parts: [['line', 'path', 'M46.1 8C25.5 8 7.9 22.8 4.6 43.1C1.2 63.4 13.1 83.2 32.6 89.8C52.1 96.4 73.5 87.9 83.1 69.7C66.2 78.8 45 73 35.1 56.5C25.2 40 30.1 18.6 46.1 8Z']] },
  smile: { box: [-4, -4, 108, 108], parts: [['line', 'circle', 50, 50, 42], ['fill', 'circle', 35, 40, 8], ['fill', 'circle', 65, 40, 8], ['line', 'path', 'M30 60Q50 80 70 60']] },
  music: { box: [-4, -4, 108, 108], parts: [['fill', 'ellipse', 24, 78, 16, 12, -20], ['fill', 'ellipse', 74, 70, 16, 12, -20], ['line', 'path', 'M36 76V22L86 10V68']] },
  bolt: { box: [-4, -4, 108, 108], parts: [['line', 'path', 'M58 6L20 56H48L40 94L80 42H52L58 6Z']] },
  infinity: { box: [-4, -4, 108, 108], parts: [['line', 'path', 'M50 50C40 36 32 30 22 30C11 30 2 39 2 50C2 61 11 70 22 70C32 70 40 64 50 50C60 36 68 30 78 30C89 30 98 39 98 50C98 61 89 70 78 70C68 70 60 64 50 50Z']] },
};
/** A built-in symbol as SVG markup (for buttons: the default colour follows the text colour). */
export function skySymbolSvg(name, color = 'currentColor') {
  const s = SKY_SYMBOLS[name];
  if (!s) return '';
  const paint = k => k === 'fill' ? `fill="${color}"` : `fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"`;
  const parts = s.parts.map(([k, type, ...a]) =>
    type === 'path' ? `<path ${paint(k)} d="${a[0]}"/>`
    : type === 'circle' ? `<circle ${paint(k)} cx="${a[0]}" cy="${a[1]}" r="${a[2]}"/>`
    : `<ellipse ${paint(k)} cx="${a[0]}" cy="${a[1]}" rx="${a[2]}" ry="${a[3]}" transform="rotate(${a[4]} ${a[0]} ${a[1]})"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.box.join(' ')}">${parts}</svg>`;
}
/** Drop keys whose value is undefined, so `{ speed: undefined }` means "default", not "broken". */
export function cleanOptions(o = {}) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function createSky(container, options = {}) {
  const S = { ...SKY_DEFAULTS, ...cleanOptions(options) };
  const canvas = document.createElement('canvas');
  // z-index -1 inside an isolated container: the sky sits behind any content placed in the container
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:-1';
  canvas.setAttribute('aria-hidden', 'true');
  const savedStyle = { position: container.style.position, isolation: container.style.isolation };
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.style.isolation = 'isolate';
  container.insertBefore(canvas, container.firstChild);

  let gl = null, cloudProg = null, compProg = null, emptyTex = null, shapeTex = null;
  let prevTex = null;             // the previous shape's mask while it turns straight into the current one
  let layers = [];
  let unit = 1, viewH = 1, cacheW = 0, cacheH = 0, winW = 0;
  let simTime = 0, last = 0, lastDraw = 0, raf = 0;
  let needsSetup = true, needsRebuild = false, needsDraw = true;
  let userPaused = false, inView = true, destroyed = false, lost = false;
  let framesDrawn = 0, lostCount = 0, lastGlError = 0;
  const planes = [];              // { x, y, dx, dy, age }
  let nextPlane = 8;
  let shape = null;               // the shape on screen (placeShape)
  let shapeTicket = 0;            // bumped by each showShape/clearShape, so a slower build can't overwrite a newer one
  let shapeQueue = [];            // shapes waiting for the current one to melt (showShape with queue: true), in call order; img: null while it builds
  let leadBuilding = 0;           // non-queued showShape calls still building their image (the queue waits for them)
  let lastCloud = null;           // where the last shape's cloud was (the next queued shape forms on it)
  let lastEnd = 0;                // when it finished melting (a queued shape's pause counts from there)
  let markReady;
  const ready = new Promise(r => { markReady = r; });   // the first frame has set the sky up
  const reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const dir = () => (S.direction === 'right' ? -1 : 1);
  const effectiveSpeed = () => (S.respectReducedMotion && reduceMotion?.matches ? 0 : S.speed);
  const colors = () => {
    const p = PALETTES[S.palette] || PALETTES.summer;
    return [S.skyTop || p.skyTop, S.skyMid || p.skyMid, S.skyLow || p.skyLow].map(hex);
  };

  // ---------- GL resources ----------
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('sky-kit shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('sky-kit program: ' + gl.getProgramInfoLog(p));
    const u = new Proxy({}, { get: (c, n) => (n in c ? c[n] : (c[n] = gl.getUniformLocation(p, n))) });
    return { p, u };
  }
  function texParams() {
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  function initGL() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('sky-kit needs WebGL2');
    cloudProg = program(CLOUD_FS); compProg = program(COMPOSITE_FS);
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    emptyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); texParams();
    shapeTex = null; prevTex = null;
    if (shape) { uploadShape(shape.image); shape.patch = null; shape.patchReady = false; shape.src = null; shape.prev = null; shape.area = shape.rect; }   // old GPU objects are gone
    layers = LAYERS.map(L => ({ ...L, snaps: null }));
    needsSetup = true;
  }
  function makeSnap(L) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cacheW, cacheH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, time: 0, x0: 0, strip: L.strips };
  }
  const freeSnap = s => { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); };
  const layerSeed = L => [L.seed[0] + S.seed * 7.31, L.seed[1] + S.seed * 3.17];
  function place(L, snap, time) { snap.time = time; snap.x0 = dir() * L.speed * time - MARGIN; }
  function setSkyUniforms(u) {
    const [t, m, l] = colors();
    gl.uniform3fv(u.uSkyTop, t); gl.uniform3fv(u.uSkyMid, m); gl.uniform3fv(u.uSkyLow, l);
    gl.uniform1f(u.uGradient, Math.min(1, Math.max(0, +S.gradient || 0)));
  }
  const ease = x => { x = Math.min(1, Math.max(0, x)); return 0.5 * x + 0.5 * smooth01(x); };   // gentle ends, no dead start
  // forming progress (stays 1 while holding and melting) and melting progress
  // (a released shape keeps the forming it had reached and melts from there, over relDur)
  function shapeAmt(t) {
    if (!shape || t <= shape.t0) return 0;
    return shape.relAt != null && t >= shape.relAt ? shape.relAmt : ease((t - shape.t0) / shape.form);
  }
  function shapeMelt(t) {
    if (!shape) return 0;
    if (shape.relAt != null && t >= shape.relAt) return ease((t - shape.relAt) / shape.relDur);
    return ease((t - shape.t0 - shape.form - shape.hold) / shape.fade);
  }
  const shapeEnd = s => s.relAt != null ? s.relAt + s.relDur : s.t0 + s.form + s.hold + s.fade;
  // paint clouds into a framebuffer: a layer snapshot, or (amt > 0) the live patch over a shape
  function drawClouds(L, fb, w, h, x0, y0, time, amt, scissor, melt = 0, upp = viewH / cacheH) {
    const u = cloudProg.u;
    gl.useProgram(cloudProg.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    if (scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...scissor); }
    gl.uniform2f(u.uWin0, x0, y0); gl.uniform1f(u.uUpp, upp); gl.uniform1f(u.uViewH, viewH);
    gl.uniform1f(u.uMorph, time * L.morph); gl.uniform1f(u.uScale, L.scale);
    gl.uniform1f(u.uCov, S.coverage); gl.uniform1f(u.uShadow, S.shadow);
    gl.uniform1f(u.uHaze, L.haze); gl.uniform1f(u.uFarMask, L.farMask); gl.uniform2fv(u.uSeed, layerSeed(L));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, amt > 0 ? shapeTex : emptyTex); gl.uniform1i(u.uShape, 0);
    gl.uniform1f(u.uShapeAmt, amt); gl.uniform1f(u.uShapeMelt, melt); gl.uniform1f(u.uShapeThick, shape ? shape.thick : 0);
    gl.uniform4fv(u.uShapeRect, shape ? shape.rect : [0, 0, 1, 1]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, amt > 0 && shape?.src ? shape.src.tex : emptyTex); gl.uniform1i(u.uSrc, 1);
    gl.uniform4fv(u.uSrcRect, shape?.src ? shape.src.rect : [0, 0, 1, 1]);
    gl.uniform1f(u.uShapeDensity, shape ? shape.density : 0.5);
    const prev = amt > 0 && amt < 1 && shape?.prev && prevTex ? shape.prev : null;   // (once formed, only the new mask counts)
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prev ? prevTex : emptyTex); gl.uniform1i(u.uPrev, 2);
    gl.uniform4fv(u.uPrevRect, prev ? prev.rect : [0, 0, 1, 1]);
    gl.uniform2f(u.uPrev2, prev ? 1 : 0, prev ? prev.thick : 0);
    setSkyUniforms(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function paint(L, snap, strip) {
    const scissor = strip >= 0
      ? [Math.floor(cacheW * strip / L.strips), 0, Math.floor(cacheW * (strip + 1) / L.strips) - Math.floor(cacheW * strip / L.strips), cacheH]
      : null;
    drawClouds(L, snap.fb, cacheW, cacheH, snap.x0, 0, snap.time, 0, scissor);
  }
  // While a shape is on screen, the near clouds over its area are rendered live (same resolution as the
  // snapshots), with the shape folded into the cloud density. The patch is placed with the clouds every
  // frame and changes slowly, so it is repainted at most 30 times per second of sky time.
  function paintPatch() {
    const amt = shapeAmt(simTime), melt = shapeMelt(simTime);
    if (amt <= 0 || melt >= 1 || !shapeTex || !layers[1]) { shape.patchReady = false; return; }
    if (shape.patchReady && simTime - shape.patch.time < 1 / 30 - 1e-9) return;
    shape.patchReady = false;
    const upp = viewH / cacheH, r = shape.area, fade = shape.fade_;
    // only the part of the shape's area that is on screen (plus the blend border, which stays off screen)
    const scroll = dir() * layers[1].speed * simTime, vw = canvas.width / unit;
    const x0 = Math.max(r[0], scroll - fade), x1 = Math.min(r[0] + r[2], scroll + vw + fade);
    const y0 = Math.max(r[1], -fade), y1 = Math.min(r[1] + r[3], viewH + fade);
    if (x1 <= x0 || y1 <= y0) return;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const w = Math.max(1, Math.min(max, Math.ceil((x1 - x0) / upp))), h = Math.max(1, Math.min(max, Math.ceil((y1 - y0) / upp)));
    // one texture big enough for the largest clip, so a shape sliding off screen doesn't reallocate every frame
    const tw = Math.max(1, Math.min(max, Math.ceil(Math.min(r[2], vw + 2 * fade) / upp) + 2));
    const th = Math.max(1, Math.min(max, Math.ceil(Math.min(r[3], viewH + 2 * fade) / upp) + 2));
    let P = shape.patch;
    if (!P || P.w < Math.max(w, tw) || P.h < Math.max(h, th)) {
      if (P) { gl.deleteTexture(P.tex); gl.deleteFramebuffer(P.fb); }
      const W = Math.max(w, tw), H = Math.max(h, th);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      P = shape.patch = { tex, fb, w: W, h: H };
    }
    drawClouds(layers[1], P.fb, w, h, x0, y0, simTime, amt, null, melt);
    P.rect = [x0, y0, w * upp, h * upp];   // cloud-space rect of what was drawn
    P.uv = [w / P.w, h / P.h];             // the part of the texture it fills
    P.time = simTime;
    shape.patchReady = true;
  }
  function freeShape() {
    if (shape?.patch && gl) { gl.deleteTexture(shape.patch.tex); gl.deleteFramebuffer(shape.patch.fb); }
    if (shape?.src && gl) gl.deleteTexture(shape.src.tex);
    shape = null;
  }
  function rebuildAll() {
    if (shape) shape.patchReady = false;
    for (const L of layers) {
      const t0 = L.snaps[0].time;
      L.snaps.forEach((s, k) => { place(L, s, t0 + k * L.dt); paint(L, s, -1); s.strip = L.strips; });
    }
  }
  function setupCaches() {
    const dpr = window.devicePixelRatio || 1;
    const q = Math.min(1, Math.max(0.35, (QUALITY[S.quality] || QUALITY.high) / dpr));
    unit = cloudUnit(canvas.width, canvas.height, S.cloudScale);
    viewH = canvas.height / unit;
    cacheH = Math.max(1, Math.round(canvas.height * q));
    const upp = viewH / cacheH;
    cacheW = Math.ceil((canvas.width / unit + 2 * MARGIN) / upp);
    winW = cacheW * upp;
    for (const L of layers) {
      const t0 = L.snaps ? L.snaps[0].time : simTime;
      if (L.snaps) L.snaps.forEach(freeSnap);
      L.snaps = [makeSnap(L), makeSnap(L), makeSnap(L)];
      L.snaps.forEach((s, k) => place(L, s, t0 + k * L.dt));
    }
    rebuildAll();
  }
  function advance(L) {
    while (simTime >= L.snaps[1].time) {
      const [A, B, C] = L.snaps;
      while (C.strip < L.strips) paint(L, C, C.strip++);
      place(L, A, C.time + L.dt); A.strip = 0;
      L.snaps = [B, C, A];
    }
    const C = L.snaps[2];
    if (C.strip < L.strips) paint(L, C, C.strip++);
  }

  // ---------- planes ----------
  function launchPlane(x, y, dx, dy) {
    const l = Math.hypot(dx, dy) || 1;
    if (planes.length >= 2) planes.shift();
    planes.push({ x, y, dx: dx / l, dy: dy / l, age: 0 });
  }
  function randomPlane() {
    const vw = canvas.width / unit;
    const fromLeft = Math.random() < 0.5, y = viewH * (0.5 + Math.random() * 0.4), ang = (Math.random() - 0.5) * 0.35;
    const dx = Math.cos(ang) * (fromLeft ? 1 : -1), dy = Math.sin(ang);
    launchPlane(fromLeft ? -0.05 : vw + 0.05, y, dx, dy);
  }
  function updatePlanes(dt) {
    const vw = canvas.width / unit;
    for (const pl of planes) pl.age += dt;
    while (planes.length && planes[0].age > (vw + 0.6) / PLANE_SPEED + S.trailLife * 3) planes.shift();
    if (S.planes) { nextPlane -= dt; if (nextPlane <= 0) { randomPlane(); nextPlane = 25 + Math.random() * 35; } }
  }

  // ---------- shapes ----------
  function uploadShape(img) {
    if (!gl) return;
    if (!shapeTex) shapeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shapeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);   // rows already bottom-up
    texParams();
  }
  // The mask is built at 100 px per silhouette height (it is soft anyway; the blur radii below are for
  // 220 px, scaled); it yields between steps so the sky keeps animating meanwhile.
  const MASK_PX = 100, MS = MASK_PX / 220;
  // a message, not a timer: background tabs hold timers back (up to a minute), and timers have a 4 ms minimum
  const breathe = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  async function buildShapeImage(src) {
    const sil = silhouette(src, MASK_PX);
    const pad = Math.round(sil.height * 2.2);       // room for the wide area (A)
    const w = sil.width + pad * 2, h = sil.height + pad * 2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(sil, pad, pad);
    const px = cx.getImageData(0, 0, w, h).data, alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3];
    await breathe();
    // the narrower blurs reach at most ~0.6 silhouette heights: blur only that box (same result, much less work)
    const m4 = v => Math.max(0, Math.floor(v / 4) * 4), bm = Math.round(sil.height * 0.75);
    const bx0 = m4(pad - bm), by0 = m4(pad - bm), bx1 = Math.min(w, pad + sil.width + bm), by1 = Math.min(h, pad + sil.height + bm);
    const body = blurIn(alpha, w, h, 70 * MS, 2, bx0, by0, bx1, by1);                                       // the shape's domed body
    // 0 = thin strokes (text) … 1 = a solid shape (a heart, an emoji): solid shapes get softer edges
    let bodyMax = 0; for (let i = 0; i < w * h; i++) bodyMax = Math.max(bodyMax, body[i]);
    const thick = Math.min(1, Math.max(0, (bodyMax / 255 - 0.6) / 0.3));
    await breathe();
    // the shape itself, from the distance to its edge (only the box can be near it)
    const bw = bx1 - bx0, bh = by1 - by0, sub = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) sub.set(alpha.subarray((y + by0) * w + bx0, (y + by0) * w + bx1), y * bw);
    const edge = edgeChannel(sub, bw, bh, (5.6 + 2.5 * thick) * MASK_PX / 100, 4 * MASK_PX / 100), near = new Float32Array(w * h);
    for (let y = 0; y < bh; y++) near.set(edge.subarray(y * bw, (y + 1) * bw), (y + by0) * w + bx0);
    await breathe();
    const wide = blurIn(alpha, w, h, 44 * MS, 2, bx0, by0, bx1, by1);
    // the wide area (A): a very wide blur, flattened (square root) so it reaches well out, ~1 at the shape, and faded to exactly 0
    // over the outer part of the margin (it times a morph, which must not change at the mask's edge)
    await breathe();
    const far = blurAt(alpha, w, h, sil.height * 1.2, 4);
    let farMax = 0; for (let i = 0; i < w * h; i++) farMax = Math.max(farMax, far[i]);
    await breathe();
    const win = d => smooth01((d - 0.17 * pad) / (0.28 * pad));   // all-zero over the outer 17% (wider than the patch's blend)
    const winX = new Float32Array(w); for (let x = 0; x < w; x++) winX[x] = win(Math.min(x, w - 1 - x));
    const farK = 1 / Math.max(1e-3, farMax);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {                 // write rows bottom-up (GL texture order)
      const wy = win(Math.min(y, h - 1 - y)), sy = h - 1 - y, row = sy * w, inBox = sy >= by0 && sy < by1;
      for (let x = 0; x < w; x++) {
        const s = row + x, d = (y * w + x) * 4;
        if (inBox && x >= bx0 && x < bx1) {       // the narrower blurs are zero outside their box
          data[d] = Math.min(255, near[s]);
          data[d + 1] = Math.min(255, wide[s] * 1.4);
          data[d + 2] = Math.min(255, body[s]);
        }
        data[d + 3] = Math.round(255 * Math.min(1, 1.2 * Math.sqrt(far[s] * farK)) * wy * winX[x]);
      }
    }
    let area = 0; for (let i = 0; i < w * h; i++) area += alpha[i];
    return { width: w, height: h, data, silH: sil.height, silW: sil.width, pad, thick, area: area / 255 };   // area in mask pixels
  }
  // o._from: turn straight from that shape (same cloud, same spot); o._near: form on the cloud there (the previous
  // shape's); o._t0: start forming then (a queued shape's pause); o._asap: (taking over) turn from the current shape
  // as soon as it has formed, not after its hold
  function placeShape(img, o) {
    const N = layers[1], from = o._from || null;
    const t0 = from ? simTime - 1e-3 : Math.max(simTime + 0.2, o._t0 ?? 0);   // (a morph is on screen from its first frame)
    const vw = canvas.width / unit;
    const form = o.form ?? 5, hold = o.hold ?? 5, fade = o.fade ?? 7;
    // size is a fraction of the view height, shrunk if needed so the shape fits 70% of the view width
    const silH = Math.min((o.size ?? 0.32) * viewH, 0.7 * vw * img.silH / img.silW);
    const hUnits = silH * (img.height / img.silH);
    const wUnits = hUnits * img.width / img.height;
    // the shape drifts with the clouds: place it so it is at (x, y) halfway through its hold
    const holdP = Math.min(hold, 10);   // (hold: Infinity holds until releaseShape; place it as if it held 10 s)
    const tMid = t0 + form + holdP / 2, scroll = dir() * N.speed * tMid;
    let cx = (o.x ?? 0.5) * vw + scroll, cy = (o.y ?? 0.6) * viewH;
    // put it on a real cloud near there: that cloud turns into the shape, and back into itself
    const k = hUnits / img.height, hw = img.silW * k / 2, hh = silH / 2;
    const tEnd = t0 + form + holdP + fade, s0 = dir() * N.speed * t0, s1 = dir() * N.speed * tEnd;
    const fits = 2 * hw + 0.06 < vw;
    const allowed = [fits ? scroll + hw + 0.03 : scroll + vw / 2, hh + 0.03, fits ? scroll + vw - hw - 0.03 : scroll + vw / 2, viewH - hh - 0.03];
    const found = from ? null : cloudNear(o._near ? o._near[0] : cx, o._near ? o._near[1] : cy, img.area * k * k, [t0, tMid, tEnd],
                                          Math.min(s0, s1) - 0.3, Math.max(s0, s1) + vw + 0.3, allowed, [hw, hh], !!o._near);
    if (from) { cx = from.rect[0] + from.rect[2] / 2; cy = from.rect[1] + from.rect[3] / 2; }   // right where the previous shape is
    else if (found) { cx = found.x; cy = found.y; }
    if (from || found) {
      cx = Math.min(Math.max(cx, allowed[0]), allowed[2]);
      cy = Math.min(Math.max(cy, allowed[1]), allowed[3]);
    }
    const rect = [cx - wUnits / 2, cy - hUnits / 2, wUnits, hUnits];
    let src = found ? found.src : null, cloudAt = found ? [found.x, found.y] : [cx, cy], prev = null, area = rect, blend = 0.15 * img.pad * hUnits / img.height;
    if (from) {
      // the previous shape's cloud and mask carry over: its outline turns into this one's
      src = from.src; from.src = null; cloudAt = from.cloudAt;
      prev = { rect: from.rect, thick: from.thick };
      [prevTex, shapeTex] = [shapeTex, prevTex];
      const r = from.rect;
      area = [Math.min(r[0], rect[0]), Math.min(r[1], rect[1]), 0, 0];
      area[2] = Math.max(r[0] + r[2], rect[0] + rect[2]) - area[0]; area[3] = Math.max(r[1] + r[3], rect[1] + rect[3]) - area[1];
      blend = Math.min(blend, from.fade_);
    }
    freeShape();
    shape = { image: img, rect, area, t0, form, hold, fade, patch: null, patchReady: false, label: o.text ?? o.symbol ?? 'image', relAt: null,
              thick: img.thick, fade_: blend,   // blend border: inside the masks' all-zero margins
              density: Math.min(1, Math.max(0, o.density ?? 0.5)), src, cloudAt, prev };
    uploadShape(img);
    redraw();
  }
  // the cloud to put a shape on (findCloud), from a map of the near clouds over x0..x1 (all that is on screen
  // while the shape lives) at the moment it starts forming, times[0]; plus a map of that cloud, grown a little
  // into where it reaches later on (times), so only that cloud gives way
  function cloudNear(x, y, need, times, x0, x1, allowed, box, same) {
    const step = 0.02, y0 = -0.02;
    const gw = Math.min(400, Math.ceil((x1 - x0) / step)), gh = Math.ceil((viewH + 0.04) / step);
    if (gh <= 4 || !layers[1]) return null;
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const grid = new Uint8Array(gw * gh), later = new Uint8Array(gw * gh), px = new Uint8Array(gw * gh * 4);
    times.forEach((t, n) => {
      drawClouds(layers[1], fb, gw, gh, x0, y0, t, 0, null, 0, step);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, px);   // rows bottom-up
      for (let i = 0; i < gw * gh; i++) { if (n === 0) grid[i] = px[i * 4 + 3]; later[i] = Math.max(later[i], px[i * 4 + 3]); }
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
    const best = findCloud(grid, gw, gh, x0, y0, step, x, y, need, allowed, box, same);
    if (!best) return null;
    // where the shape will sit (placeShape clamps it the same way)
    const cx = Math.min(Math.max(best.x, allowed[0]), allowed[2]), cy = Math.min(Math.max(best.y, allowed[1]), allowed[3]);
    const mine = sourceCells(best.label, best.comp, later, gw, gh, (cx - x0) / step, (cy - y0) / step, box[0] / step, box[1] / step, step);
    const mask = new Uint8Array(gw * gh * 4);
    for (let i = 0; i < gw * gh; i++) mask[i * 4] = mine[i];
    const src = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask); texParams();
    return { x: cx, y: cy, src: { tex: src, rect: [x0, y0, gw * step, gh * step] } };
  }
  function shapeUniforms(u) {
    const on = !!(shape && shape.patchReady);
    gl.uniform1f(u.uPatchOn, on ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, on ? shape.patch.tex : emptyTex); gl.uniform1i(u.uPatch, 4);
    if (on) {
      const r = shape.patch.rect, scroll = dir() * layers[1].speed * simTime;   // view-relative, subtracted in double precision
      gl.uniform4f(u.uShapeView, r[0] - scroll, r[1], r[2], r[3]); gl.uniform2fv(u.uPatchUV, shape.patch.uv);
      gl.uniform1f(u.uPatchFade, shape.fade_);   // inside the mask's empty margin, where patch and snapshot agree
    }
  }

  // ---------- frame loop ----------
  const running = () => !destroyed && !lost && !userPaused && inView && !document.hidden;
  function frame(now) {
    raf = 0;
    if (destroyed || lost) return;
    const moving = running() && effectiveSpeed() > 0;
    if (moving && now - lastDraw < 1000 / S.fps - 1 && !needsDraw) { schedule(); return; }
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    if (container.clientWidth < 1 || container.clientHeight < 1) return;    // not laid out yet
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(container.clientWidth * dpr), h = Math.round(container.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; needsSetup = true; }
    if (needsSetup) { setupCaches(); needsSetup = false; needsRebuild = false; markReady(); }
    if (needsRebuild) { rebuildAll(); needsRebuild = false; }
    if (moving) { const sdt = dt * effectiveSpeed(); simTime += sdt; updatePlanes(sdt); }
    for (const L of layers) advance(L);
    tendShape();
    composite();
    framesDrawn++;
    if (framesDrawn <= 3) { const e = gl.getError(); if (e) lastGlError = e; }   // cheap check on the first frames only
    lastDraw = now; needsDraw = false;
    if (moving) schedule();
  }
  function composite() {
    const u = compProg.u;
    gl.useProgram(compProg.p);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uUnit, unit); gl.uniform1f(u.uViewH, viewH);
    setSkyUniforms(u);
    const bind = (unitNo, name, tex) => { gl.activeTexture(gl.TEXTURE0 + unitNo); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unitNo); };
    const [F, N] = layers;
    bind(0, 'uFarA', F.snaps[0].tex); bind(1, 'uFarB', F.snaps[1].tex);
    bind(2, 'uNearA', N.snaps[0].tex); bind(3, 'uNearB', N.snaps[1].tex);
    // offsets of the view inside each snapshot, subtracted here in double precision (stays exact on long runs)
    const win = L => {
      const scroll = dir() * L.speed * simTime;
      return [scroll - L.snaps[0].x0, scroll - L.snaps[1].x0, winW, Math.min(1, Math.max(0, (simTime - L.snaps[0].time) / L.dt))];
    };
    gl.uniform4fv(u.uFar, win(F)); gl.uniform4fv(u.uNear, win(N));
    const pv = new Float32Array(8), pa = [-1, -1];
    planes.forEach((pl, i) => { pv.set([pl.x, pl.y, pl.dx, pl.dy], i * 4); pa[i] = pl.age; });
    gl.uniform4fv(u.uPlane, pv); gl.uniform2fv(u.uPlaneAge, pa);
    gl.uniform1f(u.uPlaneSpeed, PLANE_SPEED); gl.uniform1f(u.uTrailLife, S.trailLife);
    gl.uniform1f(u.uTrailDrift, -dir() * F.speed);
    shapeUniforms(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // render the shape's live patch for this frame, and drop the shape once it has melted
  function tendShape(repaint = true) {
    if (!shape) return;
    const holdEnd = shape.t0 + shape.form + shape.hold, meltEnd = shapeEnd(shape);
    const next = shapeQueue[0];
    // a shape that has drifted off screen with the clouds is done (nobody sees its cloud come back)
    const r = shape.area, scroll = dir() * layers[1].speed * simTime, vw = canvas.width / unit;
    const gone = simTime > shape.t0 && (dir() > 0 ? r[0] + r[2] < scroll - 0.05 : r[0] > scroll + vw + 0.05);
    const canMorph = next?.img && next.o.pause <= 0 && !leadBuilding && shape.relAt == null;
    if (canMorph && ((simTime > holdEnd && shapeMelt(simTime) < 0.15) || (next.o._asap && shapeAmt(simTime) >= 1 && shapeMelt(simTime) <= 0))) {
      // pause 0: the next shape takes over right away and this one's outline turns straight into it
      shapeQueue.shift();
      placeShape(next.img, { ...next.o, _from: shape });
    } else if (simTime > meltEnd || gone) {
      // melted: the next waiting shape (showShape with queue) forms on the same cloud after its pause
      lastCloud = shape.cloudAt; lastEnd = Math.min(meltEnd, simTime);
      freeShape();
      placeNext();
      if (!shape) return;
    }
    if (repaint) paintPatch();
  }
  // a shape that isn't queued takes over from the one on screen without a jump: if that one is holding, it turns
  // straight into the new one now; while it is still forming, as soon as it has formed; while it is melting, the
  // new one forms right after it
  function takeOver(img, o) {
    const amt = shape ? shapeAmt(simTime) : 0, melt = shape ? shapeMelt(simTime) : 1;
    if (!shape || amt <= 0 || melt >= 1) placeShape(img, o);
    else if (amt >= 1 && melt <= 0) placeShape(img, { ...o, _from: shape });
    else { shapeQueue.unshift({ img, o: { ...o, pause: 0, _asap: amt < 1 } }); placeNext(); }
  }
  function placeNext() {
    if (shape || leadBuilding || !shapeQueue.length || !shapeQueue[0].img) return;
    const next = shapeQueue.shift();
    placeShape(next.img, { ...next.o, _near: lastCloud, _t0: lastEnd + next.o.pause });
  }
  // Some browsers hold back requestAnimationFrame for embedded (cross-origin) frames until the user
  // interacts. A timer fallback makes sure a scheduled frame still runs.
  let fallbackTimer = 0;
  function schedule() {
    if (raf || destroyed) return;
    raf = requestAnimationFrame(frame);
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => { if (raf) { cancelAnimationFrame(raf); raf = 0; frame(performance.now()); } }, 200);
  }
  function redraw(resetClock = true) { needsDraw = true; if (resetClock) last = 0; schedule(); }

  // ---------- observers ----------
  const ro = new ResizeObserver(() => redraw()); ro.observe(container);
  const io = new IntersectionObserver(es => { inView = es[es.length - 1].isIntersecting; if (inView) redraw(); });
  io.observe(container);
  const onVis = () => { if (!document.hidden) redraw(); };
  document.addEventListener('visibilitychange', onVis);
  const onMotionPref = () => redraw();
  reduceMotion?.addEventListener?.('change', onMotionPref);
  // moving the window to a screen with a different pixel density doesn't resize the container: watch for it
  let dprQuery = null;
  function onDpr() { redraw(); watchDpr(); }
  function watchDpr() {
    dprQuery?.removeEventListener('change', onDpr);
    dprQuery = window.matchMedia ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    dprQuery?.addEventListener?.('change', onDpr);
  }
  watchDpr();
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; lostCount++; if (raf) cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; initGL(); redraw(); });

  initGL();
  redraw();
  if (container.clientWidth > 0 && container.clientHeight > 0) { needsDraw = true; frame(performance.now()); }   // first frame right away

  const loadImage = url => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = url; });

  return {
    canvas,
    get options() { return { ...S }; },
    /** Diagnostics: frames drawn, context losses, GL errors seen, canvas size. */
    get info() {
      return { frames: framesDrawn, contextLost: lost, contextLosses: lostCount, glError: lastGlError,
               size: [canvas.width, canvas.height], snapshots: layers[0]?.snaps ? [cacheW, cacheH] : null };
    },
    set(o) {
      o = cleanOptions(o);
      const resetup = RESETUP_KEYS.some(k => k in o && o[k] !== S[k]);
      const rebuild = REBUILD_KEYS.some(k => k in o && o[k] !== S[k]);
      if ('direction' in o && o.direction !== S.direction) { shapeTicket++; shapeQueue = []; freeShape(); }   // a placed shape belongs to the old drift
      Object.assign(S, o);
      if (resetup) needsSetup = true;
      else if (rebuild && layers[0]?.snaps) needsRebuild = true;
      redraw();
    },
    pause() { userPaused = true; },
    play() { userPaused = false; redraw(); },
    /** Send a plane across. Positions are 0..1 of the view; default: from a random side. */
    flyPlane(o = {}) {
      if (!layers[0]?.snaps) return;
      if (o.from && o.to) {
        const vw = canvas.width / unit;
        launchPlane(o.from[0] * vw, o.from[1] * viewH, (o.to[0] - o.from[0]) * vw, (o.to[1] - o.from[1]) * viewH);
      } else randomPlane();
      redraw(false);
    },
    /**
     * A real cloud near (x, y) reshapes into a shape, holds it, then reshapes back into itself.
     * { text }, { symbol } (see SKY_SYMBOLS) or { image: HTMLImageElement | canvas | url }, plus optional x, y (0..1 of the view,
     * centre), size (0..1 of the view height), form, hold, fade (seconds; hold Infinity = until releaseShape), density (0..1, 0.5 = like the
     * clouds around). queue: true waits for the current shape and forms on the same cloud, `pause` seconds
     * (default 1) after it has melted (word, cloud, next word, ...); pause 0 turns the current shape's outline
     * straight into this one once it has held (word, next word, ...). Needs speed > 0.
     */
    async showShape(o) {
      let src = o.text;
      if (o.symbol) src = SKY_SYMBOLS[o.symbol] ? await loadImage('data:image/svg+xml,' + encodeURIComponent(skySymbolSvg(o.symbol, '#000'))) : null;
      if (o.image) src = typeof o.image === 'string' ? await loadImage(o.image) : o.image;
      if (!src) return;
      if (!layers[0]?.snaps) { await ready; if (!layers[0]?.snaps) return; }   // (before the first frame: wait for it)
      o = { ...o, pause: Math.max(0, o.pause ?? 1) };
      const queued = !!o.queue && (!!shape || shapeQueue.length > 0 || leadBuilding > 0);
      const slot = queued ? { img: null, o } : null;
      if (slot) shapeQueue.push(slot);                       // keeps call order while the images build
      else { shapeTicket++; shapeQueue = []; leadBuilding++; }
      const ticket = shapeTicket;                            // a newer showShape or a clearShape wins
      let img = null, error = null;
      try { img = await buildShapeImage(src); } catch (e) { error = e; } finally { if (!slot) leadBuilding--; }
      if (!img || img.area < 1) {   // couldn't be drawn, or nothing to draw (a blank text or image): the queue goes on without it
        if (slot) shapeQueue = shapeQueue.filter(s => s !== slot);
        placeNext();
        if (error) throw error;
        return;
      }
      if (ticket !== shapeTicket || destroyed || !layers[0]?.snaps) return;
      if (slot) { slot.img = img; placeNext(); } else { takeOver(img, o); placeNext(); }
    },
    clearShape() { shapeTicket++; shapeQueue = []; freeShape(); redraw(false); },
    /**
     * Melt the shape on screen back into its cloud now, from wherever it is (forming, holding, turning into the
     * next one), and drop the shapes waiting after it. Unlike clearShape, nothing jumps.
     */
    releaseShape() {
      shapeTicket++; shapeQueue = [];
      if (!shape) return;
      const amt = shapeAmt(simTime), melt = shapeMelt(simTime);
      if (amt <= 0) { freeShape(); return; }                     // hadn't started yet: nothing to see
      if (melt > 0 || shape.relAt != null) return;               // already melting
      shape.relAt = simTime; shape.relAmt = amt;
      shape.relDur = shape.fade * (shape.prev ? 1 : Math.max(0.3, amt));   // a barely formed shape goes quicker
    },
    /**
     * What the shapes are doing: phase 'none' | 'waiting' (queued, or its pause) | 'forming' | 'holding' |
     * 'melting', label (the text or symbol on screen) and next (the labels queued after it).
     */
    get shapeState() {
      const next = shapeQueue.map(s => s.o.text ?? s.o.symbol ?? 'image');
      if (!shape) return { phase: next.length || leadBuilding ? 'waiting' : 'none', label: null, next };
      const amt = shapeAmt(simTime), melt = shapeMelt(simTime);
      return { phase: amt <= 0 ? 'waiting' : melt > 0 ? 'melting' : amt < 1 ? 'forming' : 'holding', label: shape.label, next };
    },
    /** Testing aid: fast-forward sky time as if `seconds` passed at 30 fps, then draw. */
    _step(seconds) {
      if (!layers[0]?.snaps) return;
      for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
        const sdt = S.speed / 30; simTime += sdt; updatePlanes(sdt);
        for (const L of layers) advance(L);
        tendShape(false);                          // a shape that has melted makes way for the next, as frames would
      }
      tendShape();
      composite();
    },
    /** PNG data URL of the current frame (null before the first frame). */
    snapshot() { if (needsSetup || !layers[0]?.snaps) return null; composite(); return canvas.toDataURL('image/png'); },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); clearTimeout(fallbackTimer);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      reduceMotion?.removeEventListener?.('change', onMotionPref);
      dprQuery?.removeEventListener('change', onDpr);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      container.style.position = savedStyle.position;
      container.style.isolation = savedStyle.isolation;
    },
  };
}
