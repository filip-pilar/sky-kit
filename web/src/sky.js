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
uniform sampler2D uShape;     // R = the shape (softened), G = wide area around it
uniform vec4 uShapeRect;      // cloud-space x0, y0, width, height of the shape image
uniform float uShapeOnly;     // 1 = paint only the shape's own cloud (the finished shape image)
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
// The finished shape is painted once, on its own, into an image (uShapeOnly = 1); the composite pass
// reveals it puff by puff every frame. Normal cloud snapshots never contain the shape.
vec2 shapeAt(vec2 p){
  vec2 su = (p - uShapeRect.xy) / uShapeRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return vec2(0.0);
  return texture(uShape, su).rg;
}
// The silhouette built out of cloud: bumpy cumulus edges (big lumps about a letter-stroke wide),
// smaller lumps and the cloud's own billows inside.
float withShape(float v, vec2 p, float thr, float bil){
  if (uShapeOnly < 0.5) return v;
  vec2 m = shapeAt(p);
  float big = fbm(p * 9.0 + vec2(3.7, 1.9), 3);
  float small = fbm(p * 26.0 + vec2(8.1, 2.3), 2);
  float fill = thr + (m.x - 0.55) * 0.55 + big * 0.35 + small * 0.15 + (bil - 0.35) * 0.2;
  return mix(-1.0, fill, smoothstep(0.02, 0.2, m.x));
}

