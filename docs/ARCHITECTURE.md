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
- **Shapes** are made from the clouds near them. Text or an image becomes a silhouette (100 px tall), blurred three ways (R = the shape, G = a near halo, B = its body) and placed in the near layer's *cloud space*, so it drifts with the clouds. **Picking clouds:** when a shape is placed, the near clouds around it are rendered into a small map (0.02 cloud units per cell, at three moments of the shape's life, keeping the most opaque) and read back once; `planShape` / `ShapePlan` (identical in both ports) groups cloudy cells into clouds, and picks up to 4 whole clouds with clear sky around them, near the shape, mostly in view and not much bigger than the shape needs (roughly its area). If none qualify it looks again with looser limits, and if there still isn't enough cloud (in a cloudier sky clouds join into big masses) it tears round pieces off the nearest big clouds. Each pick gets a part of the shape (left to right, so paths don't cross). **Live patch:** while the shape is on screen, the near clouds over the shape and the picked clouds' homes, paths and targets are rendered live every frame (same resolution and cloud function as the snapshots) and blended in where the patch already equals the ordinary sky. **Forming:** each picked cloud leaves its place and travels as an exact copy of itself (its density is read from its home position in the noise, so it is the same cloud, still slowly changing), then the shape grows out of it behind a ragged front while the cloud gives way, so the cloud visibly turns into the shape. A torn-off piece is soft-edged, detaches gradually and leaves a soft dent. **Melting** runs this backwards: the shape shrinks back into the clouds, which travel home, so the sky ends exactly as it would have been. Parked at home (no travel, no morph) the patch is invisible (max difference 10/255). **Look:** the shape's own cloud has a wobbly outline at puff scale, see-through rim and patches, and a big cloud's body tone (it is thin, so it barely shades itself); thick shapes (a heart, an emoji) also get a domed body and lumpy outline, and merge with clouds they touch, while near thin strokes (text) other cloud thins into wisps so the letters stay readable. Its soft rim and tone apply only to the shape's own cloud, never to the clouds arriving or around it. Cost at 2560×1600: about +3.5 to +7 ms per frame while a shape is showing (depends on how far apart the picked clouds are), nothing otherwise. Changing `direction` clears a shape. In Swift the silhouette comes from CoreText (SF Pro Rounded, heavy) or a `CGImage`; the renderer paints the live patch in `draw(to:)`, just before the composite pass. `sky-render` has testing aids: `SKY_PARK=travel,morph` holds the picked clouds, `SKY_BOXES=1` prints their boxes.

## Web ↔ Metal conventions

The Metal shaders (`swift/Sources/SkyKit/Shaders.swift`) are a line-for-line port. Differences handled in the port:

- Metal's fragment position has its origin at the top-left; the shaders convert to GL-style coordinates first: `frag = (pos.x, targetHeight - pos.y)`.
- `dfdy` follows the flipped axis, so its sign is negated.
- Metal texture row 0 is the top, so snapshots are sampled at `v = 1 - y`.
- Fast math is turned off at runtime compile so the noise hash produces the same numbers.
- Parameter blocks are all `float4`, so the Swift and Metal struct layouts match without padding surprises.

Verify after any shader change with `web/examples/parity.html` (see README).
