// Pixel regression check for both ports.
//
//   bun scripts/regress.ts baseline     render the scenes below with the current code (do this before a change)
//   bun scripts/regress.ts check [N]    render them again and compare with the baseline (exit 1 if a pixel differs by more than N/255)
//
// Swift scenes are rendered with sky-render, web scenes with headless Chrome (web/test/regress.html), into
// .regress/<baseline|current>/<swift|web>. Rendering is deterministic on one machine, so a pure refactor should
// give identical images; a Metal or GLSL compiler can still round a reordered expression differently (±1–2).
// Needs macOS (Metal) and Google Chrome (set CHROME to use another Chromium).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Scene = {
  name: string; seconds: number; width?: number; height?: number;
  seed?: number; coverage?: number; palette?: string; direction?: string; gradient?: number; plane?: boolean;
  words?: string[]; pause?: number; symbol?: string; heart?: boolean; size?: number; density?: number;
  form?: number; hold?: number; fade?: number; holdForever?: boolean; releaseAt?: number;
};

const SCENES: Scene[] = [
  { name: 'plain0', seconds: 0 },
  { name: 'plain30', seconds: 30 },
  { name: 'seed3cov2', seconds: 12, seed: 3, coverage: 0.2 },
  { name: 'cov9pastel', seconds: 12, coverage: 0.9, palette: 'pastel' },
  { name: 'dayright', seconds: 20, palette: 'day', direction: 'right', gradient: 0.6 },
  { name: 'plane10', seconds: 10, plane: true },
  { name: 'plane60', seconds: 60, plane: true },
  { name: 'hello3', seconds: 3, words: ['hello'] },
  { name: 'hello9', seconds: 9, words: ['hello'] },
  { name: 'hello14', seconds: 14, words: ['hello'] },
  { name: 'heart4', seconds: 4.5, heart: true },
  { name: 'heart9', seconds: 9, heart: true },
  { name: 'smile9', seconds: 9, symbol: 'smile', density: 0.9 },
  { name: 'star9', seconds: 9, symbol: 'star', density: 0.2 },
  { name: 'music9', seconds: 9, symbol: 'music', size: 0.4 },
  { name: 'morph12', seconds: 12.4, words: ['one', 'two'], pause: 0 },
  { name: 'morph30', seconds: 30, words: ['one', 'two'], pause: 0 },
  { name: 'pause22', seconds: 22.5, words: ['one', 'two'], pause: 3 },
  { name: 'release5', seconds: 5, heart: true, releaseAt: 3 },
  { name: 'forever24', seconds: 24, words: ['hello'], holdForever: true, releaseAt: 20 },
  { name: 'phone9', seconds: 9, width: 780, height: 1688, words: ['hello'] },
];

const root = resolve(import.meta.dir, '..');
const mode = process.argv[2];
if (mode !== 'baseline' && mode !== 'check') {
  console.error('usage: bun scripts/regress.ts baseline | check [tolerance]');
  process.exit(2);
}
const tolerance = Number(process.argv[3] ?? 0);
const outDir = join(root, '.regress', mode === 'baseline' ? 'baseline' : 'current');
rmSync(outDir, { recursive: true, force: true });
for (const port of ['swift', 'web']) mkdirSync(join(outDir, port), { recursive: true });

const run = (cmd: string, args: string[], opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  return r.stdout;
};

// Swift: sky-render, one process per scene
run('swift', ['build', '-c', 'release', '--product', 'sky-render']);
const skyRender = join(root, '.build/release/sky-render');
for (const s of SCENES) {
  const f: string[] = ['--width', String(s.width ?? 1600), '--height', String(s.height ?? 1000), '--seconds', String(s.seconds)];
  const opt = (flag: string, v: unknown) => { if (v !== undefined) f.push(flag, String(v)); };
  opt('--seed', s.seed); opt('--coverage', s.coverage); opt('--palette', s.palette); opt('--direction', s.direction); opt('--gradient', s.gradient);
  if (s.plane) f.push('--plane');
  if (s.words) f.push('--text', s.words.join(','));
  opt('--pause', s.pause); opt('--symbol', s.symbol); opt('--size', s.size); opt('--density', s.density);
  opt('--form', s.form); opt('--hold', s.hold); opt('--fade', s.fade);
  if (s.heart) f.push('--heart');
  if (s.holdForever) f.push('--hold-forever');
  opt('--release-at', s.releaseAt);
  run(skyRender, [...f, '--out', join(outDir, 'swift', s.name + '.png')]);
}

// Web: serve the repo, render every scene in one headless Chrome page, decode the PNGs it prints
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = join(root, decodeURIComponent(new URL(req.url).pathname));
    return path.startsWith(root) && existsSync(path) ? new Response(Bun.file(path)) : new Response('not found', { status: 404 });
  },
});
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = join(outDir, 'chrome-profile');
const url = `http://127.0.0.1:${server.port}/web/test/regress.html?scenes=${encodeURIComponent(JSON.stringify(SCENES))}`;
// (spawned asynchronously: a blocking spawn would also block the server Chrome loads the page from)
const browser = Bun.spawn([chrome, '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--use-angle=metal', '--enable-gpu',
  '--ignore-gpu-blocklist', '--window-size=800,500', '--force-device-scale-factor=2', '--virtual-time-budget=600000', '--dump-dom', url],
  { stdout: 'pipe', stderr: 'ignore' });
const dom = await new Response(browser.stdout).text();
await browser.exited;
server.stop(true);
rmSync(profile, { recursive: true, force: true });
const out = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1] ?? '';
let written = 0;
for (const line of out.trim().split('\n')) {
  const [name, dataUrl] = line.split(' ');
  if (!dataUrl?.startsWith('data:image/png;base64,')) { console.error('no image for', name); process.exit(1); }
  writeFileSync(join(outDir, 'web', name + '.png'), Buffer.from(dataUrl.slice(22), 'base64'));
  written++;
}
if (written !== SCENES.length) { console.error(`web rendered ${written} of ${SCENES.length} scenes`); process.exit(1); }
console.log(`rendered ${SCENES.length} scenes per port into ${outDir}`);

if (mode === 'check') {
  const base = join(root, '.regress', 'baseline');
  if (!existsSync(base)) { console.error('no baseline: run `bun scripts/regress.ts baseline` first (before your change)'); process.exit(1); }
  let failed = false;
  for (const port of ['swift', 'web']) {
    console.log(`\n${port}:`);
    const r = spawnSync(skyRender, ['--compare', join(base, port), join(outDir, port), '--tolerance', String(tolerance)], { encoding: 'utf8' });
    process.stdout.write(r.stdout);
    if (r.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