vec2 cumulus(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
  float base = fbm(q * 0.7 + w * 0.6, 4);
  float bil = billow(q * 2.0 + w, 3);
  float thr = mix(0.22, -0.12, cov);
  float v = withShape(base + 0.15 * (bil - 0.35), p, thr, bil);
  float D = smoothstep(thr, thr + 0.22, v);
  float dome = smoothstep(thr, thr + 0.7, v);
  float inShape = uShapeOnly > 0.5 ? shapeAt(p).x : 0.0;          // softer fine texture inside a shape
  return vec2(D, (0.05 * dome + 0.012 * D * bil * (1.0 - 0.5 * inShape)) * scale);
}
float cumulusLite(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
  float thr = mix(0.22, -0.12, cov);
  float v = withShape(fbm(q * 0.7 + w * 0.6, 3), p, thr, 0.35);
  return smoothstep(thr, thr + 0.22, v);
}
void main(){
  vec2 p = uWin0 + gl_FragCoord.xy * uUpp;
  float vv = p.y / uViewH;
  vec3 sky = skyAt(vv);
  float cov = uCov * mix(1.0, 0.75 + 0.35 * (1.0 - smoothstep(0.1, 0.8, vv)), uFarMask);   // edges in order: reversed edges are undefined in GLSL/Metal
  vec2 D0 = cumulus(p, uScale, uSeed, cov, uMorph);
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
  for (int i = 1; i <= 4; i++) occ += cumulusLite(p + L2 * 0.028 * float(i) * uScale, uScale, uSeed, cov, uMorph);
  c = mix(c, SHADE, smoothstep(0.35, 0.95, occ / 4.0) * uShadow);
  c = mix(c, SHADE, smoothstep(0.45, 1.0, D0.x) * 0.2 * uShadow * (1.0 - s));
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
uniform sampler2D uShape, uFormed;  // shape mask (R shape, G wide area) and the finished shape image
uniform vec4 uShapeView;       // view-relative x0, y0, width, height of the shape's rect (it drifts with the clouds)
uniform vec2 uShapeOrigin;     // the same rect's cloud-space origin (keeps the puff order fixed to the shape)
uniform float uShapeAmt;       // 0 = none .. 1 = fully formed, updated every frame
out vec4 outColor;
${COMMON}
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
float fbm3(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){ s += a * gnoise(p); p = ROT * p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
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
  // shapes, animated every frame: nearby clouds drift in and thin out, the shape appears puff by puff
  vec2 pn = p;
  float clear = 0.0;
  vec4 shapeCol = vec4(0.0);
  if (uShapeAmt > 0.0){
    vec2 su = (p - uShapeView.xy) / uShapeView.zw;
    if (su.x > 0.0 && su.y > 0.0 && su.x < 1.0 && su.y < 1.0){
      vec2 m = texture(uShape, su).rg;
      vec2 e = vec2(0.035) / uShapeView.zw;                         // wide step: averages out the mask's 8-bit steps
      vec2 grad = vec2(texture(uShape, su + vec2(e.x, 0.0)).g - texture(uShape, su - vec2(e.x, 0.0)).g,
                       texture(uShape, su + vec2(0.0, e.y)).g - texture(uShape, su - vec2(0.0, e.y)).g) / 0.07;
      vec2 toward = grad / (length(grad) + 1.5);
      pn = p - toward * 0.3 * uShapeAmt * m.y * (1.0 - smoothstep(0.1, 0.6, m.x));   // show the cloud from further out
      clear = uShapeAmt * m.y * 0.85;                                 // the surrounding cloud was drawn in
      // puffs grow from dense cores outward (and shrink back while melting): each pixel appears at a
      // moment set by its puff's order and by how deep inside the cloud it is, with a narrow soft front
      vec4 f = texture(uFormed, su);
      float order = clamp(fbm3((uShapeOrigin + su * uShapeView.zw) * 9.0 + vec2(3.7, 1.9)) * 1.2 + 0.5, 0.0, 1.0);
      float t = order * 0.6 + (1.0 - f.a) * 0.4;
      shapeCol = f * smoothstep(t - 0.06, t + 0.06, uShapeAmt * 1.1);
    }
  }
  vec4 near = layerAt(uNearA, uNearB, uNear, pn) * (1.0 - clear);
  near = shapeCol + near * (1.0 - shapeCol.a);
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
  const r = Math.max(1, Math.round(radius / 1.7));
  const pass = (src, dst, n, m, stride, step) => {   // n lines of m samples
    for (let i = 0; i < n; i++) {
      const base = i * stride;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[base + Math.min(m - 1, Math.max(0, k)) * step];
      for (let j = 0; j < m; j++) {
        dst[base + j * step] = acc / (2 * r + 1);
        acc += src[base + Math.min(m - 1, j + r + 1) * step] - src[base + Math.max(0, j - r) * step];
      }
    }
  };
  for (let k = 0; k < 3; k++) { pass(a, b, h, w, w, 1); pass(b, a, w, h, 1, w); }
  return a;
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
    if (shape) { uploadShape(shape.image); shape.formed = null; shape.formedDirty = true; }   // old GPU objects are gone
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
  function shapeAmt(t) {
    if (!shape) return 0;
    const a = t - shape.t0, { form, hold, fade } = shape;
    if (a <= 0) return 0;
    if (a < form) return smooth01(a / form);
    if (a < form + hold) return 1;
    return 1 - smooth01((a - form - hold) / fade);
  }
  // paint clouds into a framebuffer: a layer snapshot, or (shapeOnly) the finished shape image
  function drawClouds(L, fb, w, h, x0, y0, time, shapeOnly, scissor) {
    const u = cloudProg.u;
    gl.useProgram(cloudProg.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    if (scissor) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...scissor); }
    gl.uniform2f(u.uWin0, x0, y0); gl.uniform1f(u.uUpp, viewH / cacheH); gl.uniform1f(u.uViewH, viewH);
    gl.uniform1f(u.uMorph, time * L.morph); gl.uniform1f(u.uScale, L.scale);
    gl.uniform1f(u.uCov, S.coverage); gl.uniform1f(u.uShadow, S.shadow);
    gl.uniform1f(u.uHaze, L.haze); gl.uniform1f(u.uFarMask, L.farMask); gl.uniform2fv(u.uSeed, layerSeed(L));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, shapeOnly ? shapeTex : emptyTex); gl.uniform1i(u.uShape, 0);
    gl.uniform1f(u.uShapeOnly, shapeOnly ? 1 : 0);
    gl.uniform4fv(u.uShapeRect, shape ? shape.rect : [0, 0, 1, 1]);
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
  // the finished shape, painted once on its own; the composite pass reveals it puff by puff
  function paintFormed() {
    if (!shape || !shapeTex || !layers[1]) return;
    const upp = viewH / cacheH;
    const w = Math.max(1, Math.min(4096, Math.ceil(shape.rect[2] / upp))), h = Math.max(1, Math.min(4096, Math.ceil(shape.rect[3] / upp)));
    if (!shape.formed || shape.formed.w !== w || shape.formed.h !== h) {
      if (shape.formed) { gl.deleteTexture(shape.formed.tex); gl.deleteFramebuffer(shape.formed.fb); }
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      shape.formed = { tex, fb, w, h };
    }
    drawClouds(layers[1], shape.formed.fb, w, h, shape.rect[0], shape.rect[1], shape.tMid, true, null);
    shape.formedDirty = false;
  }
  function freeShape() {
    if (shape?.formed && gl) { gl.deleteTexture(shape.formed.tex); gl.deleteFramebuffer(shape.formed.fb); }
    shape = null;
  }
  function rebuildAll() {
    if (shape) shape.formedDirty = true;
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
  function buildShapeImage(src) {
    const sil = silhouette(src, 220);
    const pad = Math.round(sil.height * 0.5);
    const w = sil.width + pad * 2, h = sil.height + pad * 2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); cx.drawImage(sil, pad, pad);
    const px = cx.getImageData(0, 0, w, h).data, alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3];
    const near = blurAlpha(alpha, w, h, 16), wide = blurAlpha(alpha, w, h, 44);   // soft silhouette: the puffs shape the edge
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {                 // write rows bottom-up (GL texture order)
      for (let x = 0; x < w; x++) {
        const s = (h - 1 - y) * w + x, d = (y * w + x) * 4;
        data[d] = Math.min(255, near[s]);
        data[d + 1] = Math.min(255, wide[s] * 1.4);
        data[d + 3] = 255;
      }
    }
    return { width: w, height: h, data, silH: sil.height, silW: sil.width };
  }
  function placeShape(src, o) {
    const img = buildShapeImage(src);
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
    shape = { image: img, rect: [cx - wUnits / 2, cy - hUnits / 2, wUnits, hUnits], t0, tMid, form, hold, fade, formedDirty: true };
    uploadShape(img);
    paintFormed();
    redraw();
  }
  function shapeUniforms(u) {
    const amt = shape && !shape.formedDirty ? shapeAmt(simTime) : 0;
    gl.uniform1f(u.uShapeAmt, amt);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, amt > 0 ? shapeTex : emptyTex); gl.uniform1i(u.uShape, 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, amt > 0 ? shape.formed.tex : emptyTex); gl.uniform1i(u.uFormed, 5);
    if (amt > 0) {
      const r = shape.rect, scroll = dir() * layers[1].speed * simTime;   // subtracted in double precision
      gl.uniform4f(u.uShapeView, r[0] - scroll, r[1], r[2], r[3]);
      gl.uniform2f(u.uShapeOrigin, r[0], r[1]);
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
  // keep the shape's finished image current, and drop the shape once it has melted
  function tendShape() {
    if (!shape) return;
    if (simTime > shape.t0 + shape.form + shape.hold + shape.fade + 0.5) { freeShape(); return; }
    if (shape.formedDirty) paintFormed();
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
      if ('direction' in o && o.direction !== S.direction) freeShape();   // a placed shape belongs to the old drift
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
      placeShape(src, o);
    },
    clearShape() { freeShape(); },
    /** Testing aid: fast-forward sky time as if `seconds` passed at 30 fps, then draw. */
    _step(seconds) {
      if (!layers[0]?.snaps) return;
      for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
        const sdt = effectiveSpeed() / 30; simTime += sdt; updatePlanes(sdt);
        for (const L of layers) advance(L);
        tendShape();
      }
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
