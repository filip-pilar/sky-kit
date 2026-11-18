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
- **Shapes**: text or an image becomes a silhouette (100 px tall: the mask is heavily blurred, so more pixels buy nothing), blurred four ways and uploaded as one RGBA texture placed in the near layer's *cloud space*, so it drifts with the clouds: R = the shape (soft blur), G = a near halo, B = the shape's body (very wide blur), A = the **wide area** it gathers from and dissolves into (a blur about 1.2× the shape's height, flattened with a square root so it reaches well out, and faded to exactly zero over the outer 17% of the mask's margin). The margin is 2.2× the shape's height on every side. The narrower blurs only run on the box they can reach and the wide ones at half or quarter resolution; the build yields between steps, so the sky keeps animating while a shape is prepared (50–130 ms of work in the browser, in steps of at most ~35 ms). While a shape is on screen, the near clouds over the on-screen part of its area are rendered **live every frame** into a patch (same resolution and cloud function as the snapshots, clipped to the view plus the blend border) and blended in inside the mask's all-zero margin, so there is no seam. The shape only changes the cloud *density* before it is thresholded and shaded, so the shape and the clouds around it are one cloud with one lighting. **Forming** (`form` seconds): every cloud of the wide area gives some of itself to the shape, more the closer it is: it drifts in a little along the wide blur's slope and shrinks (its edge sharpens as it loses density, so it gets smaller instead of see-through), and right around the shape it is used up, in step with the shape growing; cloud that drifts over the shape is cut to its outline and becomes part of it; the shape's own puffs condense one by one, much sooner where cloud has arrived. There is no intermediate blob. The far layer's clouds fade the same way (no drift: displacing their snapshots would squeeze them into streaks). **Melting** (`fade` seconds): the shape breaks into puff-sized pieces (stroke-sized for text) that drift outward a little and shrink, while the surrounding clouds come back from the shape outward behind a ragged front, a touch thicker where the pieces reach them; the drift relaxes as each cloud is given back, so it returns where it was, and the sky ends exactly as it would have been without the shape. The finished shape is built like the other clouds: its rim fades out slowly instead of ending on the silhouette, and thick shapes (a heart, an emoji) get a domed body that shades round and cauliflower lumps along the outline, while thin strokes (text) keep enough density to stay readable. The four self-shadow samples use a cheaper version of the shape (no fine noise). Cost at 2560×1600: about +3 ms per frame for a word and +5 ms for a big solid shape while one is showing, nothing otherwise. Changing `direction` clears a shape. In Swift the silhouette comes from CoreText (SF Pro Rounded, heavy) or a `CGImage`, blurred with the same box-blur code (`ShapeMask.swift`); the renderer paints the live patch in `draw(to:)`, just before the composite pass.

## Web ↔ Metal conventions

The Metal shaders (`swift/Sources/SkyKit/Shaders.swift`) are a line-for-line port. Differences handled in the port:

- Metal's fragment position has its origin at the top-left; the shaders convert to GL-style coordinates first: `frag = (pos.x, targetHeight - pos.y)`.
- `dfdy` follows the flipped axis, so its sign is negated.
- Metal texture row 0 is the top, so snapshots are sampled at `v = 1 - y`.
- Fast math is turned off at runtime compile so the noise hash produces the same numbers.
- Parameter blocks are all `float4`, so the Swift and Metal struct layouts match without padding surprises.

Verify after any shader change with `web/examples/parity.html` (see README).
