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
 * view. Every frame only slides those images and crossfades to the next snapshot (DT seconds
 * of sky time ahead), which is painted a strip per frame in the background. Shapes are fed
 * into the upcoming snapshots, so they cost nothing extra per frame either.
 */

export const PALETTES = {
  day:    { skyTop: '#2a7be4', skyMid: '#5fb0f4', skyLow: '#cdeaff' },
  summer: { skyTop: '#1663d6', skyMid: '#3d9cf2', skyLow: '#bfe4ff' },
  pastel: { skyTop: '#5a9ced', skyMid: '#93c7f6', skyLow: '#e3f2ff' },
};

export const SKY_DEFAULTS = {
  speed: 1,              // 0 = still, 1 = gentle drift, 4 = brisk
  coverage: 0.6,         // 0 = almost clear .. 1 = lots of cloud
  shadow: 0.3,           // shading inside clouds, 0 .. 1
  cloudScale: 1,         // cloud size multiplier
  direction: 'left',     // 'left' or 'right'
  seed: 0,               // any number: a different sky
  palette: 'day',        // 'day' | 'summer' | 'pastel'; skyTop/skyMid/skyLow override it
  skyTop: null, skyMid: null, skyLow: null,
  gradient: 0,           // 0 = even blue sky, 1 = deep blue fading to a pale horizon
  quality: 'high',       // 'high' | 'balanced' | 'low' — resolution of the cloud snapshots
  fps: 60,               // frame cap
  interactive: false,    // pointer movement gently pushes the clouds, which then settle back
  planes: false,         // occasional planes with contrails
  trailLife: 40,         // seconds a contrail lingers
  respectReducedMotion: true,
};

