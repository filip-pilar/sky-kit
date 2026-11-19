# Working on sky-kit

One renderer, two ports written line for line the same:

- web: `web/src/sky.js` (WebGL2; the GLSL is in the template strings `CLOUD_FS` and `COMPOSITE_FS`), `react.js`, `*.d.ts`
- Swift: `swift/Sources/SkyKit` (Metal; the shaders are the string in `Shaders.swift`), plus `sky-render` (CLI) and `SkyDemo` (macOS app)

Change both ports together, with matching comments. Functions shared by name (`findCloud`, `sourceCells`, `edgeChannel`, `edt`, `SKY_SYMBOLS` / `SkySymbol`) must stay identical. How it all works: `docs/ARCHITECTURE.md`.

## Commands (repo root)

- `bun install` once (installs oxlint).
- `bun run check`: JS syntax and oxlint, `swift build`, `swift test`.
- `bun run regress:baseline` before a change, `bun run regress` after. Renders 21 scenes with both ports (sky-render, headless Chrome) and compares them pixel by pixel, then runs the web behaviour checks (`web/test/checks.js`: queue, clearing, pausing, morphs, destroy, with and without the shape worker). On one machine a refactor should be exact; a shader compiler may round a reordered expression by ±1–2 (`bun scripts/regress.ts check 2` allows that). Needs Google Chrome (`CHROME=` for another Chromium).
- iOS: `xcodebuild test -scheme SkyKit-Package -destination 'platform=iOS Simulator,name=<an installed iPhone>'` runs the Swift tests on a simulator (Metal included).
- `bun run serve`, then `http://localhost:5173/web/examples/playground.html` (also `index.html`, `react.html`, `parity.html`).
- `swift run -c release sky-render --seconds 9 --text hello --out swift/out/hello.png` renders a still (all flags: top of `swift/Sources/sky-render/main.swift`). `swift run -c release SkyDemo` opens the demo.

## Conventions

- No runtime dependencies and no build step: `web/src` is what gets published.
- Comments say why, in plain words; no commented-out code, no notes about past versions.
- The web shape worker is built from the source of the functions in `WORKER_FNS` (`sky.js`): anything `maskChannels` or `pickCloud` calls must be listed there.
- Shapes run in up to 3 lanes (`MAX_LANES` / `maxLanes`), each a slot of the cloud shader (`withShape` per slot, `withShapes` over them; in Metal, explicit `ShapeSlot` fields, no arrays, mirrored by the Swift struct). With one shape the slot math must stay exactly the old single-shape math, so existing renders don't change. `bun run regress` fails if the worker errors (otherwise the main-thread fallback would hide it).
- When behaviour changes, update `README.md` and `docs/ARCHITECTURE.md` too.
- For visual changes, look at the renders, not only the numbers: motion and morphs need several frames.
- To measure GPU cost, time Metal command buffers (`gpuEndTime - gpuStartTime`) around `SkyRenderer.update` and `draw` from a scratch Swift package; it does the same work as the web version. Browser timer queries are not reliable on ANGLE's Metal backend.
- Verify changes yourself (renders, measurements, headless checks); don't ask the user to test by hand.
