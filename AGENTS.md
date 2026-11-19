# Working on sky-kit

One renderer, two ports written line for line the same:

- web: `web/src/sky.js` (WebGL2; the GLSL is in the template strings `CLOUD_FS` and `COMPOSITE_FS`), `react.js`, `*.d.ts`
- Swift: `swift/Sources/SkyKit` (Metal; the shaders are the string in `Shaders.swift`), plus `sky-render` (CLI) and `SkyDemo` (macOS app)

Change both ports together, with matching comments. Functions shared by name (`findCloud`, `sourceCells`, `edgeChannel`, `edt`, `SKY_SYMBOLS` / `SkySymbol`) must stay identical. How it all works: `docs/ARCHITECTURE.md`.

## Commands (repo root)

- `bun install` once (installs oxlint).
- `bun run check`: JS syntax and oxlint, `swift build`, `swift test` (two tests: Swift's lanes for several ids, and the controller keeping call order).
- `bun run regress:baseline` before a change, `bun run regress` after. Renders 24 scenes with both ports (sky-render, headless Chrome) and compares them pixel by pixel, then runs the web behaviour checks (`web/test/checks.js`: the queue, clearing mid-placement, newer calls winning, several ids, with and without the shape worker), and compares the two ports with each other on every scene without text. On one machine a refactor should be exact; a shader compiler may round a reordered expression by ±1–2 (`bun scripts/regress.ts check 2` allows that). Needs Google Chrome (`CHROME=` for another Chromium).
- iOS: `xcodebuild test -scheme SkyKit-Package -destination 'platform=iOS Simulator,name=<an installed iPhone>'` runs the Swift tests on a simulator (Metal included).
- `bun run serve`, then `http://localhost:5173/web/examples/playground.html` (also `index.html`, `react.html`).
- `bun run demo` builds `demo/sky-kit-demo.html` (not committed), the page published as the live demo linked in the README. When you tag a release, bump the jsDelivr tag in `demo/head.html` and `demo/tail.html`.
- `swift run -c release sky-render --seconds 9 --text hello --out swift/out/hello.png` renders a still (all flags: top of `swift/Sources/sky-render/main.swift`). `swift run -c release SkyDemo` opens the demo (macOS; click a cloud to form a shape there).

## Conventions

- No runtime dependencies and no build step: `web/src` is what gets published.
- Comments say why, in plain words; no commented-out code, no notes about past versions.
- The web shape worker is built from the source of the functions in `WORKER_FNS` (`sky.js`): anything `maskChannels` or `pickCloud` calls must be listed there.
- Shapes run in up to 3 lanes (`MAX_LANES` / `maxLanes`), each a slot of the cloud shader (`withShape` per slot, `withShapes` over them; in Metal, explicit `ShapeSlot` fields, no arrays, mirrored by the Swift struct). With one shape the slot math must stay exactly the old single-shape math, so existing renders don't change. `bun run regress` fails if the worker errors (otherwise the main-thread fallback would hide it).
- When behaviour changes, update `README.md` and `docs/ARCHITECTURE.md` too.
- For visual changes, look at the renders, not only the numbers: motion and morphs need several frames.
- To measure GPU cost, time Metal command buffers (`gpuEndTime - gpuStartTime`) around `SkyRenderer.update` and `draw` from a scratch Swift package; it does the same work as the web version. Browser timer queries are not reliable on ANGLE's Metal backend.
- Verify changes yourself (renders, measurements, headless checks); don't ask the user to test by hand.
- Never call the cloud shader's noise on an absolute cloud-space position: each `fbm`/`billow` call is a chain with its large part in `noiseOrigins` (both ports), so a new noise call means a new chain there. Positions sent to the shader are relative to the draw's x origin.
- Tests: only what the scenes can't see. Add a scene to `scripts/regress.ts` rather than a unit test where a render shows it.
- Verifying, without overdoing it:
  - `bun run regress` once after a change and once before committing, not after every step; again only if something failed or the shaders changed.
  - Measure before you build: if a feature or fix might not matter, check its effect with a quick throwaway test first, and only then add it to both ports and the docs.
  - GPU timing is noisy on this Mac: run old and new back to back once or twice; if the difference is inside the noise, say so and move on.
  - Edge cases that need unusual conditions (like running for weeks): first say how likely they are and what the fix would cost, and let the user choose between "fix" and "just document it".
