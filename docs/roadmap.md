# Roadmap

What is built, and what is knowingly left undone. The detail behind every
line here is in [`design.md`](design.md), by section number.

## Built

- **The FFT ocean** — JONSWAP spectrum with Hasselmann directional spread,
  seeded initial amplitudes, time evolution, a GPU butterfly IFFT over four
  MRT float targets, and up to three cascades that abut in wavenumber space
  so no wave is counted twice (§1.1–1.4). A pure-TypeScript twin of the whole
  pipeline in `src/core` is the oracle the GPU is tested against.
- **Foam** — a persistent energy field driven by the Jacobian, with
  advection, trough memory and breakup on heavy seas (§1.5, §1.16).
- **Shading and sky** — dielectric Fresnel, a procedural sky cubemap,
  Beer–Lambert body colour to the scene depth, a back-lit SSS lobe, sun
  glint, fog, ACES (§1.6–1.7).
- **The mesh** — a camera-following clipmap with crack-free ring seams
  (§1.8).
- **A world to sail in** — a procedural island that shoals the swell, with
  a beach, a peak, sea stacks, palms and rocks; a rigid-body galleon on a
  3×5 grid of hull columns, with throttle and rudder; an iWave wake behind
  it; asynchronous height readback for buoyancy (§1.9, §1.11, §1.15).
- **Light and water** — screen-space reflection and refraction of the ship
  and island, an underwater volume with caustics, radial sun shafts, and
  wind-blown spray off breaking crests and the bow (§1.10, §1.12–1.14).
- **Weather** — a rain curtain with a ripple field on the water, and the
  heavy-sea foam rework that goes with it (§1.16).
- **Instrumentation** — per-section GPU timing behind `?gpuTimer=1`, a HUD,
  and `scripts/perf.mjs` for headless fps sweeps ([`perf.md`](perf.md)).

## Next

In rough priority order.

1. **Water tone.** The remaining gap against the reference is art, not
   engineering: a deeper cerulean, more contrast between trough and
   highlight, a better exposure. The knobs are `color`, `sss` and `fresnel`
   in `src/core/params.ts`, and the per-preset patches in
   `src/app/presets.ts`.
2. **The Kelvin wake angle.** The wake is an iWave field, not a Kelvin
   solver, so it trails as a clean V rather than the 19.5° pattern (§1.9).
3. **SSR quality.** The march is 24 uniform steps, so it misses masts
   thinner than a step at range; there is no roughness blur, no temporal
   reprojection and no hi-Z acceleration (§1.12).
4. **Sun-shaft occlusion.** The shafts are not occluded by the ship or the
   terrain, and the caustics web they are modulated by is not temporally
   filtered (§1.13).
5. **Spray shading.** No shadowing, and no soft depth against the hull, so
   sprites intersect it hard (§1.14).
6. **Per-ring clipmap snapping.** Declined during the engineering review
   (finding 7): each ring snapping to its own cell shifts the ring extents
   against each other and needs L-shaped trim strips — a clipmap rewrite
   for no visible defect today. Worth revisiting only if a seam shows.
7. **A WebGPU backend** behind the "Force WebGL" toggle, keeping the tested
   WebGL2 path as the default. This is the one place the implementation
   knowingly diverges from the original, and the reasons are in spec §0.

Each section of the spec ends with its own short "Not built" list — rain
lit per drop, Draco compression, palm impostors, terrain shadows on the
water, and so on. Those are the smaller items.
