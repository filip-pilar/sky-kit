/**
 * sky-kit — endless drifting painterly clouds on a bright blue sky.
 *
 *   import { createSky } from 'sky-kit';
 *   const sky = createSky(document.querySelector('#hero'), { coverage: 0.6 });
 *   sky.set({ speed: 2 });  sky.pause();  sky.play();  sky.destroy();
 *
 * The sky fills `container` at full device resolution, redraws on resize, pauses when the
 * container is off-screen or the tab is hidden, and holds still for reduced-motion users.
 *
 * How it stays cheap: each cloud layer is painted into a snapshot image a bit wider than the
 * view. Every frame only slides those images and crossfades to the next snapshot (DT seconds
 * of sky time ahead), which is painted a strip per frame in the background.
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
  quality: 'high',       // 'high' | 'balanced' | 'low' — resolution of the cloud snapshots
  fps: 60,               // frame cap
  respectReducedMotion: true,
};

const REBUILD_KEYS = ['coverage', 'shadow', 'seed', 'direction', 'palette', 'skyTop', 'skyMid', 'skyLow', 'cloudScale', 'quality'];
const QUALITY = { high: 1.25, balanced: 1.0, low: 0.75 };   // snapshot pixels per CSS pixel
const DT = 2.0;       // seconds of sky time between snapshots
const STRIPS = 24;    // frames used to paint one snapshot
const MARGIN = 0.3;   // extra cloud space on each side of the view, in cloud units
const LAYERS = [
  { scale: 0.6, seed: [41.3, 7.7], speed: 0.006, morph: 0.004, haze: 0.35, farMask: 1 },
  { scale: 1.1, seed: [13.7, 5.3], speed: 0.016, morph: 0.008, haze: 0.0,  farMask: 0 },
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
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 skyAt(float v){          // v: 0 = bottom of view, 1 = top
  vec3 c = mix(uSkyLow, uSkyMid, smoothstep(0.0, 0.5, v));
  return mix(c, uSkyTop, smoothstep(0.4, 1.0, v));
}`;

const CLOUD_FS = `#version 300 es
precision highp float;
uniform vec2 uWin0;           // cloud-space position of the snapshot's bottom-left pixel
uniform float uUpp;           // cloud units per snapshot pixel
uniform float uViewH;         // view height in cloud units
uniform float uMorph, uScale, uCov, uShadow, uHaze, uFarMask;
uniform vec2 uSeed;
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
vec2 cumulus(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 3), fbm(q * 0.5 + 5.2 - morph, 3));
  float base = fbm(q * 0.7 + w * 0.6, 4);
  float bil = billow(q * 2.0 + w, 3);
  float v = base + 0.15 * (bil - 0.35);
  float thr = mix(0.22, -0.12, cov);
  float D = smoothstep(thr, thr + 0.22, v);
  float dome = smoothstep(thr, thr + 0.7, v);
  return vec2(D, (0.05 * dome + 0.012 * D * bil) * scale);
}
float cumulusLite(vec2 p, float scale, vec2 seed, float cov, float morph){
  vec2 q = p * vec2(2.2, 3.4) / scale + seed;
  vec2 w = vec2(fbm(q * 0.5 + morph, 2), fbm(q * 0.5 + 5.2 - morph, 2));
  float v = fbm(q * 0.7 + w * 0.6, 3);
  float thr = mix(0.22, -0.12, cov);
  return smoothstep(thr, thr + 0.22, v);
}
void main(){
  vec2 p = uWin0 + gl_FragCoord.xy * uUpp;
  float vv = p.y / uViewH;
  vec3 sky = skyAt(vv);
  float cov = uCov * mix(1.0, 0.75 + 0.35 * smoothstep(0.8, 0.1, vv), uFarMask);
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
uniform vec4 uFar, uNear;     // (window start A, window start B, window width, fade)
uniform vec2 uScroll;
out vec4 outColor;
${COMMON}
vec4 layerAt(sampler2D A, sampler2D B, vec4 w, float scroll, vec2 p){
  float cx = p.x + scroll;
  float vy = p.y / uViewH;
  vec4 a = texture(A, vec2((cx - w.x) / w.z, vy));
  vec4 b = texture(B, vec2((cx - w.y) / w.z, vy));
  return mix(a, b, w.w);
}
void main(){
  vec2 p = gl_FragCoord.xy / uUnit;               // cloud units
  vec2 ph = gl_FragCoord.xy / uRes.y;             // view-height units (for the sun glow)
  vec3 col = skyAt(gl_FragCoord.y / uRes.y);
  float sd = length(ph - vec2(0.10 * uRes.x / uRes.y, 1.05));
  col += vec3(1.0, 0.97, 0.88) * (0.20 * exp(-sd * 2.2) + 0.22 * exp(-sd * 9.0));
  vec4 far = layerAt(uFarA, uFarB, uFar, uScroll.x, p);
  col = col * (1.0 - far.a) + far.rgb;
  vec4 near = layerAt(uNearA, uNearB, uNear, uScroll.y, p);
  col = col * (1.0 - near.a) + near.rgb;
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

export function createSky(container, options = {}) {
  const S = { ...SKY_DEFAULTS, ...options };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  canvas.setAttribute('aria-hidden', 'true');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.insertBefore(canvas, container.firstChild);

  let gl = null, cloudProg = null, compProg = null;
  let layers = [];
  let unit = 1, viewH = 1, cacheW = 0, cacheH = 0, winW = 0;
  let simTime = 0, last = 0, lastDraw = 0, raf = 0;
  let needsSetup = true, needsRebuild = false, needsDraw = true;
  let userPaused = false, inView = true, destroyed = false, lost = false;
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
  function initGL() {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('sky-kit needs WebGL2');
    cloudProg = program(CLOUD_FS); compProg = program(COMPOSITE_FS);
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    layers = LAYERS.map(L => ({ ...L, snaps: null }));
    needsSetup = true;
  }
  function makeSnap() {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cacheW, cacheH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, time: 0, x0: 0, strip: STRIPS };
  }
  const freeSnap = s => { gl.deleteTexture(s.tex); gl.deleteFramebuffer(s.fb); };
  const layerSeed = L => [L.seed[0] + S.seed * 7.31, L.seed[1] + S.seed * 3.17];
  function place(L, snap, time) { snap.time = time; snap.x0 = dir() * L.speed * time - MARGIN; }
  function setSkyUniforms(u) { const [t, m, l] = colors(); gl.uniform3fv(u.uSkyTop, t); gl.uniform3fv(u.uSkyMid, m); gl.uniform3fv(u.uSkyLow, l); }
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
    winW = canvas.width / unit + 2 * MARGIN;
    cacheW = Math.ceil(winW / upp);
    winW = cacheW * upp;
    for (const L of layers) {
      if (L.snaps) L.snaps.forEach(freeSnap);
      L.snaps = [makeSnap(), makeSnap(), makeSnap()];
      L.snaps.forEach((s, k) => place(L, s, simTime + k * DT));
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
    const win = L => [L.snaps[0].x0, L.snaps[1].x0, winW, Math.min(1, Math.max(0, (simTime - L.snaps[0].time) / DT))];
    gl.uniform4fv(u.uFar, win(F)); gl.uniform4fv(u.uNear, win(N));
    gl.uniform2f(u.uScroll, dir() * F.speed * simTime, dir() * N.speed * simTime);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    if (moving) simTime += dt * effectiveSpeed();
    for (const L of layers) advance(L);
    composite();
    lastDraw = now; needsDraw = false;
    if (moving) schedule();
  }
  function schedule() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }
  function redraw() { needsDraw = true; last = 0; schedule(); }

  // ---------- observers ----------
  const ro = new ResizeObserver(redraw); ro.observe(container);
  const io = new IntersectionObserver(es => { inView = es[es.length - 1].isIntersecting; if (inView) redraw(); });
  io.observe(container);
  const onVis = () => { if (!document.hidden) redraw(); };
  document.addEventListener('visibilitychange', onVis);
  reduceMotion?.addEventListener?.('change', redraw);
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; if (raf) cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', () => { lost = false; initGL(); redraw(); });

  initGL();
  redraw();

  return {
    canvas,
    get options() { return { ...S }; },
    set(o) {
      const sizeChange = ('cloudScale' in o && o.cloudScale !== S.cloudScale) || ('quality' in o && o.quality !== S.quality);
      const rebuild = REBUILD_KEYS.some(k => k in o && o[k] !== S[k]);
      Object.assign(S, o);
      if (sizeChange) needsSetup = true;
      else if (rebuild && layers[0]?.snaps) needsRebuild = true;
      redraw();
    },
    pause() { userPaused = true; },
    play() { userPaused = false; redraw(); },
    /** PNG data URL of the current frame (null before the first frame). */
    snapshot() { if (needsSetup || !layers[0]?.snaps) return null; composite(); return canvas.toDataURL('image/png'); },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      reduceMotion?.removeEventListener?.('change', redraw);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
