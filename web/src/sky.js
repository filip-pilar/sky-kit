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
 * sky time ahead), which is painted a strip per frame in the background. Shapes are fed into the
 * upcoming snapshots, so they cost nothing extra per frame either.
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
uniform sampler2D uShape;     // R = the shape (softened), G = near halo, B = very wide blur (the shape's body)
uniform vec4 uShapeRect;      // cloud-space x0, y0, width, height of the shape image
uniform float uShapeAmt;      // 1 while a shape is active (only the live patch over its area uses it)
uniform float uShapeThick;    // 0 = thin strokes (text) .. 1 = a solid shape (a heart, an emoji)
uniform float uCopyN;         // how many nearby clouds the shape is made from (0..4)
uniform vec4 uCopyBox[4];     // picked cloud k's home box: centre x, y, half width, half height (cloud space);
                              // a piece torn off a big cloud: centre x, y, -radius, radius
uniform vec4 uCopyMove[4];    // its offset from home now (x, y), how far it has turned into the shape (0..1), how far it has travelled (0..1)
uniform vec4 uCopyTarget[4];  // its centre now (x, y); how far its part of the shape reaches from there; its own radius
                              // (the shape starts growing within 40% of it)
uniform float uShapeSolo;     // how far the shape has formed when no cloud was near enough to pick
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

