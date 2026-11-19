// Serves the repo root for the examples: bun run serve, then http://localhost:5173/web/examples/playground.html
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const port = Number(process.env.PORT ?? 5173);
Bun.serve({
  port,
  fetch(req) {
    let path = join(root, decodeURIComponent(new URL(req.url).pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    return path.startsWith(root) && existsSync(path) ? new Response(Bun.file(path)) : new Response('not found', { status: 404 });
  },
});
console.log(`serving ${root} at http://localhost:${port}/web/examples/playground.html`);
