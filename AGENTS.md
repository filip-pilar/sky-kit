# Working on sky-kit

One renderer, two ports written line for line the same:

- web: `web/src/sky.js` (WebGL2; the GLSL is in the template strings `CLOUD_FS` and `COMPOSITE_FS`), `react.js`, `*.d.ts`
- Swift: `swift/Sources/SkyKit` (Metal; the shaders are the string in `Shaders.swift`), plus `sky-render` (CLI) and `SkyDemo` (macOS app)

Change both ports together, with matching comments. Functions shared by name (`findCloud`, `sourceCells`, `edgeChannel`, `edt`, `SKY_SYMBOLS` / `SkySymbol`) must stay identical. How it all works: `docs/ARCHITECTURE.md`.

## Commands (repo root)

- `bun install` once (installs oxlint).
- `bun run check`: JS syntax and oxlint, `swift build`, `swift test`.
- `bun run regress:baseline` before a change, `bun run regress` after. Renders 21 scenes with both ports (sky-render, headless Chrome) and compares them pixel by pixel. On one machine a refactor should be exact; a shader compiler may round a reordered expression by ±1–2 (`bun scripts/regress.ts check 2` allows that). Needs Google Chrome (`CHROME=` for another Chromium).
- `bun run serve`, then `http://localhost:5173/web/examples/playground.html` (also `index.html`, `react.html`, `parity.html`).
- `swift run -c release sky-render --seconds 9 --text hello --out swift/out/hello.png` renders a still (all flags: top of `swift/Sources/sky-render/main.swift`). `swift run -c release SkyDemo` opens the demo.

## Conventions

- No runtime dependencies and no build step: `web/src` is what gets published.
- Comments say why, in plain words; no commented-out code, no notes about past versions.
- When behaviour changes, update `README.md` and `docs/ARCHITECTURE.md` too.
- For visual changes, look at the renders, not only the numbers: motion and morphs need several frames.
