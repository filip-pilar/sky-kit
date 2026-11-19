# sky-kit

Endless drifting painterly clouds on a bright blue sky, for the web (WebGL2, plain JS or React) and Apple platforms (Metal, SwiftUI). A real cloud can turn into a word, emoji or symbol, hold it, and melt back into itself, up to three at once. The web and Swift ports render the same image (mean difference about 0.13/255 per pixel).

Live demo, with the code for whatever you set: https://claude.ai/artifact/8YKLPNuAnkRtUnAR8u8f2e

![A real cloud turns into the word "hello", which morphs into "sky" and melts back into the cloud](docs/demo.webp)

## Facts

- **Web:** one ES module, `web/src/sky.js`. No dependencies, no build step. The API's source of truth is `web/src/sky.d.ts`. The React wrapper is `web/src/react.js`, typed in `react.d.ts`.
- **Swift:** a SwiftPM package at the repo root, library `SkyKit`, iOS 16+ and macOS 13+.
- **npm:** not published. Use jsDelivr or copy the file. `npm install github:filip-pilar/sky-kit` does not work: the repo root is a private workspace, not the library.
- **Version:** the latest tag is `v0.3.1`. Licence: MIT.
- **Cost:** a plain sky is about 0.6 ms of GPU per frame at iPhone resolution on an M4, 1 ms at 2880×1800. A shape on screen adds about 2–3 ms per repaint at iPhone resolution, 5–7 ms at 2880×1800.
- **When it draws:**
  - It draws 30 fps unless something moves more than about a point a frame (then up to `fps`, default 60).
  - It pauses when off-screen or when the tab is hidden.
  - It holds still under reduced motion.
- **Shapes:** built in a Web Worker on the web, and in the background by `SkyController` in Swift. Starting one doesn't stall the animation.

## Install

**Web, from GitHub through jsDelivr** (pin the tag):

```js
import { createSky } from 'https://cdn.jsdelivr.net/gh/filip-pilar/sky-kit@v0.3.1/web/src/sky.js';
```

**Web, copied into your project:** copy `web/src/sky.js` and, for TypeScript, `web/src/sky.d.ts`. For React, also copy `web/src/react.js` and `react.d.ts`; it imports `./sky.js` from the same folder.

**Swift**, in `Package.swift` or with Xcode › File › Add Package Dependencies:

```swift
.package(url: "https://github.com/filip-pilar/sky-kit", from: "0.3.1")   // product: "SkyKit"
```

## Web

```html
<div id="hero" style="height: 100vh">
  <h1>Content placed here sits on top of the sky</h1>
</div>
<script type="module">
  import { createSky } from 'https://cdn.jsdelivr.net/gh/filip-pilar/sky-kit@v0.3.1/web/src/sky.js';

  const sky = createSky(document.querySelector('#hero'), { coverage: 0.6, planes: true });
  sky.showShape({ text: 'hello' });                           // a nearby cloud turns into "hello", holds, turns back
  sky.showShape({ text: 'sky', queue: true, pause: 0 });      // then "hello" turns straight into "sky"
</script>
```

- **The container needs a size.** The canvas fills it, sits behind its content and ignores the pointer.
- **Container styles:** the container gets `isolation: isolate`. If it is `position: static` it becomes `relative`, checked again after the page loads, so a later stylesheet's `fixed` or `absolute` wins.
- **Defaults:** an option set to `undefined` means the default. `set()` leaves options you don't pass unchanged.

### Options (`createSky(container, options)`, `sky.set(options)`)

| Option | Default | Values |
|---|---|---|
| `speed` | `1` | 0 = still, 1 = gentle drift, 4 = brisk |
| `coverage` | `0.6` | 0 = almost clear … 1 = lots of cloud |
| `shadow` | `0.3` | shading inside clouds, 0 … 1 |
| `cloudScale` | `1` | cloud size multiplier |
| `direction` | `'left'` | `'left'`, `'right'` (changing it clears a shape) |
| `seed` | `0` | any number gives a different sky |
| `palette` | `'summer'` | `'summer'`, `'day'`, `'pastel'` |
| `skyTop`, `skyMid`, `skyLow` | `null` | hex colours that override the palette |
| `gradient` | `0` | 0 = even blue, 1 = deep blue fading to a pale horizon |
| `quality` | `'high'` | `'high'`, `'balanced'`, `'low'`: snapshot resolution |
| `fps` | `60` | most frames per second; it draws 30 while nothing moves faster than about a point a frame |
| `planes` | `false` | occasional planes with contrails |
| `trailLife` | `40` | seconds a contrail lingers |
| `respectReducedMotion` | `true` | hold still when the user prefers reduced motion |