// ---- shapes
// A shape is made from the clouds near it. When it is placed, the CPU picks 2-4 nearby clouds (whole clouds
// with clear sky around them, planShape) and a part of the shape for each. While the shape is on screen the
// near clouds over its area are rendered live every frame: each picked cloud leaves its place and travels
// as an exact copy of itself (the same density, read from its home position in the noise) to its part of
// the shape, where the shape grows out of it behind a ragged front while the cloud gives way. Melting runs
// this backwards and the clouds travel home, so the sky ends exactly as it would have been.
vec4 shapeAt(vec2 p){
  vec2 su = (p - uShapeRect.xy) / uShapeRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return vec4(0.0);
  return texture(uShape, su);
}
float smax(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
float smin(float a, float b, float k){ return -smax(-a, -b, k); }
// the near clouds' density at p (no shape): x = density, y = billow (their fine texture)
vec2 nearCloud(vec2 p){
  vec2 q = p * vec2(2.2, 3.4) / uScale + uSeed;
  vec2 w = vec2(fbm(q * 0.5 + uMorph, 3), fbm(q * 0.5 + 5.2 - uMorph, 3));
  float bil = billow(q * 2.0 + w, 3);
  return vec2(fbm(q * 0.7 + w * 0.6, 4) + 0.15 * (bil - 0.35), bil);
}
float nearCloudLite(vec2 p){
  vec2 q = p * vec2(2.2, 3.4) / uScale + uSeed;
  vec2 w = vec2(fbm(q * 0.5 + uMorph, 2), fbm(q * 0.5 + 5.2 - uMorph, 2));
  return fbm(q * 0.7 + w * 0.6, 3);
}
float boxW(vec2 q, vec4 box, float m){ vec2 a = abs(q); return (1.0 - smoothstep(box.z, box.z + m, a.x)) * (1.0 - smoothstep(box.w, box.w + m, a.y)); }
float boxDist(vec2 q, vec4 box){ return length(max(abs(q) - box.zw, 0.0)); }

// v, bil: the near clouds here. Returns the density with the shape; S = how much of the cloud here is the
// shape's own (its soft rim and tone apply only to that, never to the clouds arriving or around it).
// lite: for the soft self-shadow samples (no fine noise: they run four times per pixel)
float withShape(float v, inout float bil, vec2 p, float thr, bool lite, out float S){
  S = 0.0;
  if (uShapeAmt <= 0.0) return v;
  float t = uShapeThick;
  int n = int(uCopyN + 0.5);
  // the picked clouds: each has left its home box and is somewhere on its way, as an exact copy
  float hole = 0.0, dent = 0.0, vC = thr - 1.0, bilC = bil;
  const float MARGIN = 0.035;                                       // clear sky around a picked cloud's box (as in the planner)
  float rag = lite ? 0.0 : fbm(p * 7.0 + vec2(3.1, 5.9), 2) * 0.12;   // (how ragged the growth front is)
  for (int k = 0; k < 4; k++){
    if (k >= n) break;
    vec4 box = uCopyBox[k], mv = uCopyMove[k], tg = uCopyTarget[k];
    vec2 home = p - box.xy, q = home - mv.xy;
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
    float vb = thr - 0.3;                                          // (clear sky, away from the copy)
    if (wc > 0.0){
      float bb = 0.35;
      if (lite) vb = nearCloudLite(p - mv.xy); else { vec2 c = nearCloud(p - mv.xy); vb = c.x; bb = c.y; }
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
  if (n == 0) S = uShapeSolo;
  float amb = mix(v, -1.0, hole) - dent * 0.7;
  vec4 m = shapeAt(p);
  // near thin strokes (text) other cloud turns into thin wisps (dense cloud thins so the letters stay
  // readable, faint cloud thickens a little); a solid shape just merges with the clouds it touches
  float outside = 1.0 - smoothstep(0.3, 0.65, m.x);
  amb = mix(amb, smin(amb + 0.12, thr + 0.06, 0.08), m.y * outside * smoothstep(0.0, 0.6, S) * (1.0 - t));
  // the shape's own cloud: its outline wobbles at puff scale (stroke width varies like a lumpy cloud);
  // bumps about a letter-stroke wide; solid shapes also get a domed body (densest in the middle, so it
  // shades round) and cauliflower lumps that shape the outline
  float fill = -1.0;
  if (m.y > 0.0){
    vec2 wob = lite ? vec2(0.0) : vec2(fbm(p * 6.5 + vec2(2.3, 8.9), 2), fbm(p * 6.5 + vec2(7.7, 1.3), 2)) * mix(0.025, 0.06, t);
    vec4 ms = shapeAt(p + wob);
    if (ms.x > 0.001){
      float lumps = lite ? 0.0 : fbm(p * 5.5 + vec2(5.1, 7.3), 3);
      float big = lite ? 0.0 : fbm(p * 9.0 + vec2(3.7, 1.9), 3);
      float small = lite ? 0.0 : fbm(p * 26.0 + vec2(8.1, 2.3), 2);
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

// x = density, y = height (for shading); S = how much of the cloud here is a shape's own
vec2 cumulus(vec2 p, float thr, out float S){
  vec2 c = nearCloud(p);
  float bil = c.y;
  float v = withShape(c.x, bil, p, thr, false, S);
  vec4 m = uShapeAmt > 0.0 ? shapeAt(p) : vec4(0.0);
  // a shape's rim fades out slowly like other clouds' edges (more for solid shapes); the outline stays put
  float rim = smoothstep(0.0, 0.3, m.y) * (1.0 - 0.6 * smoothstep(0.35, 0.8, m.x)) * mix(0.6, 1.0, uShapeThick) * smoothstep(0.0, 0.5, S);
  float D = smoothstep(thr, thr + 0.22 + 0.55 * rim, v);
  float dome = smoothstep(thr, thr + 0.7, v);
  float inShape = m.x * S;                                          // softer fine texture inside a shape
  return vec2(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * uScale);
}
float cumulusLite(vec2 p, float thr){
  float bil = 0.35, S;
  float v = withShape(nearCloudLite(p), bil, p, thr, true, S);
  return smoothstep(thr, thr + 0.22, v);
}
void main(){
  vec2 p = uWin0 + gl_FragCoord.xy * uUpp;
  float vv = p.y / uViewH;
  vec3 sky = skyAt(vv);
  float cov = uCov * mix(1.0, 0.75 + 0.35 * (1.0 - smoothstep(0.1, 0.8, vv)), uFarMask);   // edges in order: reversed edges are undefined in GLSL/Metal
  float thr = mix(0.22, -0.12, cov);
  float S;
  vec2 D0 = cumulus(p, thr, S);
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
  for (int i = 1; i <= 4; i++) occ += cumulusLite(p + L2 * 0.028 * float(i) * uScale, thr);
  c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * uShadow);
  c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * uShadow * (1.0 - s));
  // a shape is thin, so it barely shades itself: give its body the tone a big cloud's body has
  if (uShapeAmt > 0.0) c = mix(c, SHADE, shapeAt(p).x * S * 0.7 * uShadow);
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
    float life = exp(-ta / uTrailLife) * smoothstep(0.0, 0.8, ta) / (1.0 + ta * 0.06);
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

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
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
// ---------- shape planning ----------
const PLAN_STEP = 0.02;      // cloud units per cell of the planning map
const PLAN_MARGIN = 0.035;   // clear sky kept around each picked cloud's box (cloud units)
/**
 * Picks the nearby clouds a shape is made from (port of ShapePlan.swift; keep the two identical).
 * grid: opacity 0..255 per cell (the most over the shape's lifetime), gw × gh, rows bottom-up, cell (0, 0)
 * starting at (ox, oy). sil: the silhouette's box [x0, y0, x1, y1] (cloud units); silH its height; need its
 * area; viewH the view's height (clouds mostly above or below it are skipped: they would arrive from out
 * of view). Returns up to 4 whole clouds, each with clear sky around it, and the part of the shape each becomes.
 */
function planShape(grid, gw, gh, ox, oy, sil, silH, need, viewH) {
  const n = gw * gh, step = PLAN_STEP, cell = step * step;
  if (n <= 0) return [];
  const cloud = new Uint8Array(n);
  for (let i = 0; i < n; i++) cloud[i] = grid[i] > 8 ? 1 : 0;
  // grow every cloud by R cells: clouds whose grown areas touch belong together (and a picked cloud then
  // has clear sky around it)
  const R = 2, rowMax = new Uint8Array(n), grown = new Uint8Array(n);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (cloud[y * gw + x])
    for (let xx = Math.max(0, x - R); xx <= Math.min(gw - 1, x + R); xx++) rowMax[y * gw + xx] = 1;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (rowMax[y * gw + x])
    for (let yy = Math.max(0, y - R); yy <= Math.min(gh - 1, y + R); yy++) grown[yy * gw + x] = 1;
  // label the grown areas (4-neighbour flood fill, scanning bottom-up)
  const label = new Int32Array(n).fill(-1);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const stack = [start]; label[start] = count;
    while (stack.length) {
      const i = stack.pop(), x = i % gw, y = (i - x) / gw;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (grown[j] && label[j] < 0) { label[j] = count; stack.push(j); }
      }
    }
    count++;
  }
  const blobs = Array.from({ length: count }, () => ({ cells: 0, seen: 0, wsum: 0, cx: 0, cy: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, border: false }));
  for (let i = 0; i < n; i++) {
    const l = label[i];
    if (l < 0) continue;
    const x = i % gw, y = (i - x) / gw, b = blobs[l];
    if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) b.border = true;
    if (!cloud[i]) continue;
    const w = grid[i], wy = oy + (y + 0.5) * step;
    b.cells++; b.wsum += w;
    if (wy >= 0 && wy <= viewH) b.seen++;
    b.cx += w * x; b.cy += w * y;
    b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
  }
  const centre = b => [ox + (b.cx / b.wsum + 0.5) * step, oy + (b.cy / b.wsum + 0.5) * step];
  const distToShape = c => {
    const dx = Math.max(0, Math.max(sil[0] - c[0], c[0] - sil[2])), dy = Math.max(0, Math.max(sil[1] - c[1], c[1] - sil[3]));
    return Math.sqrt(dx * dx + dy * dy);
  };
  // candidates: whole clouds (not cut by the map's edge), not far from the shape, mostly in view, not a
  // bank several times what the shape needs; closer and bigger first. If none qualifies, look again with
  // looser limits (a shape should always be made from some cloud).
  const cand = [];
  for (const [dMax, areaMax, seenMin] of [[2, 3, 0.5], [3.5, 8, 0.25]]) {
    if (cand.length) break;
    blobs.forEach((b, l) => {
      if (b.border || b.cells < 4) return;
      const area = b.cells * cell, d = distToShape(centre(b)), seen = b.seen / b.cells;
      if (!(d <= dMax * silH && seen >= seenMin && area <= areaMax * need)) return;
      cand.push({ score: area * Math.exp(-d / (0.8 * silH)) / (1 + Math.max(0, area / need - 1.5)) * seen, index: l, dist: d });
    });
  }
  cand.sort((a, b) => a.score !== b.score ? b.score - a.score : a.index - b.index);
  // a picked cloud's box, with its margin, must hold no other cloud (it would be carried along) and must
  // not overlap another picked cloud's box
  const M = Math.ceil(PLAN_MARGIN / step);
  const boxCells = b => [b.x0 - M, b.y0 - M, b.x1 + M, b.y1 + M];
  const holdsOthers = l => {
    const [x0, y0, x1, y1] = boxCells(blobs[l]);
    for (let y = Math.max(0, y0); y <= Math.min(gh - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(gw - 1, x1); x++) {
      const i = y * gw + x;
      if (cloud[i] && label[i] !== l) return true;
    }
    return false;
  };
  const overlapsPicked = (c, picked) => picked.some(p => c[0] <= p.cells[2] && p.cells[0] <= c[2] && c[1] <= p.cells[3] && p.cells[1] <= c[3]);
  const picked = [];
  let have = 0;
  for (const c of cand) {
    if (picked.length >= 4 || (have >= need && picked.length >= Math.min(2, cand.length))) break;
    const b = blobs[c.index], cells = boxCells(b);
    if (overlapsPicked(cells, picked) || holdsOthers(c.index)) continue;
    const box = [ox + (b.x0 + b.x1 + 1) / 2 * step, oy + (b.y0 + b.y1 + 1) / 2 * step, (b.x1 - b.x0 + 1) / 2 * step, (b.y1 - b.y0 + 1) / 2 * step];
    picked.push({ box, centre: centre(b), radius: Math.sqrt(b.cells * cell / Math.PI), dist: c.dist, cells });
    have += b.cells * cell;
  }
  // not enough separate clouds near (in a cloudier sky they join into big masses): tear round pieces off
  // the nearest big clouds instead (soft-edged puffs; a big cloud keeps a soft dent where a piece came
  // from). box = [x, y, -radius, radius] marks a piece.
  if (have < need && picked.length < 4) {
    const r = Math.min(Math.max(Math.sqrt((need - have) / Math.PI), 0.06), 0.6 * silH);
    const rc = Math.ceil(r / step);
    const spots = [];
    for (let y = rc; y < gh - rc; y += 2) for (let x = rc; x < gw - rc; x += 2) {
      if (!cloud[y * gw + x]) continue;
      const cy = oy + (y + 0.5) * step;
      if (!(cy - r >= 0 && cy + r <= viewH)) continue;   // in view
      const d = distToShape([ox + (x + 0.5) * step, cy]);
      if (d <= 2 * silH) spots.push({ dist: d, x, y });
    }
    spots.sort((a, b) => a.dist !== b.dist ? a.dist - b.dist : (a.y !== b.y ? a.y - b.y : a.x - b.x));
    for (const sp of spots) {
      if (picked.length >= 4 || have >= need) break;
      const cells = [sp.x - rc - M, sp.y - rc - M, sp.x + rc + M, sp.y + rc + M];
      if (overlapsPicked(cells, picked)) continue;
      let inDisc = 0, inCloud = 0;   // the piece must be mostly cloud
      for (let yy = sp.y - rc; yy <= sp.y + rc; yy++) for (let xx = sp.x - rc; xx <= sp.x + rc; xx++) {
        const dx = (xx - sp.x) * step, dy = (yy - sp.y) * step;
        if (dx * dx + dy * dy <= r * r) { inDisc++; if (cloud[yy * gw + xx]) inCloud++; }
      }
      if (!(inCloud >= 0.6 * inDisc)) continue;
      const c = [ox + (sp.x + 0.5) * step, oy + (sp.y + 0.5) * step];
      picked.push({ box: [c[0], c[1], -r, r], centre: c, radius: r, dist: sp.dist, cells });
      have += inCloud * cell;
    }
  }
  if (!picked.length) return [];
  // the order clouds go in (closest first) and their parts of the shape (left to right, matching the
  // clouds' order left to right, so their paths don't cross)
  const rank = new Array(picked.length).fill(0);
  picked.map((p, i) => i).sort((a, b) => picked[a].dist !== picked[b].dist ? picked[a].dist - picked[b].dist : a - b).forEach((pi, r) => { rank[pi] = r; });
  const order = picked.map((p, i) => i).sort((a, b) => picked[a].centre[0] !== picked[b].centre[0] ? picked[a].centre[0] - picked[b].centre[0] : a - b);
  const k = picked.length, sw = sil[2] - sil[0], sh = sil[3] - sil[1];
  return order.map((pi, slot) => {
    const p = picked[pi];
    return { box: p.box, centre: p.centre, target: [sil[0] + (slot + 0.5) / k * sw, sil[1] + sh / 2], reach: sw / (2 * k) + sh / 2, radius: p.radius, rank: rank[pi] };
  });
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
  let layers = [];
  let unit = 1, viewH = 1, cacheW = 0, cacheH = 0, winW = 0;
  let simTime = 0, last = 0, lastDraw = 0, raf = 0;
  let needsSetup = true, needsRebuild = false, needsDraw = true;
  let userPaused = false, inView = true, destroyed = false, lost = false;
  let framesDrawn = 0, lostCount = 0, lastGlError = 0;
  const planes = [];              // { x, y, dx, dy, age }
  let nextPlane = 8;
  let shape = null;               // { rect, t0, form, hold, fade, image }
  let shapeTicket = 0;            // bumped by each showShape/clearShape, so a slower build can't overwrite a newer one
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
    shapeTex = null;
    if (shape) { uploadShape(shape.image); shape.patch = null; shape.patchReady = false; }   // old GPU objects are gone
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
  // How far picked cloud c has travelled (0 = home, 1 = at its part of the shape) and turned into the shape
  // (0..1) at time t. Forming: it travels over the first half of the forming time and turns into the shape
  // over the last 60%, overlapping (closest clouds first); melting runs backwards, overlapping, so no cloud
  // waits. (Same as SkyRenderer.copyState.)
  function copyState(sh, rank, t) {
    const a = t - sh.t0, F = sh.form, G = sh.fade;
    if (a < F + sh.hold) { const d = 0.05 * F * rank; return [smooth01((a - d) / (0.5 * F)), smooth01((a - d - 0.32 * F) / (0.6 * F))]; }
    const b = a - F - sh.hold, d = 0.05 * G * rank;
    return [1 - smooth01((b - d - 0.4 * G) / (0.45 * G)), 1 - smooth01((b - d) / (0.5 * G))];
  }
  // how far the shape has formed when no cloud was near enough to pick
  function soloMorph(sh, t) {
    const a = t - sh.t0;
    return a < sh.form + sh.hold ? smooth01(a / sh.form) : 1 - smooth01((a - sh.form - sh.hold) / (0.5 * sh.fade));
  }
  const shapeActive = t => !!shape && t > shape.t0 && t < shape.t0 + shape.form + shape.hold + shape.fade;
  // paint clouds into a framebuffer: a layer snapshot, the live patch over a shape (withShape), or the
  // planning map (upp = its cell size)
  function drawClouds(L, fb, w, h, x0, y0, time, withShape, scissor, upp = viewH / cacheH) {
    const u = cloudProg.u;
    gl.useProgram(cloudProg.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    if (scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...scissor); }
    gl.uniform2f(u.uWin0, x0, y0); gl.uniform1f(u.uUpp, upp); gl.uniform1f(u.uViewH, viewH);
    gl.uniform1f(u.uMorph, time * L.morph); gl.uniform1f(u.uScale, L.scale);
    gl.uniform1f(u.uCov, S.coverage); gl.uniform1f(u.uShadow, S.shadow);
    gl.uniform1f(u.uHaze, L.haze); gl.uniform1f(u.uFarMask, L.farMask); gl.uniform2fv(u.uSeed, layerSeed(L));
    const on = !!(withShape && shape && shapeTex);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, on ? shapeTex : emptyTex); gl.uniform1i(u.uShape, 0);
    gl.uniform1f(u.uShapeAmt, on ? 1 : 0); gl.uniform1f(u.uShapeThick, shape ? shape.thick : 0);
    gl.uniform4fv(u.uShapeRect, shape ? shape.rect : [0, 0, 1, 1]);
    const box = new Float32Array(16), move = new Float32Array(16), target = new Float32Array(16);
    const copies = on ? shape.copies.slice(0, 4) : [];
    copies.forEach((c, k) => {
      const [mv, mo] = copyState(shape, c.rank, time);
      const off = [(c.target[0] - c.centre[0]) * mv, (c.target[1] - c.centre[1]) * mv];
      box.set(c.box, k * 4);
      move.set([off[0], off[1], mo, mv], k * 4);
      target.set([c.centre[0] + off[0], c.centre[1] + off[1], c.reach, c.radius], k * 4);
    });
    gl.uniform1f(u.uCopyN, copies.length); gl.uniform4fv(u.uCopyBox, box); gl.uniform4fv(u.uCopyMove, move); gl.uniform4fv(u.uCopyTarget, target);
    gl.uniform1f(u.uShapeSolo, on ? soloMorph(shape, time) : 0);
    setSkyUniforms(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function paint(L, snap, strip) {
    const scissor = strip >= 0
      ? [Math.floor(cacheW * strip / L.strips), 0, Math.floor(cacheW * (strip + 1) / L.strips) - Math.floor(cacheW * strip / L.strips), cacheH]
      : null;
    drawClouds(L, snap.fb, cacheW, cacheH, snap.x0, 0, snap.time, false, scissor);
  }
  // While a shape is on screen, the near clouds over its area are rendered live every frame (same
  // resolution as the snapshots), with the shape and the clouds it is made from folded in.
  function paintPatch() {
    shape.patchReady = false;
    if (!shapeActive(simTime) || !shapeTex || !layers[1]) return;
    const upp = viewH / cacheH, r = shape.region, fade = shape.fade_;
    // only the part of the shape's area that is on screen (plus the blend border, which stays off screen)
    const scroll = dir() * layers[1].speed * simTime, vw = canvas.width / unit;
    const x0 = Math.max(r[0], scroll - fade), x1 = Math.min(r[0] + r[2], scroll + vw + fade);
    const y0 = Math.max(r[1], -fade), y1 = Math.min(r[1] + r[3], viewH + fade);
    if (x1 <= x0 || y1 <= y0) return;
    const w = Math.max(1, Math.min(4096, Math.ceil((x1 - x0) / upp))), h = Math.max(1, Math.min(4096, Math.ceil((y1 - y0) / upp)));
    // one texture big enough for the largest clip, so a shape sliding off screen doesn't reallocate every frame
    const tw = Math.max(1, Math.min(4096, Math.ceil(Math.min(r[2], vw + 2 * fade) / upp) + 2));
    const th = Math.max(1, Math.min(4096, Math.ceil(Math.min(r[3], viewH + 2 * fade) / upp) + 2));
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
    drawClouds(layers[1], P.fb, w, h, x0, y0, simTime, true, null);
    P.view = [x0 - scroll, y0, w * upp, h * upp];   // view-relative rect of what was drawn
    P.uv = [w / P.w, h / P.h];                       // the part of the texture it fills
    shape.patchReady = true;
  }
  function freeShape() {
    if (shape?.patch && gl) { gl.deleteTexture(shape.patch.tex); gl.deleteFramebuffer(shape.patch.fb); }
    shape = null;
  }
  function rebuildAll() {
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
  // The mask is built at 100 px per silhouette height (it is heavily blurred anyway; radii below are for
  // 220 px, scaled); it yields between steps so the sky keeps animating meanwhile.
  const MASK_PX = 100, MS = MASK_PX / 220;
  // a message, not a timer: background tabs hold timers back (up to a minute), and timers have a 4 ms minimum
  const breathe = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
  async function buildShapeImage(src) {
    const sil = silhouette(src, MASK_PX);
    const pad = Math.round(sil.height * 0.8);       // room for the blurs
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
    // thick, solid shapes (a heart, an emoji) get soft cloud edges like the clouds around them;
    // thin strokes (text) stay crisp enough to read
    let bodyMax = 0; for (let i = 0; i < w * h; i++) bodyMax = Math.max(bodyMax, body[i]);
    const thick = Math.min(1, Math.max(0, (bodyMax / 255 - 0.6) / 0.3));
    await breathe();
    const near = blurIn(alpha, w, h, (16 + 8 * thick) * MS, 1, bx0, by0, bx1, by1);
    await breathe();
    const wide = blurIn(alpha, w, h, 44 * MS, 2, bx0, by0, bx1, by1);
    await breathe();
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {                 // write rows bottom-up (GL texture order)
      const sy = h - 1 - y, row = sy * w, inBox = sy >= by0 && sy < by1;
      for (let x = 0; x < w; x++) {
        const s = row + x, d = (y * w + x) * 4;
        if (inBox && x >= bx0 && x < bx1) {       // the narrower blurs are zero outside their box
          data[d] = Math.min(255, near[s]);
          data[d + 1] = Math.min(255, wide[s] * 1.4);
          data[d + 2] = Math.min(255, body[s]);
        }
      }
    }
    let area = 0; for (let i = 0; i < w * h; i++) area += alpha[i];
    return { width: w, height: h, data, silH: sil.height, silW: sil.width, pad, thick, area: area / 255 };   // area in mask pixels
  }
  function placeShape(img, o) {
    const N = layers[1];
    const t0 = simTime + 0.2;
    const vw = canvas.width / unit;
    const form = o.form ?? 5, hold = o.hold ?? 5, fade = o.fade ?? 7;
    // size is a fraction of the view height, shrunk if needed so the shape fits 70% of the view width
    const silH = Math.min((o.size ?? 0.32) * viewH, 0.7 * vw * img.silH / img.silW);
    const hUnits = silH * (img.height / img.silH);
    const wUnits = hUnits * img.width / img.height;
    // the shape drifts with the clouds: place it so it is at (x, y) halfway through its hold
    const tMid = t0 + form + hold / 2;
    const cx = (o.x ?? 0.5) * vw + dir() * N.speed * tMid, cy = (o.y ?? 0.6) * viewH;
    freeShape();
    const rect = [cx - wUnits / 2, cy - hUnits / 2, wUnits, hUnits];
    // the area the shape may change: the view at the start and the end of its life, plus a margin (the
    // patch's blend border stays out of view, and the clouds near the view's edges are whole inside it)
    const tEnd = t0 + form + hold + fade, s0 = dir() * N.speed * t0, s1 = dir() * N.speed * tEnd;
    const area = [Math.min(s0, s1) - 0.8, -0.8, Math.abs(s1 - s0) + vw + 1.6, viewH + 1.6];
    shape = { image: img, rect, area, t0, tMid, form, hold, fade, patch: null, patchReady: false, thick: img.thick, fade_: 0.1, copies: [] };
    // the silhouette's box and area in cloud units, then the nearby clouds it will be made from
    const k = hUnits / img.height, pad = img.pad * k;
    const sil = [rect[0] + pad, rect[1] + pad, rect[0] + pad + img.silW * k, rect[1] + pad + img.silH * k];
    shape.copies = pickClouds(sil, silH, 1.1 * img.area * k * k, area, shape.fade_, [t0, t0 + form + hold / 2, tEnd]);
    // the live patch only needs to cover what changes: the shape and each picked cloud's home, path and
    // target (plus the blend border, where the patch already equals the ordinary sky)
    let rx0 = rect[0], ry0 = rect[1], rx1 = rect[0] + rect[2], ry1 = rect[1] + rect[3];
    for (const c of shape.copies) {
      const hx = Math.abs(c.box[2]) + PLAN_MARGIN, hy = c.box[3] + PLAN_MARGIN, ox = c.target[0] - c.centre[0], oy = c.target[1] - c.centre[1];
      for (const [x, y] of [[c.box[0], c.box[1]], [c.box[0] + ox, c.box[1] + oy]]) {
        rx0 = Math.min(rx0, x - hx); ry0 = Math.min(ry0, y - hy); rx1 = Math.max(rx1, x + hx); ry1 = Math.max(ry1, y + hy);
      }
    }
    const e = shape.fade_ + 0.02;
    shape.region = [rx0 - e, ry0 - e, rx1 - rx0 + 2 * e, ry1 - ry0 + 2 * e];
    uploadShape(img);
    redraw();
  }
  // Renders a low-resolution map of the near clouds around the shape (the most opaque each cell gets at
  // `times`) and picks the clouds the shape is made from (planShape).
  function pickClouds(sil, silH, need, area, blend, times) {
    // the map covers all of the shape's area that the live patch can change (picked clouds and their
    // margins must stay inside it); planShape only picks clouds within reach of the shape
    const step = PLAN_STEP, keep = blend + PLAN_MARGIN + step;
    const x0 = area[0] + keep, y0 = area[1] + keep, x1 = area[0] + area[2] - keep, y1 = area[1] + area[3] - keep;
    const gw = Math.trunc((x1 - x0) / step), gh = Math.trunc((y1 - y0) / step);
    if (gw <= 4 || gh <= 4 || !layers[1]) return [];
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const grid = new Uint8Array(gw * gh), px = new Uint8Array(gw * gh * 4);
    for (const t of times) {
      drawClouds(layers[1], fb, gw, gh, x0, y0, t, false, null, step);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, px);   // rows bottom-up, like the map
      for (let i = 0; i < gw * gh; i++) grid[i] = Math.max(grid[i], px[i * 4 + 3]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
    return planShape(grid, gw, gh, x0, y0, sil, silH, need, viewH);
  }
  function shapeUniforms(u) {
    const on = !!(shape && shape.patchReady);
    gl.uniform1f(u.uPatchOn, on ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, on ? shape.patch.tex : emptyTex); gl.uniform1i(u.uPatch, 4);
    if (on) {
      gl.uniform4fv(u.uShapeView, shape.patch.view); gl.uniform2fv(u.uPatchUV, shape.patch.uv);
      gl.uniform1f(u.uPatchFade, shape.fade_);   // its border is out of view
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
    if (needsSetup) { setupCaches(); needsSetup = false; needsRebuild = false; }
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
  function tendShape() {
    if (!shape) return;
    if (simTime > shape.t0 + shape.form + shape.hold + shape.fade + 0.5) { freeShape(); return; }
    paintPatch();
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
               size: [canvas.width, canvas.height], snapshots: layers[0]?.snaps ? [cacheW, cacheH] : null,
               shapeClouds: shape ? shape.copies.length : null };   // how many nearby clouds the current shape is made from
    },
    set(o) {
      o = cleanOptions(o);
      const resetup = RESETUP_KEYS.some(k => k in o && o[k] !== S[k]);
      const rebuild = REBUILD_KEYS.some(k => k in o && o[k] !== S[k]);
      if ('direction' in o && o.direction !== S.direction) { shapeTicket++; freeShape(); }   // a placed shape belongs to the old drift
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
     * The clouds nearby drift in and gather into a shape, hold it, then melt back into ordinary
     * clouds while drifting. { text } or { image: HTMLImageElement | canvas | url }, plus optional
     * x, y (0..1 of the view, centre), size (0..1 of the view height), form, hold, fade (seconds).
     * Needs speed > 0: shapes form as the sky moves on.
     */
    async showShape(o) {
      let src = o.text;
      if (o.image) src = typeof o.image === 'string' ? await loadImage(o.image) : o.image;
      if (!src || !layers[0]?.snaps) return;
      const ticket = ++shapeTicket;               // a newer showShape or a clearShape wins
      const img = await buildShapeImage(src);
      if (ticket !== shapeTicket || destroyed || !layers[0]?.snaps) return;
      placeShape(img, o);
    },
    clearShape() { shapeTicket++; freeShape(); },
    /** Testing aid: fast-forward sky time as if `seconds` passed at 30 fps, then draw. */
    _step(seconds) {
      if (!layers[0]?.snaps) return;
      for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
        const sdt = effectiveSpeed() / 30; simTime += sdt; updatePlanes(sdt);
        for (const L of layers) advance(L);
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