const REBUILD_KEYS = ['coverage', 'shadow', 'seed', 'direction', 'palette', 'skyTop', 'skyMid', 'skyLow', 'gradient'];
const RESETUP_KEYS = ['cloudScale', 'quality'];
const QUALITY = { high: 1.25, balanced: 1.0, low: 0.75 };   // snapshot pixels per CSS pixel
const DT = 2.0;            // seconds of sky time between snapshots
const STRIPS = 24;         // frames used to paint one snapshot
const MARGIN = 0.3;        // extra cloud space on each side of the view, in cloud units
const MAX_GUSTS = 12;
const PLANE_SPEED = 0.06;  // cloud units per second
const LAYERS = [
  { scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1, push: 0.4 },
  { scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0,  farMask: 0, push: 1.0 },
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
uniform sampler2D uShape;     // R = shape, G = wide halo around it (cleared of other cloud)
uniform vec4 uShapeRect;      // cloud-space x0, y0, width, height of the shape image
uniform float uShapeAmt;      // 0 = no shape, 1 = fully formed
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
// shapes: pull cloud into the silhouette and thin out the clouds around it
// bil: the cloud's own billow noise, so a shape keeps lumpy cloud texture inside and torn edges
float withShape(float v, vec2 p, float bil){
  if (uShapeAmt <= 0.0) return v;
  vec2 su = (p - uShapeRect.xy) / uShapeRect.zw;
  if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) return v;
  vec2 s = texture(uShape, su).rg * uShapeAmt;
  return mix(v, v * 0.5 - 0.15, s.g * (1.0 - s.r)) + s.r * (0.38 + 0.3 * bil);   // clear around it, not inside it
}
vec2 cumulus(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
  float base = fbm(q * 0.7 + w * 0.6, 4);
  float bil = billow(q * 2.0 + w, 3);
  float v = withShape(base + 0.15 * (bil - 0.35), p, bil);
  float thr = mix(0.22, -0.12, cov);
  float D = smoothstep(thr, thr + 0.22, v);
  float dome = smoothstep(thr, thr + 0.7, v);
  return vec2(D, (0.05 * dome + 0.012 * D * bil) * scale);
}
float cumulusLite(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
  float v = withShape(fbm(q * 0.7 + w * 0.6, 3), p, 0.35);
  float thr = mix(0.22, -0.12, cov);
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
uniform vec2 uPush;            // how strongly the pointer pushes the far / near layer
uniform vec4 uGust[${MAX_GUSTS}];  // view-relative x, y and displacement dx, dy (cloud units)
uniform int uGustN;
uniform vec4 uPlane[2];        // view-relative start x, y and direction
uniform vec2 uPlaneAge;        // seconds since launch, < 0 = none
uniform float uPlaneSpeed, uTrailLife, uTrailDrift;
out vec4 outColor;
${COMMON}
vec4 layerAt(sampler2D A, sampler2D B, vec4 w, vec2 p){
  float vy = p.y / uViewH;
  vec4 a = texture(A, vec2((p.x + w.x) / w.z, vy));
  vec4 b = texture(B, vec2((p.x + w.y) / w.z, vy));
  return mix(a, b, w.w);
}
vec2 gust(vec2 p){
  vec2 d = vec2(0.0);
  for (int i = 0; i < ${MAX_GUSTS}; i++){
    if (i >= uGustN) break;
    vec2 r = p - uGust[i].xy;
    d += uGust[i].zw * exp(-dot(r, r) / 0.02);
  }
  float len = length(d);
  if (len > 0.15) d *= 0.15 / len;                                        // stays well inside the 0.3 side margin
  return d * smoothstep(0.0, 0.18, p.y) * smoothstep(0.0, 0.18, uViewH - p.y);   // no sampling past the top/bottom
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
  vec2 g = uGustN > 0 ? gust(p) : vec2(0.0);
  vec4 far = layerAt(uFarA, uFarB, uFar, p - g * uPush.x);
  col = col * (1.0 - far.a) + far.rgb;
  if (uPlaneAge.x >= 0.0 || uPlaneAge.y >= 0.0){
    float pd;
    float tr = contrails(p, pd);
    col = mix(col, vec3(1.0), clamp(tr, 0.0, 1.0) * 0.85);
    col = mix(col, vec3(0.95, 0.97, 1.0), pd * 0.9);
  }
  vec4 near = layerAt(uNearA, uNearB, uNear, p - g * uPush.y);
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
  const gusts = [];               // { x, y, dx, dy, born }
  const planes = [];              // { x, y, dx, dy, age }
  let nextPlane = 8;
  let shape = null;               // { rect, t0, form, hold, fade, image }
  const reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const dir = () => (S.direction === 'right' ? -1 : 1);
  const effectiveSpeed = () => (S.respectReducedMotion && reduceMotion?.matches ? 0 : S.speed);
  const colors = () => {
    const p = PALETTES[S.palette] || PALETTES.day;
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
    if (shape) uploadShape(shape.image);
    layers = LAYERS.map(L => ({ ...L, snaps: null }));
    needsSetup = true;
  }
  function makeSnap() {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cacheW, cacheH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); texParams();
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, time: 0, x0: 0, strip: STRIPS };
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
  function paint(L, snap, strip) {
    const u = cloudProg.u;
    gl.useProgram(cloudProg.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, snap.fb);
    gl.viewport(0, 0, cacheW, cacheH);
    if (strip >= 0) {
      const x = Math.floor(cacheW * strip / STRIPS), x2 = Math.floor(cacheW * (strip + 1) / STRIPS);
      gl.enable(gl.SCISSOR_TEST); gl.scissor(x, 0, x2 - x, cacheH);
    }
    gl.uniform2f(u.uWin0, snap.x0, 0); gl.uniform1f(u.uUpp, viewH / cacheH); gl.uniform1f(u.uViewH, viewH);
    gl.uniform1f(u.uMorph, snap.time * L.morph); gl.uniform1f(u.uScale, L.scale);
    gl.uniform1f(u.uCov, S.coverage); gl.uniform1f(u.uShadow, S.shadow);
    gl.uniform1f(u.uHaze, L.haze); gl.uniform1f(u.uFarMask, L.farMask); gl.uniform2fv(u.uSeed, layerSeed(L));
    const amt = L === layers[1] && shapeTex ? shapeAmt(snap.time) : 0;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, amt > 0 ? shapeTex : emptyTex); gl.uniform1i(u.uShape, 0);
    gl.uniform1f(u.uShapeAmt, amt);
    gl.uniform4fv(u.uShapeRect, shape ? shape.rect : [0, 0, 1, 1]);
    setSkyUniforms(u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  function rebuildAll() {
    for (const L of layers) {
      const t0 = L.snaps[0].time;
      L.snaps.forEach((s, k) => { place(L, s, t0 + k * DT); paint(L, s, -1); s.strip = STRIPS; });
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
      L.snaps = [makeSnap(), makeSnap(), makeSnap()];
      L.snaps.forEach((s, k) => place(L, s, t0 + k * DT));
    }
    rebuildAll();
  }
  function advance(L) {
    while (simTime >= L.snaps[1].time) {
      const [A, B, C] = L.snaps;
      while (C.strip < STRIPS) paint(L, C, C.strip++);
      place(L, A, C.time + DT); A.strip = 0;
      L.snaps = [B, C, A];
    }
    const C = L.snaps[2];
    if (C.strip < STRIPS) paint(L, C, C.strip++);
  }

  // ---------- pointer wind ----------
  let lastPtr = null;
  function onPointerMove(e) {
    if (!S.interactive || !unit) return;
    const r = container.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - r.left) * dpr / unit, y = (r.bottom - e.clientY) * dpr / unit;
    const now = performance.now();
    if (lastPtr) {
      const dt = Math.max((now - lastPtr.t) / 1000, 0.008);
      const dx = x - lastPtr.x, dy = y - lastPtr.y;
      if (Math.hypot(dx, dy) > 0.015) {
        let vx = dx / dt, vy = dy / dt;
        const sp = Math.hypot(vx, vy), cap = 0.6;          // ignore frantic flicks
        if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
        gusts.push({ x, y, dx: vx * 0.09, dy: vy * 0.09, born: now });
        if (gusts.length > MAX_GUSTS) gusts.shift();
        lastPtr = { x, y, t: now };
        redraw(false);
      }
    } else lastPtr = { x, y, t: now };
  }
  const onPointerLeave = () => { lastPtr = null; };
  container.addEventListener('pointermove', onPointerMove, { passive: true });
  container.addEventListener('pointerleave', onPointerLeave, { passive: true });
  function gustUniforms(now) {
    while (gusts.length && now - gusts[0].born > 5000) gusts.shift();
    const data = new Float32Array(MAX_GUSTS * 4);
    gusts.forEach((g, i) => {
      const age = (now - g.born) / 1000;
      const env = Math.min(age / 0.15, 1) * Math.exp(-Math.max(age - 0.15, 0) / 1.1);   // push, then settle back
      data.set([g.x, g.y, g.dx * env, g.dy * env], i * 4);
    });
    return data;
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
    const pad = Math.round(sil.height * 0.45);
    const w = sil.width + pad * 2, h = sil.height + pad * 2;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d'); cx.drawImage(sil, pad, pad);
    const px = cx.getImageData(0, 0, w, h).data, alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3];
    const near = blurAlpha(alpha, w, h, 9), wide = blurAlpha(alpha, w, h, 34);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {                 // write rows bottom-up (GL texture order)
      for (let x = 0; x < w; x++) {
        const s = (h - 1 - y) * w + x, d = (y * w + x) * 4;
        data[d] = Math.min(255, near[s]);
        data[d + 1] = Math.min(255, wide[s] * 1.8);
        data[d + 3] = 255;
      }
    }
    return { width: w, height: h, data, silH: sil.height };
  }
  function placeShape(src, o) {
    const img = buildShapeImage(src);
    const N = layers[1];
    const t0 = N.snaps ? N.snaps[2].time : simTime + DT;   // first snapshot not painted yet
    const vw = canvas.width / unit;
    const hUnits = (o.size ?? 0.32) * viewH * (img.height / img.silH);
    const wUnits = hUnits * img.width / img.height;
    const cx = (o.x ?? 0.5) * vw + dir() * N.speed * t0, cy = (o.y ?? 0.6) * viewH;
    shape = { image: img, rect: [cx - wUnits / 2, cy - hUnits / 2, wUnits, hUnits], t0,
              form: o.form ?? 4, hold: o.hold ?? 6, fade: o.fade ?? 8 };
    uploadShape(img);
    redraw();
  }

  // ---------- frame loop ----------
  const running = () => !destroyed && !lost && !userPaused && inView && !document.hidden;
  function frame(now) {
    raf = 0;
    if (destroyed || lost) return;
    const moving = running() && effectiveSpeed() > 0;
    const stirring = inView && !document.hidden && gusts.length > 0;
    if ((moving || stirring) && now - lastDraw < 1000 / S.fps - 1 && !needsDraw) { schedule(); return; }
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
    composite(now);
    framesDrawn++;
    if (framesDrawn <= 3) { const e = gl.getError(); if (e) lastGlError = e; }   // cheap check on the first frames only
    lastDraw = now; needsDraw = false;
    if (moving || gusts.length) schedule();
  }
  function composite(now = performance.now()) {
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
      return [scroll - L.snaps[0].x0, scroll - L.snaps[1].x0, winW, Math.min(1, Math.max(0, (simTime - L.snaps[0].time) / DT))];
    };
    gl.uniform4fv(u.uFar, win(F)); gl.uniform4fv(u.uNear, win(N));
    gl.uniform2f(u.uPush, F.push, N.push);
    gl.uniform4fv(u.uGust, gustUniforms(now)); gl.uniform1i(u.uGustN, gusts.length);
    const pv = new Float32Array(8), pa = [-1, -1];
    planes.forEach((pl, i) => { pv.set([pl.x, pl.y, pl.dx, pl.dy], i * 4); pa[i] = pl.age; });
    gl.uniform4fv(u.uPlane, pv); gl.uniform2fv(u.uPlaneAge, pa);
    gl.uniform1f(u.uPlaneSpeed, PLANE_SPEED); gl.uniform1f(u.uTrailLife, S.trailLife);
    gl.uniform1f(u.uTrailDrift, -dir() * F.speed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
      if ('direction' in o && o.direction !== S.direction) shape = null;   // a placed shape belongs to the old drift
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
     * Clouds gather into a shape, hold it, then melt back into ordinary clouds while drifting.
     * { text } or { image: HTMLImageElement | canvas | url }, plus optional
     * x, y (0..1 of the view, centre), size (0..1 of the view height), form, hold, fade (seconds).
     * Needs speed > 0: shapes form as the sky moves on.
     */
    async showShape(o) {
      let src = o.text;
      if (o.image) src = typeof o.image === 'string' ? await loadImage(o.image) : o.image;
      if (!src || !layers[0]?.snaps) return;
      placeShape(src, o);
    },
    clearShape() { shape = null; },
    /** Testing aid: fast-forward sky time as if `seconds` passed at 30 fps, then draw. */
    _step(seconds) {
      if (!layers[0]?.snaps) return;
      for (let i = 0, n = Math.round(seconds * 30); i < n; i++) {
        const sdt = effectiveSpeed() / 30; simTime += sdt; updatePlanes(sdt);
        for (const L of layers) advance(L);
      }
      composite();
    },
    /** PNG data URL of the current frame (null before the first frame). */
    snapshot() { if (needsSetup || !layers[0]?.snaps) return null; composite(); return canvas.toDataURL('image/png'); },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); clearTimeout(fallbackTimer);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      reduceMotion?.removeEventListener?.('change', onMotionPref);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      dprQuery?.removeEventListener('change', onDpr);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      container.style.position = savedStyle.position;
      container.style.isolation = savedStyle.isolation;
    },
  };
}