### Methods

| Call | Does |
|---|---|
| `set(options)` | changes options live; colours, coverage and seed repaint at once |
| `pause()`, `play()` | stop and resume the drift |
| `flyPlane({ from, to }?)` | sends a plane; points are 0..1 of the view, y = 0 at the bottom; random if omitted |
| `showShape(shape)` | forms a shape (below); resolves once its image is built |
| `releaseShape(id?)` | melts the shape with that id (or all of them) back from wherever it is and drops its queue |
| `clearShape(id?)` | removes the shape with that id (or all of them) at once, with no melt |
| `shapeState` | the shape without an id: `{ phase, label, next }`; phase is `none`, `waiting`, `forming`, `holding` or `melting` |
| `shapeStates` | the same for every id in use: `{ [id]: state }` (`''` is the shape without an id) |
| `snapshot()` | PNG data URL of the current frame |
| `info` | diagnostics: frames drawn, context losses, the last GL error, sizes |
| `destroy()` | removes the canvas and restores the container |

### `showShape(shape)`

| Field | Default | |
|---|---|---|
| `text` / `symbol` / `image` | | one of: text or emoji; a built-in symbol (`heart`, `star`, `sun`, `moon`, `smile`, `music`, `bolt`, `infinity`); an image as a URL, `<img>`, canvas or `ImageBitmap` |
| `x`, `y` | `0.5`, `0.6` | where, 0..1 of the view (y = 0 at the bottom), for the middle of its hold (the clouds drift meanwhile); when given, the cloud right there is strongly preferred, so a tap can pick the cloud |
| `size` | `0.32` | height as a fraction of the view height; shrinks to fit 70% of the width |
| `form`, `hold`, `fade` | `5`, `5`, `7` | seconds; `hold: Infinity` holds until `releaseShape()` |
| `density` | `0.5` | 0 = wispy and see-through, 0.5 = like the clouds around, 1 = solid |
| `queue` | `false` | wait for the current shape to melt, then form on the same cloud |
| `pause` | `1` | with `queue`: seconds of plain cloud in between; `0` turns the current shape straight into this one |
| `id` | `''` | shapes with different ids are on screen side by side, each with its own queue and takeover; up to 3 at once |

How shapes behave:

- **Which cloud:** the shape forms on a real cloud near `x, y`. That cloud reshapes into it and back, and stays.
- **Call order wins:** a newer `showShape` (not queued) replaces an older one still loading its image, and queued ones keep their call order.
- **Several at once:** give each shape its own `id` (`showShape({ text: 'hi', id: 'left', x: 0.25 })`, `showShape({ symbol: 'star', id: 'right', x: 0.75 })`). Each id behaves like a single shape: its own takeover rules and its own queue. A new shape keeps off the other shapes' clouds and boxes. With 3 ids on screen, a 4th id takes over the one used longest ago. If there's no room beside the others (no cloud left for it, or its spot would overlap one), a new shape takes over the one used longest ago as well, so shapes never overlap: about two large words fit on a laptop-shaped view, three on a phone.
- **Calling `showShape` while a shape shows** takes over without a jump:
  - if that shape is holding, it turns into the new one now;
  - if it is still forming, as soon as it has formed;
  - if it is melting, the new one forms right after.
- **Images:** transparent ones use their alpha; opaque ones use dark = shape.
- **What reads well:** bold line icons form like letters. Filled images become solid clouds, so keep their features chunky.
- **Small parts:** every part keeps a solid core, down to a dot.
- **Ignored:** blank text or a blank image. Shapes need `speed > 0`.
- **Built-in symbols:** `SKY_SYMBOLS` holds the data, and `skySymbolSvg(name)` gives matching SVG for buttons.

