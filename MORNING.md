# What happened overnight

The sky you approved is now a small repo: a web package (plain JS + React) and a Swift package (Metal + SwiftUI) that draw the same sky, both with the same extras. Everything is committed locally on `main` (`git log` for the steps); nothing was pushed anywhere.

## Try it (5 minutes)

```bash
cd sky-kit && python3 -m http.server 5173
```

- http://localhost:5173/web/examples/playground.html — everything, with controls. Move the pointer over the sky, try "Form text", "Form a heart", "Fly a plane now".
- http://localhost:5173/web/examples/index.html — the same component in a hero, cards, a phone-shaped box and a banner.
- http://localhost:5173/web/examples/react.html — React version.

```bash
cd sky-kit/swift && swift run SkyDemo
```

opens a macOS window with the native (Metal) sky, with planes and text shapes.

## What's new

- **Same look, any container.** Cloud size now adapts to the container's shape, so banners and phones get sensible clouds. Three palettes (day, summer, pastel, all bright blue), plus a quality setting.
- **Extras.** These are on both web and Swift:
  - the pointer or a finger gently pushes the clouds, which then settle back
  - occasional planes with contrails that drift and fade
  - text, emoji or SVG/PNG shapes that condense out of the clouds, hold, then melt back into ordinary clouds
- **React wrapper.** `<Sky coverage={0.6} interactive />`, with a ref for `showShape` and `flyPlane`. It needs no build step and ships with TypeScript types.
- **Swift package.** It contains:
  - `SkyView` and `SkyController` for SwiftUI on iOS 16+ and macOS 13+
  - `SkyRenderer` for Metal directly
  - `sky-render`, a command-line tool that renders PNGs
  - `SkyDemo`, a demo app
- **Web and Swift match.** At the same moment, the two renders differ by 0.116/255 per pixel on average, with no pixel more than 8/255 apart. With the extras, only the letter shapes differ, because the two systems draw the font slightly differently.
- **Performance** on an M4: about 2 ms per frame at 2880×1800, and about 3.7 ms with every extra running.
- **An independent code review** found two real bugs plus some smaller issues. All are fixed and re-verified:
  - overlay text could be hidden under the sky
  - removed or `undefined` options didn't reset to their defaults
  - the push could smear the edges
  - a shape got lost after a direction change
  - the Swift view never idled
  - precision on very long runs

## Not verified

- I could only check the Swift demo app and `SkyView` by building them. I couldn't watch them run, because your window was closed, so it's worth a quick `swift run SkyDemo`.
- iOS was build-checked only, not run in a simulator.
- Everything was tested in Chrome. Safari and Firefox are untested.
- No licence chosen yet.

## Where the files are

All of this is in the folder the app made for this session. Deleting this session also deletes that folder. Ask me to move it to a folder of your choice to keep it.
