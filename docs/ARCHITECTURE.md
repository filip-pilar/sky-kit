# How sky-kit works

## The look

One cloud recipe ("natural cumulus") with painterly shading, in two depth layers:

| Layer | Size | Drift (cloud units/s) | Shape change | Haze |
|---|---|---|---|---|
| far | 0.6 | 0.006 | 0.004 | 0.35, mostly low in the sky |
| near | 1.1 | 0.016 | 0.008 | none |

**Cloud recipe** (`cumulus()`): domain-warped fractal noise plus a little billowy noise, thresholded by coverage. It returns *density* (how much cloud, drives transparency) and *height* (a bump height in cloud units, drives shading). A wide second threshold (`dome`) gives every cloud a rounded overall shape so its inside isn't flat.

**Shading** (cloud fragment shader):
- light from the upper left, a soft two-band ramp between `SHADE` (pastel blue, never grey) and `LIT` (warm white)
- self-shadow: four cheap density lookups toward the sun; only points deep inside, away from the sun, get shaded
- warm glow on sun-facing edges, sky colour bleeding into the far side of edges, faint paper grain
- distant layer fades toward the sky colour

**Cloud units.** Positions are measured in "cloud units": normally one unit = the view height, clamped between `width/2.4` and `0.9 × width` so short banners and tall phones still get sensible cloud sizes (`cloudUnit()`, same formula in both ports).

## Why it is cheap

The cloud shader is expensive (about 80 noise evaluations per pixel). It doesn't run per screen pixel per frame:

1. Each layer keeps **three snapshot textures**, A, B and C, a bit wider than the view (0.3 cloud units of margin each side), at about 1.25 px per CSS pixel (`quality`).
2. A shows the clouds at sky time `t`, B one step later (2 s), both already scrolled to where the view will be at that time.
3. **Every frame** the composite shader only slides A and B and crossfades from A to B over the 2 s. That's 4 texture reads per pixel. The slide offset (`speed × time − snapshot start`) is subtracted on the CPU in double precision, so it stays exact however long the sky runs.
4. Meanwhile C (`t + 4 s`) is painted **one vertical strip per frame**, 24 strips per snapshot, so no frame does a full paint.
5. When time passes B, the snapshots rotate: A ← B ← C, and the old A becomes the new C.

Measured on an M4 at 2880×1800: about 2 ms per frame (vs. 35–40 ms if the cloud shader ran per pixel). With every web extra active, about 3.7 ms at 2560×1600.

Changing `coverage`, `shadow`, `seed`, `direction` or colours repaints all snapshots at once (a short hitch); `cloudScale` or `quality` reallocates them.

## Extras (all cheap; same in web and Swift)

- **Planes**: composite-shader overlay between the far and near layers (near clouds pass in front). Two engine trails that merge, widen, wobble, drift with the far layer and fade over `trailLife` seconds.
- **Shapes**: text or an image becomes a silhouette (160 px tall), blurred four ways and uploaded as one RGBA texture placed in the near layer's *cloud space*, so it drifts with the clouds: R = the shape (soft blur), G = a near halo, B = the shape's body (very wide blur), A = the **wide area** it gathers from and dissolves into (a blur about the shape's height, flattened with a square root so it reaches well out, and faded to exactly zero over the outer part of the mask's margin). The margin is 1.4× the shape's height on every side. The wide blurs run at half or quarter resolution and the build yields between blurs, so the sky keeps animating while a shape is prepared (about 100 ms of work in the browser). While a shape is on screen, the near clouds over the on-screen part of its area are rendered **live every frame** into a patch (same resolution and cloud function as the snapshots, clipped to the view plus the blend border) and blended in with a soft border inside the mask's all-zero margin, so there is no seam. The shape only changes the cloud *density* before it is thresholded and shaded, so the shape and the clouds around it are one cloud with one lighting. **Forming** (`form` seconds): the clouds of the wide area drift in toward the shape along the wide blur's slope and fade as they arrive, the far layer's clouds in the area fade too, a lumpy cumulus bank gathers over the shape, and the shape condenses out of it puff by puff; by the end the sky around the shape is clear. **Melting** (`fade` seconds) mirrors it: the shape spreads outward (thick shapes more than thin strokes) and turns back into a lumpy bank, the bank spreads and breaks into puffs, and the drift relaxes, so the clouds flow back out and the sky returns exactly to what it would have been. The finished shape is built like the other clouds: its rim fades out slowly instead of ending on the silhouette, and thick shapes (a heart, an emoji) get a domed body that shades round and cauliflower lumps along the outline, while thin strokes (text) keep enough density to stay readable. Cost at 2560×1600: about +1 ms per frame for a word, about +4 ms for a big solid shape, nothing when no shape is showing. Changing `direction` clears a shape. In Swift the silhouette comes from CoreText (SF Pro Rounded, heavy) or a `CGImage`, blurred with the same box-blur code (`ShapeMask.swift`); the renderer paints the live patch in `draw(to:)`, just before the composite pass.

## Web ↔ Metal conventions

The Metal shaders (`swift/Sources/SkyKit/Shaders.swift`) are a line-for-line port. Differences handled in the port:

- Metal's fragment position has its origin at the top-left; the shaders convert to GL-style coordinates first: `frag = (pos.x, targetHeight - pos.y)`.
- `dfdy` follows the flipped axis, so its sign is negated.
- Metal texture row 0 is the top, so snapshots are sampled at `v = 1 - y`.
- Fast math is turned off at runtime compile so the noise hash produces the same numbers.
- Parameter blocks are all `float4`, so the Swift and Metal struct layouts match without padding surprises.

Verify after any shader change with `web/examples/parity.html` (see README).