### React

```jsx
import { useRef } from 'react';
import { Sky } from './sky-kit/react.js';   // react.js and sky.js side by side

function Hero() {
  const sky = useRef(null);
  return (
    <Sky ref={sky} coverage={0.6} style={{ height: 480 }}>
      <button onClick={() => sky.current.showShape({ text: 'hi' })}>Say hi</button>
    </Sky>
  );
}
```

- **Props** are the options above. Changing a prop updates the sky live, and removing one restores its default.
- **The ref** exposes `flyPlane`, `showShape`, `releaseShape`, `clearShape`, `shapeState`, `shapeStates`, `pause`, `play`, `snapshot`, `canvas` and `options`.
- **Compatibility:** React 17+, StrictMode and SSR (the sky is created in an effect). The wrapper has no JSX of its own.

## Swift

```swift
import SkyKit
import SwiftUI

struct ContentView: View {
    @StateObject private var sky = SkyController()

    var body: some View {
        SkyView(SkyOptions(coverage: 0.6, planes: true), controller: sky)
            .ignoresSafeArea()
            .onAppear { sky.showShape(.text("hello")) }
    }
}
```

- **`SkyOptions`** has the web option names and defaults. `colors: SkyColors(top:mid:low:)` replaces `skyTop`/`skyMid`/`skyLow`. Its initialiser takes arguments in declaration order. Changing the value passed to `SkyView` updates the sky live.
- **`SkyController`** has:
  - `showShape(.text("hi") | .symbol(.star) | .image(cgImage), x:y:size:form:hold:fade:density:queue:pause:id:)`, with the web defaults; `x`/`y` are optional (given = prefer the cloud there); `hold: .infinity` holds until released; `id` as on the web;
  - `releaseShape(id:)`, `clearShape(id:)` (no id = all), `flyPlane(from:to:)`, `shapeState`, `shapeStates`, `snapshot(width:height:)` (a `CGImage`).
- **When it draws:** the view stops drawing when nothing moves (speed 0 or Reduce Motion) and wakes when something changes.
- **`SkyRenderer`** is the Metal renderer on its own, for custom views or offscreen use. `renderImage(width:height:seconds:)` returns a `CGImage`. Its own `showShape` builds the mask on the calling thread (tens of ms); `SkyController` builds it in the background.
- **Command-line tools:**
  - `swift run -c release sky-render --seconds 9 --text hello --out sky.png` renders a still; its flags are at the top of `swift/Sources/sky-render/main.swift`.
  - `swift run -c release SkyDemo` opens a macOS window with every control.

## Known limits

- **Web needs WebGL2**, which every current browser has.
- **At most three shapes at once** (one per `id`). Within an id, a new one takes over, or waits with `queue: true`.
- **Strict Content-Security-Policy:** where it blocks `blob:` workers (`worker-src`), the web version builds shapes on the main thread, and the sky can stutter for a moment when one starts.
- **Days of running:** after several days of continuous running at speed 1, the cloud shading could get grainy (float precision of the noise coordinates).

## Repo map

```
web/src/sky.js         the web component (GLSL shaders in CLOUD_FS, COMPOSITE_FS)
web/src/react.js       React wrapper; *.d.ts are the typed API
web/examples/          index (several sizes), playground (every option), react, parity (vs the Swift render)
web/test/              regression scenes and behaviour checks, run by scripts/regress.ts
swift/Sources/SkyKit   SkyView, SkyController, SkyRenderer, SkyOptions, Metal shaders, shape masks, symbols
swift/Sources/         sky-render (CLI), SkyDemo (macOS app); swift/Tests/ unit tests
docs/ARCHITECTURE.md   how it works and why it is cheap
AGENTS.md              working on the code: conventions, commands, how to verify a change
```

To change the code, read [AGENTS.md](AGENTS.md) first. Examples run from the repo root with `bun run serve`, then `http://localhost:5173/web/examples/playground.html`.
