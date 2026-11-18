# sky-kit

Endless drifting painterly clouds on a bright blue sky — for the web (WebGL2, plain JS or React) and for Apple platforms (Metal, SwiftUI). Same look on both: the Swift port matches the web version to within 0.12/255 per pixel on average.

![preview](docs/preview.png)

- Fills whatever container you put it in, at full device resolution.
- Cheap: about 2 ms per frame at 2880×1800 on an M4 (clouds are painted into snapshots that slide, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- Pauses when off-screen or when the tab is hidden; holds still for reduced-motion users.
- Web extras: the pointer gently pushes clouds; planes with contrails; text, emoji or SVG shapes that form out of the clouds and melt back.

## Web

No build step and no dependencies: `web/src/sky.js` is a plain ES module.

```js
import { createSky } from './web/src/sky.js';   // or 'sky-kit' once installed

const sky = createSky(document.querySelector('#hero'), { coverage: 0.6, interactive: true });
sky.set({ palette: 'pastel', speed: 2 });   // change anything live
sky.showShape({ text: 'hello' });           // clouds gather into "hello", hold, then melt back
sky.flyPlane();
sky.destroy();
```

The container needs a size (any CSS size). Overlay content can go inside it; the sky canvas sits underneath and ignores pointer events.

### React

```jsx
import { Sky } from 'sky-kit/react';

function Hero() {
  const sky = useRef(null);
  return (
    <Sky ref={sky} coverage={0.6} interactive style={{ height: 480 }}>
      <h1>Overlay content</h1>
      <button onClick={() => sky.current.showShape({ text: 'hi' })}>Say hi</button>
    </Sky>
  );
}
```

Props are the options below; changing a prop updates the sky live. The wrapper is plain JS (`createElement`, no JSX), works with React 17+, StrictMode and SSR (the sky is created in an effect). TypeScript types are included (`sky.d.ts`, `react.d.ts`).

### Options

| Option | Default | |
|---|---|---|
| `speed` | `1` | 0 = still, 1 = gentle drift, 4 = brisk |
| `coverage` | `0.6` | 0 = almost clear … 1 = lots of cloud |
| `shadow` | `0.3` | shading inside clouds |
| `cloudScale` | `1` | cloud size multiplier |
| `direction` | `'left'` | `'left'` or `'right'` |
| `seed` | `0` | any number gives a different sky |
| `palette` | `'day'` | `'day'`, `'summer'`, `'pastel'` |
| `skyTop`, `skyMid`, `skyLow` | `null` | custom hex colours, override the palette |
| `quality` | `'high'` | `'high'`, `'balanced'`, `'low'` (snapshot resolution) |
| `fps` | `60` | frame cap |
| `interactive` | `false` | pointer movement pushes clouds, which settle back |
| `planes` | `false` | occasional planes with contrails |
| `trailLife` | `40` | seconds a contrail lingers |
| `respectReducedMotion` | `true` | hold still when the user prefers reduced motion |

Methods: `set(options)`, `pause()`, `play()`, `flyPlane({ from, to }?)`, `showShape({ text | image, x, y, size, form, hold, fade })`, `clearShape()`, `snapshot()` (PNG data URL), `destroy()`.

`showShape` accepts text/emoji or an image (URL, `<img>`, canvas): transparent images use their alpha, opaque ones use dark = shape. Shapes form as the sky moves, so they need `speed > 0`.

### Examples

Serve the repo root with any static server, e.g. `python3 -m http.server 5173`, then open:

- `web/examples/index.html` — one component in a hero, cards, a phone-shaped box and a banner
- `web/examples/playground.html` — every option and extra, with controls
- `web/examples/react.html` — React (loaded from esm.sh, no build)
- `web/examples/parity.html` — pixel comparison against the Swift render (see below)

## Swift (iOS 16+, macOS 13+)

Swift Package in `swift/`. Add it as a local package (or by URL once hosted), then:

```swift
import SkyKit

struct ContentView: View {
    @State private var options = SkyOptions(coverage: 0.6)
    var body: some View {
        SkyView(options).ignoresSafeArea()
    }
}
```

`SkyOptions` has the same names and defaults as the web options (`speed`, `coverage`, `shadow`, `cloudScale`, `direction`, `seed`, `palette`, `colors`, `quality`, `fps`, `respectReducedMotion`). Changing the value updates the sky live.

Also included:

- `SkyRenderer` — the Metal renderer on its own, for custom views or offscreen use. `renderImage(width:height:seconds:)` returns a `CGImage` (wallpapers, thumbnails, tests).
- `swift run SkyDemo` — a macOS window with the sky and a few controls.
- `swift run sky-render --width 1600 --height 1000 --seconds 30 --out sky.png` — render a still from the command line.

Not in the Swift version yet: pointer push, planes and shapes (web only for now).

## Keeping web and Swift identical

The shaders exist twice: GLSL in `web/src/sky.js`, Metal in `swift/Sources/SkyKit/Shaders.swift`, written line for line the same. After changing either:

```bash
cd swift && swift run sky-render --width 1600 --height 1000 --seconds 30 --out out/swift-30s.png
```

then open `web/examples/parity.html` in a browser at device pixel ratio 2. It renders the same frame in WebGL and compares every pixel. Current result: mean difference 0.116/255, max 8/255, no pixels more than 8 apart.

## Layout

```
web/src/sky.js        component (WebGL2)          web/src/react.js   React wrapper
web/src/*.d.ts        TypeScript types            web/examples/      demos and the parity check
swift/Sources/SkyKit  SkyView, SkyRenderer, SkyOptions, Metal shaders
swift/Sources/sky-render, SkyDemo                 command-line renderer, macOS demo
docs/ARCHITECTURE.md  how it works
```

No licence has been chosen yet.
