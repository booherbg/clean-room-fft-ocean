# FFT Ocean — design spec

*A clean-room, for-fun reimplementation of the ideas behind "Three.js Water
Pro" (an FFT/JONSWAP ocean on three.js).*

## 0. Ground rules

- **Clean room.** Three kinds of input went in, and it is worth being exact
  about which:
  - **Published papers** for every algorithm — Tessendorf 2001, Hasselmann
    1973/1980, Horvath 2015 ("Empirical directional wave spectra for
    computer graphics"), Tessendorf 2004 (iWave), Mitchell 2007 (light
    shafts) — plus the three.js documentation. Each is cited where it is
    implemented.
  - **The demo's observable behaviour** — what anyone sees by loading the
    page: its GUI, the slider ranges and their displayed values, the
    loading copy, how the presets look.
  - **The vendor's published API documentation**, which is a public web
    page. Several parameter names here (`standingWaveRatio`,
    `spectralSharpness`, `maxScale`, among others) match the names used
    there, because reading public documentation is how you learn which
    knobs a technique exposes. That is not reverse engineering, but it is a
    real input, and it is better stated plainly than left for someone to
    discover.

  What did **not** go in: the shipped bundle. It is obfuscated and its
  licence forbids deobfuscation. It was never deobfuscated, decompiled, or
  read, and no copy of it has ever existed in this repository's history.
- **Proof of concept, engineering-review quality.** Small files, one
  responsibility each, typed interfaces between layers, unit tests for the
  math, headless-GPU tests for the pixels.
- **Everything testable headless.** Measured on the development machine
  (Apple silicon, macOS): headless Chromium exposes hardware **WebGL2**
  (ANGLE Metal, `EXT_color_buffer_float`) with the stock Playwright build;
  WebGPU only appears with a specific
  Chrome-for-Testing build (chromium-1228) plus
  `--enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --use-angle=metal`.
  The clone targets **WebGL2 + GLSL** and runs the FFT as fragment-shader
  ping-pong passes: it works in every headless configuration we have,
  three's `WebGLRenderer` render-target/MRT API is mature, and a fragment
  FFT is a well-trodden path. This is the one deliberate divergence from the
  original (WebGPU/TSL compute). A WebGPU backend is a possible follow-up,
  not PoC scope.

## 1. The physics, in the order the GPU runs it

### 1.1 Wave spectrum (once per parameter change)

The sea surface is a sum of plane waves. For each wavevector **k** on an
N×N grid (N = 256 or 512) of a square tile of side L:

- k = 2π·(n, m)/L for n, m ∈ [−N/2, N/2).
- Deep-water dispersion: ω(k) = √(g·|k|). (`gravity` = 9.81.)
- Omnidirectional energy: **JONSWAP**
  S(ω) = (α g² / ω⁵) · exp(−1.25 (ωp/ω)⁴) · γ^r,
  r = exp(−(ω−ωp)² / (2 σ² ωp²)), σ = 0.07 (ω ≤ ωp) else 0.09,
  with ωp derived from `peakWavelength` λp: kp = 2π/λp, ωp = √(g kp).
  α is not taken from fetch (we don't model it); it is *calibrated* to a
  target significant wave height:
  `significantWaveHeight` = `amplitude` · softmin(Pierson–Moskowitz
  0.21 U²/g, 0.06 λp) (softmin = (a⁻⁴ + b⁻⁴)^(−1/4), a steepness cap so a
  strong wind on a short λp does not fold everywhere), and α is normalised
  via `spectrumMoment0` (m0 = ∫S(ω)dω of the unit-α shape) so that
  Var(h) = (Hs/4)². The value is computed on the CPU (`core/spectrum.ts`
  `alphaFor`) and passed to GLSL as `uAlpha`. `jonswapGamma` (default 3.3)
  is the peak-enhancement; the docs' `spectralSharpness` multiplies the
  exponent r.
- Directional spread: **Hasselmann (1980)**
  D(θ, ω) = N(s) · cos^{2s}((θ − θw)/2),
  s = 6.97 (ω/ωp)^{4.06} for ω < ωp, s = 9.77 (ω/ωp)^{−2.33 − 1.45(U/cp − 1.17)}
  for ω ≥ ωp, where U = `windSpeed`, cp = ωp/kp, θw = `windDirection`.
  N(s) normalises ∫D dθ = 1. A `standingWaveRatio` ∈ [0,1] mixes in the
  mirror direction (θ+π) to allow swell coming back.
- Change of variables to the k-grid: S(k) dk = S(ω) D(θ) (dω/dk) / |k|.
  Per bin: Φ(k) = S(ω) · D(θ,ω) · (dω/dk) / |k| · (2π/L)².
- Initial amplitudes (Tessendorf eq. 41 with our Φ):
  h0(k) = (ξr + i ξi)/√2 · √Φ(k), with ξ ~ N(0,1) from a **seeded** PRNG
  (Box–Muller over a splitmix32 stream) so two runs with the same seed give
  the same sea. Stored as a 4-channel float texture: `h0(k)` in .rg and
  `h0(−k)` in .ba so time evolution needs one fetch.

### 1.2 Time evolution (every frame, per cascade)

h̃(k,t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt}.
From h̃ we build, in one fragment pass, the spectra of five fields packed
into four RGBA textures A–D (real/imag interleaved as complex pairs, two
complex fields per texture):

| field | spectrum |
|---|---|
| height h | h̃ |
| horizontal displacement Dx, Dz | −i (kx/|k|) h̃, −i (kz/|k|) h̃ |
| slope ∂h/∂x, ∂h/∂z | i kx h̃, i kz h̃ |
| ∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z | kx²/|k| h̃, kz²/|k| h̃, kx kz/|k| h̃ |

Time is `t · animationSpeed`. Horizontal displacement is scaled by
`choppiness` (λ in Tessendorf).

### 1.3 Inverse FFT (every frame, per cascade)

A 2-D IFFT is log₂N horizontal butterfly passes then log₂N vertical passes.
Each pass is a full-screen fragment shader reading a precomputed
**butterfly texture** (row = stage, column = index; stores the two source
indices and the twiddle factor) and ping-ponging between two RGBA float
targets. We run each pass on the four textures at once via MRT (`drawBuffers`)
so all eight real fields (four complex pairs) go through one set of passes.
The sign flip (−1)^{x+y} is applied in the final "unpack" pass, which also
writes the three output textures the renderer samples:

- `displacement` RGBA: (λ·Dx, h, λ·Dz, ∂Dx/∂z) — the last channel raw
  (unscaled), kept for CPU readers
- `derivatives` RGBA: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — enough for normals
- `jacobian`  R: J = (1+λ∂Dx/∂x)(1+λ∂Dz/∂z) − (λ∂Dx/∂z)²

The renderer samples these with world-space UVs, so (where
`OES_texture_float_linear` is available) they are linear-filtered: the
unpack MRT target — `displacement`, `derivatives`, `jacobian` — is
mipmapped (trilinear minification, chain regenerated after every unpack),
which matters for `derivatives` at grazing angles where the fine cascade's
normals would otherwise alias into sparkle noise; the foam field (§1.5) is
bilinear without mips. Without the extension everything falls back to
nearest.

A CPU reference implementation of the same pipeline (radix-2 Cooley–Tukey in
TypeScript) exists under `src/core` and is the oracle for both the unit tests
and the GPU tests.

### 1.4 Cascades

Real seas span 1000 m swell to 1 cm ripples; one tile can't hold that. We
run up to three cascades — tiles of decreasing size that *abut* in
wavenumber space so no wave is counted twice:

| tier | cascades (tile side m) | N |
|---|---|---|
| Low | 1024 | 256 |
| Medium | 1024, 96 | 256, finest 128 |
| High / Ultra | 1024, 96, 9 | 256 / 512 |
| Max | 1024, 48, 2.25 | 512 |

Tile 0 side = `maxScale` (1024). `tierConfig().finestN` lets the last
cascade run at a smaller FFT than the rest (Medium: 128); the band layout
depends on tile sizes only, so this moves the finest tile's Nyquist limit
(0.75 → 1.5 m) and nothing else (`docs/perf.md`, "Performance pass").

Each cascade's spectrum is band-limited: cascade i keeps only |k| in [k_min_i, k_max_i), and the seam between
cascades i and i+1 sits at the finer tile's *fundamental*,
`k = 2π / tileSize_{i+1}` — its bin spacing dk. Each bin of the finer tile
stands for a dk×dk cell of k-space, and only its DC cell lies wholly
inside |k| < dk, so this is the lowest seam with nothing unrepresented
(any higher cut leaves holes: the earlier hand-off at the coarse tile's
16th harmonic, 1.5·dk on the 1024/96 pair, dropped the (1,1) bins — no
wave between 45 and 64 m along the diagonal). Because a seam bin's cell
straddles the seam, energy is cross-faded linearly over one bin width
`dk` centred on the seam, complementary on the two sides
(`core/spectrum.bandWeight`, mirrored in `spectrum.frag.glsl`): a bin on
the seam carries half its cell's energy; the union is contiguous and no
wave is counted twice (`tests/cascades.test.ts` checks both). The coarse
tile then resolves waves down to `tileSize / 1.5` with ≥ 16 texels per
wavelength on every tier. The renderer sums displacement/derivatives of
all enabled cascades, each sampled at `worldXZ / tileSize_i`.

### 1.5 Foam

Where the Jacobian J < `foamThreshold` (default 0.8) the surface is folding
over; that is where whitecaps live. Foam is an *energy field* with memory, not a per-frame
mask: a ping-pong RGBA float texture (energy in .r) in the cascade's own
periodic texel space
(the same texel as the Jacobian it is derived from, so it tiles with the
displacement and needs no camera anchor). Each frame
`e = max(e · exp(−dt/decayTime), crestStrength · saturate(threshold − J))`
plus a wind-ward bias (`windwardStrength`) that adds foam on the slope facing
the wind. The material reads the field through a tiling foam albedo texture
(procedural noise, no asset) and blends it in over the water shading.

### 1.6 Shading (the water fragment shader)

Per pixel, in this order:

1. Normal from summed derivatives: n = normalize(−sx, 1, −sz) (choppiness
   folded in via the ∂D terms).
2. View vector, sun vector, half vector.
3. **Fresnel** for a dielectric, `iorRatio` 1.33, Schlick with
   F0 = ((n−1)/(n+1))² ≈ 0.02 (option: exact Fresnel).
4. **Reflection**: sky/environment sample along the reflected ray (cubemap
   of the procedural sky), replaced by the screen-space reflection of the
   ship and island where the march hits (§1.12).
5. **Refraction / body colour**: `waterColor` under a Beer–Lambert
   absorption `exp(−absorptionColor⁻¹ · depth)` where depth is the view
   distance through water to a virtual floor at `depth` metres, or the
   scene depth from the pre-pass where that is shallower (§1.11, §1.12).
   `transmissionColor` tints thin water.
6. **Sub-surface scattering**: a back-lit lobe
   `sss = intensity · pow(saturate(dot(v, −l)), power) · max(h,0)` tinted
   `transmissionColor`, stronger on high waves (h is height above mean
   sea level).
7. **Specular**: Blinn–Phong with `sparklePower` (512) for the sun glint,
   plus a broader lobe (power 64) for the sun halo.
8. **Foam** lerp on top, lit as a white Lambert surface (albedo 0.9):
   `sun · max(n·l, 0)` (unshadowed) + a nine-tap hemisphere average of the
   sky cubemap (zenith, 24°, near-horizon; the low taps weighted up since
   an overcast deck is brightest at the horizon), scaled ×2 for the
   multiple scattering of a bubble raft. The sky term is grey-clamped
   (chroma → luminance, 35 % clear → 100 % at full cover) so the residual
   clear sky in the cubemap never tints storm whitecaps blue, and floored at
   0.25 × zenith luminance so foam stays legible at dusk. Foam density per
   preset comes from `foam.crestStrength`/`threshold` (3.2–3.5 at wind
   ≥ 15 m/s), never from the shader.
9. **Distance fog** `fogColor`, linear between `fogNear`/`fogFar`.
10. Output linear → tonemapped (ACES) → sRGB by three.js.

### 1.7 Sky

A procedural analytic sky (Preetham/Hosek-style is overkill; we use a
compact three-term model: Rayleigh gradient by sun elevation, Mie forward
lobe for the sun disc/halo, a cloud layer from 2-octave value noise driven
by `cloudCoverage`). Rendered into a small cubemap (128²/face) whenever
`timeOfDay` or coverage changes; used both as the visible skybox and as the
reflection source for the water. Sun direction is derived from `timeOfDay`
(hours, 0–24): elevation = sin((t−6)/12·π), azimuth fixed.

### 1.8 Mesh

A **clipmap**: a central dense grid plus L concentric rings each at half the
resolution of the one inside, all following the camera in grid-snapped
steps; the vertex shader samples the cascade displacements and offsets
vertices. `meshSegments` per ring = 16 (Low) … 64 (High+). No skirts; ring
seams are handled by snapping to the coarser grid at ring edges, and every
vertex on a level's outer edge carries the coarser level's `ring` value so
it drops the same fine cascades as the coincident coarser vertex (equal
`ring` at equal xz — `tests/clipmap.test.ts`). The whole clipmap snaps to
the finest cell as one unit; per-ring snapping would need trim strips and
is not done.

### 1.9 Buoyancy, wake and the ship

**Height sampler** (`src/app/buoyancy.ts`). `Buoyancy.update(x, z, radius)`
reads a texel block of every cascade's displacement texture around the
probe (4×4 for a point, grown per cascade to cover the hull footprint;
cascades whose tile is far smaller than the footprint are skipped; blocks
that straddle the tile edge are read in up to four pieces so the wrap is
honoured) and `heightAt(x, z)` sums the bilinear samples the way the vertex
shader does, iterating twice to undo the horizontal displacement. The
readback is **asynchronous** (`gpu/readback.ts` `AsyncBlockReader`:
`readPixels` into a `PIXEL_PACK_BUFFER` + `fenceSync`, consumed the next
frame — one frame of latency, no pipeline stall; `docs/perf.md`,
"Performance pass").
`covers(x, z)` says whether a point is inside the block (outside it
`heightAt` clamps to the edge texels). The synchronous `readTargetBlock`
path remains for the e2e tests and `__app.wakeSample`.

**Boat wake.** `src/gpu/wakePass.ts` +
`wake.frag.glsl` step an iWave (Tessendorf 2004) height field in a pair of
MRT float targets: 512² texels over a 512 m square at 1 m cells, anchored
to the hull in whole-cell steps (the previous state is read at `p + shift`;
what scrolls off the square is gone). Per frame `v += (−g/cell · h⊗G − αv)
dt; h += v dt` with G the 13×13 vertical-derivative kernel from
`src/core/iwave.ts` (Hankel transform of `k² e^{−k²}`). Truncating the
kernel leaves a DC residual ≈ 1/P that gives long waves zero group velocity
and a phase speed that grows with wavelength, so the field radiated *ahead*
of the hull; the kernel is made zero-mean by subtracting a Gaussian blob of
the same total (plus a pinch of Laplacian to keep the Nyquist response
≥ 0), which caps every phase/group speed at ≈ 4.5 m/s < `Hull.CRUISE`
(7 m/s) — the pattern trails as a clean V (the Kelvin angle is not
reproduced). The hull stamps a soft-ellipse obstruction (surface set to
−draft·speed, velocity killed) with a compensating +0.42·draft ring so the
stamp is zero-volume, plus a slow 8 s mean relaxation; foam is laid along
the hull path and where the wake's own slopes are steep, decaying over 3 s.
Attachment 1 `(h, ∂h/∂x, ∂h/∂z, foam)` is bound to the water material as
`uWakeTex`/`uWakeOrigin`/`uWakeSize`: the vertex shader adds `h`, the
fragment adds the slopes to the normal and the foam to the foam energy, with
a 4 % UV border fade. `src/app/wake.ts` drives it in boat mode; the "Wake
Probes" toggle draws a cyan hull ring and a translucent field plane
(red crest / blue trough / white foam). `__app.wakeSample(dx, dz)` reads a
4×4 block for the e2e test, which asserts height or foam behind the hull
and none 100 m ahead.

**Rigid-body ship.** `src/core/rigidbody.ts` is a
minimal 6-DOF body (semi-implicit Euler, diagonal body-space inertia,
exponential linear/angular drag, `applyForceAt`, `velocityAt`,
`eulerFromQuat`). `src/app/ship/hullPhysics.ts` puts a 3×5 grid of hull
sample points on it (five stations × keel + two sides, positions and drafts
from the shared hull lines in `hullShape.ts`): each is a vertical water
column of area `A_i` that pushes up with ρgA_i·s_i for its submerged depth
`s_i` plus a heave-damping term (ζ ≈ 0.7). Mass is ρΣA_i·draft_i so the
centre of mass sits on the still waterline, and the origin is shifted to the
rest centre of buoyancy so the hull floats level; the waterplane inertia
(BM ≈ 5 m) beats the force depth (≈ 2 m) so it self-rights. Throttle is a
thrust along the heading against quadratic body-space drag (cruise 7 m/s,
1.6 m/s² from rest); rudder a speed-scaled yaw torque against linear yaw
damping (0.4 rad/s at cruise). Substeps ≤ 1/60 s. `buoyancy.update(x, z,
radius)` now reads a wrapped block covering the hull footprint per cascade
(skipping cascades that would need > 96 texels). `src/app/ship/shipModel.ts`
lofts a procedural ~40 m galleon (hull with wale, red band and gilt, decks,
stern and fore castles, gunports, three masts with yards, bellied sails,
shrouds/stays, bowsprit, flag; now dressed with the shared PBR materials of
§1.15 and used as the fallback for the glTF ship), lit by the scene sun whose
colour comes from `Sky.sunColor()` and a hemisphere from `Sky.ambient()`;
every mesh is tagged `userData.castsWaterDepth`. `Ship` (`ship.ts`) ties
model + physics + the "Buoyancy Probes" overlay (`probesOverlay.ts`: green
discs on the water at each sample, yellow arrows ∝ force). Boat mode: W/S
throttle, A/D rudder, chase camera off the starboard quarter, the wake
stamped from the body. `__app.hull()` still reports `{position,
waterHeight}`; `__app.ship()` adds `{speed, pitch, roll, heading}`. Tests:
vitest for the body and hull (2 m drop settles < 5 s, throttle, rudder,
rolling/pitching seas, 2 m beam swell) and e2e drop / throttle / rudder /
probes-overlay checks.

### 1.10 Underwater

When the camera is below the local surface height (`Buoyancy.heightAt` at
the camera xz, sampled whenever the camera is under 12 m — from the hull's
sampler when its block `covers()` the camera, otherwise from a second
`Buoyancy` owned by the camera, since `heightAt` clamps to its block's edge
outside it) the app flips
three things (`src/app/main.ts`):

- `WaterMaterial.setUnderwater(true)`: the fragment shader takes the
  underside branch. Back faces refract water→air with `iorRatio` (Snell's
  window, ≈ 48.6° from the normal): total internal reflection outside it
  mirrors the water volume (with a soft sun glint), inside it the sky
  cubemap shows through, Schlick-weighted; foam reads as a bright ceiling
  (0.7 × its top-side colour). Front faces seen from below (a trough lower
  than the eye) are fully fogged.
- The skybox is swapped for `Underwater` (`src/render/underwater.ts`): a
  camera-locked far-plane box painting the water volume — `waterColor` ×
  the surface's body light, brighter looking up and toward the sun — and,
  looking down, a virtual floor at `color.depth` m carrying an animated
  caustics web (two sine-warped value-noise layers folded into ridges and
  multiplied; intensity 0.61, scale 65 m, not yet user params).
- Both use the shared fog in `common.glsl`: extinction
  `exp(−(absorption·12 + 0.045)·dist)` toward `underwaterRadiance(viewDir)`,
  so the surface underside and the volume meet at the horizon without a
  seam.

Fly mode may dive (Q) to −60 m; `__app.setCameraPosition([x, y, z])`
teleports for the e2e test. Sun shafts: §1.13. The ship model (glTF with a
procedural fallback): §1.15.

### 1.11 Terrain and shoreline

An island sits ~450 m in front of the default camera (centre (−70, 0, −450))
so the shore reads the way the reference does: turquoise shallows, a foam
line, a sandy beach, a rocky peak, and two sea stacks.

**Heightfield** (`src/core/terrain.ts`, pure TS, unit-tested).
`islandHeight(x, z, seed)` is deterministic per seed: the radius is warped
by low-frequency fBm (±45 m) so the coast is not a circle; outside it the
seabed falls 1:8 to −6 m, eases to −10 m over 150 m, then drops to −50 m
past 280 m (below the water's virtual floor, so open sea is unchanged);
inside, a foreshore 1:8 to 2.5 m and backshore 1:12 (capped, so the beach
stays flat), fBm hills fading in past the beach, and a peak dome
(`PEAK_HEIGHT` 60 m × crag + ridge noise) rising as the square of the
inland fraction. Sea stacks (`SEA_STACKS`) are Gaussian bumps of noise
outside the ring. `sampleHeightmap(N, extent, seed)` bakes an N×N
`Float32Array` (row = z).

**Mesh** (`src/render/terrain.ts`). `Terrain(seed)` is a 256² plane over a
1200 m square with vertex heights from the heightmap, tagged
`userData.castsWaterDepth`. The same heights go into a half-float
`RedFormat` texture the water samples (`attachTo(ocean)`) for two things:
wave **shoaling** — displacement, slopes and crest foam scale by
`shoalFactor(seabed) = smoothstep(0.3, 6, −seabed)`, so the swell flattens
on the shelf and never rolls up the beach — and the seabed height under
each surface vertex. `terrain.frag.glsl` shades sand below ~3 m (wet and
dark within ~1.5 m of the waterline, the line lapping with `uTime`; dune
scrub patches on the backshore), grass/scrub above, rock by slope and near
the peak, all lit by the sun plus a sky-cubemap ambient pulled a third
toward grey, with the water's distance fog. Under water (§1.10 flag) the
bed is lit by the water body's light through the extinction to its depth,
focused by the caustics web, and fogged by the same extinction as the
volume.

**Scene pre-pass** (`src/render/scenePass.ts`; colour + depth, see §1.12).
Before the main render, every object tagged `castsWaterDepth` (terrain,
ship) is drawn with its own material into a half-float colour target with
a 32-bit float depth texture at the drawing-buffer size (alpha 0 / depth
1.0 = nothing). Tagged subtrees are put on layer 1 and the camera's mask is
narrowed to it for the pass, so the scene graph is not mutated and the
water and sky are never in the target.

**Water** (`water.frag.glsl` steps 5, 5b, 8c). `waterThickness()` reads
the depth at `gl_FragCoord` (offset by the normal's xz so the bed wobbles
like a refraction; pulled back to the pixel's own position when the offset
lands on something in front of the surface), linearises it through the
projection and converts the view-z difference to vertical metres of water
below the pixel. Absorption uses `min(color.depth, thickness)`;
where the water is thinner than ~25 m the seabed (sand albedo 0.72/0.64/0.46,
lit by sun + sky) blends in by a two-way Beer–Lambert transmittance with a
fixed turquoise-making σ (0.095, 0.050, 0.032)/m plus the user's absorption —
the deep colour stays the user's, the shelf goes turquoise. Under ~1 m of
water (lapping with time, broken by the foam noise) shoreline foam is drawn
with the foam's lighting, solid at the water's edge.

Tests: `tests/terrain.test.ts` (determinism, peak, beach band, seabed, sea
stacks, heightmap); `e2e/render.spec.ts` (peak pixel is warm, shoreline
strip has more near-white than 200 m out); `e2e/app.spec.ts` writes
`island.png`. Not built: terrain shadows on the water, wet-sand
reflections, a second island.

### 1.12 Screen-space reflection and refraction

The ship and the island are mirrored in the water, and seen through it
where it is shallow, from the same scene pre-pass that feeds the shoreline.

**Pre-pass** (`src/render/scenePass.ts`). `ScenePass` replaces the
depth-only pass: the `castsWaterDepth` objects are rendered with their real
materials — the terrain with its shader, the ship's `MeshStandardMaterial`s
under the scene's sun and hemisphere lights — into an RGBA half-float
colour target plus a `DepthTexture` (`FloatType`, `DEPTH_COMPONENT32F`),
cleared to (0, 0, 0, 0). The colour is *linear*: three.js skips tone
mapping and the output transfer for render targets, and raw-shader
materials that finish their own colour expose a `uLinearOut` uniform the
pass sets to 1 for its duration (the terrain does). The target is disposed
and recreated whenever the drawing-buffer size changes (DPR slider,
resize). `Ocean.renderSceneDepth(scene, camera)` runs it and binds
`uSceneColor` / `uSceneDepth` on the water; nothing else is touched.

**Reflection** (`water.frag.glsl` step 4b, `ssrTrace`). After the sky
lookup along the reflected ray `r` (kept above the horizon as before), the
ray is marched in view space: the segment from the surface point to
`p0 + r · len` (`len = clamp(3 · viewZ, 80, 1500)` m, shortened to stay in
front of the near plane when the ray turns toward the eye) is projected
once and stepped **uniformly in screen space**, 24 steps, with depth
interpolated in 1/w so it is perspective-correct; at each step the scene
depth (linearised as `P[3][2] / (ndc + P[2][2])`) is compared with the
ray's. The first step at which the ray is behind the scene is refined by 4
bisections. The hit's weight is the product of a **confidence**
`1 − (rayZ − sceneZ) / thickness` with `thickness = max(1.5 m, 0.04 ·
sceneZ)` (so a ray that passed *far* behind an occluder is not a hit), a
screen-border fade over 6 % of the frame, a fade for rays whose view-space
z turns toward the camera (nothing behind the viewer is in the buffer),
and the scene alpha. `reflection = mix(sky, sceneColour, weight)`; the
Fresnel blend and the sun/moon specular are unchanged, so at a steep view
the reflection is faint (as it should be) and at grazing incidence the
island mirrors strongly. Misses fall back to the cubemap. Skipped when the
camera is under water.

**Refraction** (step 5b). The constant sand term is replaced by the scene
colour at the refraction-offset screen position — the seabed with the
terrain's own shading, the hull below the waterline — tinted 30 % toward
the transmission colour and weighted by the same two-way Beer–Lambert
transmittance as before (`SHALLOW_SIGMA` + absorption over the vertical
thickness and the refracted path). The sand albedo stays as the fallback
where nothing is in the buffer or SSR is off. Shoreline foam and the
thickness logic are unchanged.

**Toggle.** `fresnel.ssr` (default `true`), GUI checkbox
`data-testid="ssr"` ("Reflections (SSR)"); `tierConfig().ssr` is `false`
on Low, which forces it off and greys the control. `uSsr` gates both the
march and the scene-colour refraction (the depth read for the shallows
stays on).

**Cost.** ~1.0 ms/frame at 1280×800 DPR 1, Medium (`docs/perf.md`).

Tests: `e2e/app.spec.ts` "ssr:" — boat mode on a calm sea (wind 4 m/s), a
band of water below the hull's waterline is darker and browner with SSR
on than off; the checkbox follows the param and is disabled on Low;
`mode-boat-ssr.png`. `mode-boat.png` and `island.png` show the ship and the
island reflected. Not built: reflection of the water in itself
(inter-wave), reflection blur by roughness, temporal reprojection, a
hi-Z march (the 24 uniform steps can miss a mast thinner than a step at
long range).

### 1.13 Underwater sun shafts

A radial light-scattering post pass (Mitchell 2007, "Volumetric light
scattering as a post-process"), `src/render/sunShafts.ts` +
`shaders/sunShafts.frag.glsl`, run only while the camera is underwater
(§1.10) and there is sun to shaft. `params.underwater.sunShafts` (default
true) is the "Sun Shafts" checkbox.

**Frame.** When the pass is active the app renders the scene into a colour
target instead of the canvas (RGBA8, MSAA ×4, drawing-buffer size; the
target is flagged `isXRRenderTarget` so three.js applies the renderer's
tone mapping + sRGB output to built-in materials exactly as for the canvas,
and its internal format is pinned to `RGBA8` so the MSAA resolve and the
texture agree). Then three fullscreen passes:

1. **Mask** (half resolution): "sky through the surface". For each pixel the
   world view direction is rebuilt from the inverse projection; the mask is
   `elev · min(1, (bright · cone + lobe) · beams)` where `elev =
   smoothstep(0.12, 0.55, dir.y)` keeps only the underside above the eye
   (Snell's window; kills the caustics floor and the water body), `bright =
   smoothstep(0.5, 0.95, luminance)` is the frame's bright rim + foam
   ceiling, `cone = (dir · sunW)⁶` confines it to the sun's neighbourhood,
   `lobe = (dir · sunW)²⁴ · (0.3 + luminance)` is the sun itself modulated by
   what the surface let through, and `beams = 0.1 + 0.9 · caustics(...)`
   is the §1.10 caustics web sampled where the ray meets the mean surface
   (drifting down-sun with `uTime` like the floor's) — the surface's wave
   lenses, so the shafts are streaks that move with the floor caustics, not
   a glow.
2. **Blur** (half resolution): 48 samples marched from the pixel toward the
   sun's screen position, `density 0.85`, `decay 0.975`, `weight 0.075`;
   the march is capped at 1.0 uv so an off-screen sun still converges
   without giant steps; samples outside the screen read 0.
3. **Composite** (canvas): `frame + tint · shafts · (1 − frame)` — a screen
   blend, so the core never saturates to a flat white.

**Sun.** `sunW` is the sun *refracted* into the water (Snell with
`fresnel.iorRatio`), so the shafts converge on where the sun appears from
below, and its screen uv comes from the camera's view/projection (v up;
may lie outside [0, 1]).

**Strength** (`SunShafts.strength`, 0 = pass skipped and the scene renders
straight to the canvas): `facing · daylight · exp(−depth / 20 m)` with
`facing = smoothstep(−0.15, 0.25, forward · sunW)` (fades as the sun goes
behind the camera; looking straight up keeps the god-rays), `daylight =
smoothstep(−0.02, 0.18, sunElevation) · sun.intensity / 1.5` (none at
night). The tint is the sky's sun colour pulled a third toward white.
Targets follow the drawing-buffer size (DPR, resize) and are disposed with
the pass.

Tests: `e2e/app.spec.ts` "underwater sun shafts" — camera 4 m under,
pointed at the refracted sun via `__app.setCameraDirection`; the mean
luminance of a disc around `__app.sunShafts().sunUv` is higher with the
pass on than off (+36 measured, +8 asserted); the checkbox drives the
param; strength is 0 at 01:00; writes `underwater-shafts.png`. Not built:
occlusion of the shafts by the ship or terrain (the mask is taken from the
frame, so a hull against the bright ceiling reads as a gap, which is close
but not the same), temporal filtering of the web.

### 1.14 Spray particles

Wind-blown spray off breaking crests and off the ship's bow: a GPU particle
pool drawn as `THREE.Points`. `params.spray = { enabled, density, size }`
(defaults true / 1 / 1); the "Spray" checkbox (`data-testid="spray"`) and
the "Spray density" slider drive it; `tierConfig(...).spray` is false on
Low, where the checkbox is disabled and the pool stays empty.

**Pool.** `src/gpu/sprayPass.ts` + `spray.frag.glsl`: 180² = 32 400 slots
in two ping-ponged RGBA float MRT targets, A = `(x, y, z, age)`, B =
`(vx, vy, vz, life)`; `life < 0` marks a bow droplet, a slot is free when
`life == 0` or `age ≥ |life|`. One `FullscreenPass` step per frame
(`texelFetch` of the previous state, pcg3d hash RNG seeded by texel and a
`uint` frame counter). A live slot relaxes its horizontal velocity toward
the carried wind (`dragRate` 0.8 /s toward `windCarry` 0.55 × wind speed),
falls under gravity, integrates, and dies on age or when it drops 0.3 m
below the displaced surface (`dispAt`, cascades 0 + 1). A free slot tries
to spawn:

1. **Bow** (boat mode, |speed| > 2 m/s): with probability `bowRate · dt /
   slots`, `bowRate = 200 · speed² · density` /s, at the port or starboard
   sample of the hull's foremost station (`bowPoints`, the two side samples
   with the smallest body z; y = max(world y, water y)), thrown outward
   `(0.5..1.1) · speed`, forward `(0.2..0.5) · speed`, up
   `1.5 + 0.6 · speed · (0.6..1.4)`, life `1.4 s · (0.6..1.4)`.
2. **Crest**: pick a point in a disc (radius 130 m, centred 0.45 r ahead of
   the camera; radius linear in the random so density falls as 1/r and the
   near field gets the budget). With `e` = foam energy of cascades 0 + 1
   (§1.5) and `fold = Σ sat(foam.threshold − J)` (a crest folding right
   now, as opposed to lingering foam), spawn with probability
   `clamp((e − 0.35) · 100 · density · dt · (0.25 + 4 · fold), 0, 1)` on
   the displaced surface + 0.2 m, velocity = wind carry + jitter
   horizontally, up `(1.5 + 0.18 W + rnd · (1 + 0.12 W)) · (0.6 + 1.2 ·
   fold)`, life `1.5 s · (0.6..1.4)`.

The pure-TS twin of these rules is `src/app/spray/sprayField.ts`
(`SPRAY_TUNING`, `crestSpawnProbability`, `bowRate`, `bowPoints`,
`crestVelocity`, `bowVelocity`, `integrate`, `fade`, and a CPU `SprayField`
pool) — the tests run it; `SpraySystem` takes its numbers from it.

**Draw.** `src/app/spray/spraySystem.ts`: a `RawShaderMaterial` Points with
one vertex per slot, position fetched by `gl_VertexID`; dead slots go to
clip z = 2 with size 0. Sprite size in metres = `size · jitter(id) · (0.13 +
0.3 · age/life) · (1 + 1.4 · bow)`, projected via `bufferHeight · P[1][1] /
2 / dist` and clamped to 1..26 px; below a pixel the alpha is dimmed by
coverage² so far spray is a haze, not popping pixels; a distance fade
70–170 m; fade `min(1, 12u) · (1 − u)`. The fragment is a soft disc
`(1 − r²)²`, coloured `sky · 2.2 + sun · (0.55 + 1.8 · mie)` with `mie =
(view · sunDir)⁶` (forward scatter glow) through `finish()`; sun colour ×
intensity × (1 − 0.75 cloud), sky ambient pulled toward grey by cloud.
Premultiplied blend One / OneMinusSrcAlpha with the written alpha × 0.6
(brightens more than it covers), depth-tested, no depth write,
`renderOrder 20`, hidden underwater. `__app.spray()` returns `{ alive,
crest, bow, capacity }` by synchronous readback; the pool resets on mode
change and quality rebuild.

Tests: `tests/sprayField.test.ts` (threshold, spawns ∝ excess energy /
density / dt, velocities, lifetimes, ½gt² gravity, death on water, drag →
wind, fade, bow gating ∝ speed², bow points and sides). `e2e/spray.spec.ts`:
Storm → after 3 s `alive > 0`, crest only, and the bright-pixel fraction of
the near sea is higher with spray than with it off (which empties the pool);
boat + W 3 s → speed > 2 and `bow > 0`; checkbox drives the param and is
disabled on Low; no console errors; writes `spray-storm.png` and
`spray-bow.png`. Not built: spray shadowing the water, sorted/soft-depth
sprites against the hull, spray from the ship's wake.

### 1.15 Ship and island assets

The scene's two set pieces — the galleon and a palm-fringed cay — as
licensed models dressed with procedural PBR materials, with procedural
fallbacks so the demo never depends on a fetch. Everything shipped lives in
`public/assets/` (Vite serves it at `/assets/`), is listed with source URL,
author and licence in `public/assets/LICENSES.md`, and totals ~256 KB
(budget 15 MB, `tests/assetBudget.test.ts`). Loading streams in after
`loading.finish()`; the sim and the overlay never wait for it.

**Ship.** `models/galleon.glb` is built by `scripts/buildShipAsset.mjs`
from Daniel Quevedo's CC0 "Pirate Ship" (OpenGameArt, `GalleonOGA.obj`):
the untextured OBJ is split into connected components (union-find over
shared vertices) and each classified by shape — the largest is the hull;
≥ 200 triangles facing mostly ±z is a sail; ≤ 24 triangles is iron
(cannon); the rest spars or hull by extent and height — then written as
four named meshes (`hull`, `spar`, `sail`, `iron`) with box-projected UVs
in metres (4 m tiles, 10 m for canvas), scaled to 40 m on deck, keel 3 m
below y = 0, bow toward −z (gltf-transform `weld`/`dedup`/`prune` keeping
attributes). `src/app/assets/shipLoader.ts` fetches it (GLTFLoader +
Meshopt), maps part names to the shared materials, tags every mesh
`castsWaterDepth`, normalises to the rig's `length`/`draft` and returns
the hull's bounds as `HullDimensions`; `Ship.setModel()` swaps the visual,
rebuilds `HullPhysics` for the new beam/draft, keeps the pose and
re-targets the probes overlay. `?ship=procedural`, or any load error,
keeps the procedural galleon (`ship/shipModel.ts`: plank UVs, an
above/below-waterline hull split, wales, gilt band, cannons, transom
windows, bellied sails with reef bands, ratlines). `__app.ship().model`
reports `"gltf" | "procedural"`.

**Materials.** `src/app/assets/proceduralTextures.ts` synthesises
colour / roughness / normal `DataTexture`s from `fbm`/`valueNoise`: wood
planking (plank ids, grain, knots, nail rows), canvas with panel seams and
a torn-edge alpha, rope, and a palm frond card (rib + leaflets in alpha).
`shipMaterials.ts` builds the `MeshStandardMaterial` set once (hull, hull
below the waterline, deck, spar, wale, sail (double-sided, alphaTest, a
touch of emissive for sun through canvas), iron, gilt, glass, rope, flag)
and both ship models share it. The sun is a `DirectionalLight` with a
1024² PCF shadow map over a ±70 m box on the chase camera; the map is
built on the first render (every lit material samples it) and refreshed
only in boat mode, where the ship is the sole receiver.

**Island dressing.** `src/render/vegetationPlacement.ts` is pure and
seeded: rejection sampling on `islandHeight` puts ~40 palms where the
terrain is 1.5–8 m above sea level with |∇h| ≤ 0.35 and ≥ 7 m apart (the
backshore behind the beach), and ~15 rock outcrops where h ∈ [−0.6, 1.2] m
(the foreshore); leans follow the downhill gradient. `src/render/vegetation.ts`
draws the palms as one `InstancedMesh` per variant, starting procedural
(bent tapered trunk + twelve frond cards) so the island is dressed on the
first frame and swapping to the Kenney Nature Kit palms (CC0,
`models/palm-{tall,short,bend}.glb`, unlit in the file, re-dressed with
lit bark and frond materials) once they load; `?palms=procedural` keeps
the fallback. Geometries are normalised to unit height and a wind sway is
injected via `onBeforeCompile` (`transformed.y` is the height fraction;
the top swings with `uWind` = the ocean's wind direction × min(speed/25,
1) × 1.4 m, plus a small gust term). Rocks are fBm-displaced icospheres,
three warm-sandstone boulders per outcrop, merged into one flat-shaded
mesh. All of it is tagged `castsWaterDepth` (foam breaks around the rocks,
the reflection pass sees the palms). `__app.vegetation()` returns
`{ palms, rocks, model }`.

Tests: `tests/vegetationPlacement.test.ts` (height band, slope, spacing,
determinism, count filled on many seeds); `tests/assetBudget.test.ts`;
`e2e/assets.spec.ts` (glTF ship and palms load with the sim running and
no errors; the loaded ship still floats and steers; the `?…=procedural`
knobs; a 404 on every `.glb` falls back cleanly). `mode-boat.png` and
`island.png` show the result. Not built: Draco (needs a served decoder
directory), rigging lines on the glTF ship, LODs / impostors for the
palms, shadows onto the terrain (its raw shader has no shadow input).

### 1.16 Weather: rain and heavy-sea foam

Two halves of the same idea — what a gale actually does to the picture.
The reference for the look is the original demo's storm preset as it
renders in a browser: fine directional streaks over the whole frame, denser
near the camera, grey against the cloud deck and bright against the horizon
band, over a sea whose whitecaps are dense, textured and slow to die.

#### Rain

`params.weather = { rain, rainEnabled }` (0 / true by default); the "Rain"
slider (`data-testid="rainAmount"`) is the intensity and the "Rain"
checkbox (`data-testid="rain"`) the switch; `tierConfig(...).rain` is
false on Low, where the checkbox is disabled and nothing is drawn. Storm
rains at 0.9, Foggy drizzles at 0.25.

**Streaks.** `src/app/rain/rainSystem.ts`: 8 000 instanced quads in a
60 × 42 × 60 m volume centred a quarter of its depth ahead of the camera.
A drop's position is a *pure function of its static seed and the clock* —
`mod(seed·V + v·t − boxMin, V) + boxMin`, the wrap in **world** space, so
drops hold their world positions as the camera (and the box) moves, and a
drop that leaves re-enters on the opposite face. There is no state
texture, no per-frame CPU work and nothing to reset. `v` is gravity plus
wind drift (`rainVelocity`): fall 13 m/s × a per-seed ±25 % jitter, plus
`windCarry` 0.18 of the wind speed along the wind direction, plus a small
per-drop sideways wander so the curtain is not laminar. 13 m/s is above a
real drop's terminal velocity; it is what makes the curtain read
near-vertical at Storm's 17 m/s gale, as the reference does. Each quad is
stretched along `v` by an exposure's travel (`streakSeconds` 0.04 s,
×0.7–1.3 per seed, growing 0.6 % a metre so distant rain stays lines and
not noise), billboarded about that axis (`side = cross(axis, view)`), and
kept ~1.2 device pixels wide at any distance
(`0.6 · dist / (bufferHeight · P[1][1] / 2)`). Alpha fades over the last
of the volume (where a wrap would pop) and within 2 m of the eye. Drawn
count is `streakCount = capacity · √rain` — sub-linear, as rain looks.

The colour is the *bright* part of the sky, not its average: a drop is a
lens showing a demagnified image of the whole deck, so it carries the
brightest quarter of it wherever it happens to be. `Sky.ambient().sky`
pulled toward grey by cloud cover × 2.4, plus a little sun, through
`finish()`, composited premultiplied-**over** (`One / OneMinusSrcAlpha`,
alpha × 0.88 so a sliver stays additive). That is the whole difference
between rain and a white curtain: an additive streak brightens everything
it crosses, an over-composited one reads grey on the deck and bright on
the dark sea, which is what the reference shows. `renderOrder 21`,
depth-tested against the water, no depth write, hidden underwater.

**Ripples.** Drops that hit the sea live in `RainDropletPool`
(`core/rainField.ts`), a 4 096-slot ring buffer spawning `rain · 6000`
impacts/s uniformly over a 64 m square around the camera, the fractional
part carried (`spawnBudget`) so the long-run rate is exact at any frame
rate. `gpu/rainPass.ts` + `rain.frag.glsl` rebuild a 512² RGBA-float field
on that square every frame — cleared and re-stamped, one additive
instanced quad per live drop, no ping-pong and no feedback, because a
ripple is a pure function of its drop's age. The square follows the camera
snapped to its own texel grid (12.5 cm) so the stamps never swim. Per
drop: radius `r0 + ringSpeed · age01 · life` (4 cm → ~40 cm over 0.55 s ±
35 %), amplitude `min(1, age01/0.08) · (1 − age01) · √(r0/R)` — a quick
attack, then the fade of a ring spreading its energy round a growing
circumference. The channels are `(∂h/∂x, ∂h/∂z, wetness, splash)`: a
derivative-of-Gaussian radial slope, a soft disc, and a texel-wide prick
that is gone in a tenth of the ripple's life. `core/rainField.ts` is the
CPU twin of every one of those curves.

**On the water.** `water.frag.glsl` samples the field once, after
shoaling (which flattens the swell, not the drops), inside a branch that
costs nothing at rain 0: the slopes add to the summed cascade derivatives
(`RAIN_SLOPE` 0.9), the wetness mattes the specular (`× (1 − 0.8 w)`) and
pulls the reflection toward the sky's mean, and the rings scatter a little
sky back directly. That last term is what actually reads: under a storm
deck the mirror has no contrast for a perturbed normal to reveal, and a
raindrop ring is surrounded by unresolved capillary ripples that do
scatter. The field fades out 40–110 m from the camera, where a ring is
sub-pixel.

#### Heavy-sea foam

Three terms on top of §1.5's `e = max(prev·decay, source)`, all in
`gpu/foam.frag.glsl` with `core/foamModel.ts` as the closed-form CPU
reference (they are no-ops on the constant fields the e2e oracle feeds, so
the GPU-vs-CPU harness still checks the shader exactly):

1. **Unclamped fold.** `fold = max(threshold − J, 0)` is no longer capped
   at 1: a crest that truly overturns (J < 0) injects in proportion to how
   far it went over, which is what puts dense whitecaps on a gale instead
   of the same saturated cap everywhere.
2. **Advection.** The foam now at a texel was, `dt` ago, up the wave face
   and upwind: `prev` is read bilinearly at
   `p + (slope · slide − windDir · drift) · dt / cell`, `slide` 0.9 m/s per
   unit slope, `drift` 3 % of the wind speed, capped at 3 texels a step (it
   is a warp, not a CFL condition). Foam slides down the face it was made
   on and streaks downwind.
3. **Trough memory + breakup.** Decay time is scaled by
   `1 + troughBoost · sat(J − 1)` (`troughBoost` 1.5), so whitewater parked
   in stretched water outlives the crest that made it; and the injection is
   multiplied by `1 − 0.45 · noise` of two octaves of slowly crawling
   tile-space value noise, so a saturated sheet keeps lace instead of
   blowing out to a flat blob.

Tests: `tests/rainField.test.ts` (the `mod()` wrap holds world position and
stays in the box, velocity vs wind and jitter, streak length and count,
ring kinematics, exact long-run spawn rate, pool determinism / capacity /
reset); `tests/foamModel.test.ts` (the three terms above);
`e2e/gpu.spec.ts` checks `foam.frag.glsl` against `foamModel.ts`.
`e2e/weather.spec.ts`: Storm gives > 1 000 streaks and > 100 live ripples
at intensity 0.9, and against the *same frozen sea* with the rain switched
off it raises the count of bright/dark transitions down a screen column by
3.2× over the cloud deck (where the streaks are the only fine detail) and
1.2× over the whole frame (where the gale's own whitecap lace is
high-frequency too); the toggle and the slider drive the params; Low
empties it; Foggy drizzles; the curtain is hidden underwater; no console
errors. `rain-storm.png` and `preset-storm.png` show the result.

Cost at High, unlocked, three interleaved pairs: 194 → 183 fps, +0.32 ms a
frame (−5.8 %), +1 draw and +15 178 triangles; the ripple stamp reads
0.18 ms of GPU section time. `docs/perf.md` has the table.

Not built: rain lit per drop from the sun's direction, drops on the camera
lens, rain damping the wave spectrum (real rain flattens a sea state),
splash particles in the spray pool, and rain closing the fog down
(visibility is unchanged by the slider).

## 2. Technologies

| concern | choice | why |
|---|---|---|
| rendering | three.js 0.186 (WebGLRenderer) | headless-testable; mature RTT/MRT API |
| shaders | GLSL ES 3.00 via `RawShaderMaterial` | full control, no TSL |
| language | TypeScript 7 strict | review quality |
| build/dev | Vite 8 | trivial; port 5178 |
| unit tests | Vitest 5 | CPU oracle math |
| e2e | Playwright 1.63, chromium-1243, `--headless=new` | real GPU pixels |
| GUI | hand-rolled panel (HTML/CSS) | matches the demo's custom panel |

## 3. Architecture

Four layers, each importing only the ones beneath it: `core` → `gpu` →
`render` → `app`. `core` imports nothing (no three.js, no DOM) and is what
vitest runs; `gpu` is three.js render-to-texture passes; `render` is what
the scene draws; `app` is the demo. Shaders live next to the pass or
material that owns them, imported as strings (Vite `?raw`) and spliced with
`shaders/include.ts`. The tree below is the actual one.

```
src/
  core/        pure TS, no three.js, no DOM. Unit tested.
    params.ts             OceanParams / WaveParams / … types, DEFAULT_PARAMS, QualityTier,
                          tierConfig() (N, finestN, cascades, meshSegments, foam, sss, spray, rain, ssr)
    spectrum.ts           dispersion(), jonswap(), hasselmannSpread(), alphaFor() calibration,
                          bandWeight() seam cross-fade, phi(k)
    rainField.ts          streak wrap + ring kinematics + RainDropletPool (RAIN_TUNING, §1.16)
    random.ts             splitmix32 stream + Box–Muller gaussianPair (seeded)
    fft.ts                CPU radix-2 1-D/2-D complex FFT + inverse (the oracle)
    butterfly.ts          butterfly table (stage × index → srcA, srcB, twiddle)
    cascades.ts           cascadeLayout(): tile sizes, per-cascade N, k-bands + fade widths
    oceanCpu.ts           full CPU reference: params → h0 → h(t) → displacement/derivatives/J
    iwave.ts              iWave vertical-derivative kernel (zero-mean, §1.9 wake)
    rigidbody.ts          6-DOF RigidBody, quaternion helpers, eulerFromQuat, boxInertia
    terrain.ts            islandHeight(x, z, seed), sampleHeightmap(), SEA_STACKS (§1.11)
  gpu/         three.js RTT passes. Pixel tested against core (e2e/gpu.spec).
    passes/FullscreenPass.ts  one shared quad + ortho camera; every pass is one of these
    passes/fullscreen.vert.glsl
    targets.ts            float render-target / DataTexture helpers, floatLinearSupported()
    spectrumPass.ts       + spectrum.frag.glsl   h0(k) texture (runs on wave-param change)
    evolvePass.ts         + evolve.frag.glsl     h̃(k,t) → MRT×4 spectra A–D
    fftPass.ts            + fft.frag.glsl        2·log₂N butterfly passes, ping-pong MRT×4;
                                                 one instance per distinct N, shared by cascades
    unpackPass.ts         + unpack.frag.glsl     (−1)^{x+y} → displacement / derivatives / jacobian
    foamPass.ts           + foam.frag.glsl       persistent foam energy field (cascades 0, 1)
    wakePass.ts           + wake.frag.glsl       iWave height field anchored to the hull (§1.9)
    sprayPass.ts          + spray.frag.glsl      180² particle pool, ping-pong MRT×2 (§1.14)
    rainPass.ts           + rain.frag.glsl       512² rain-ripple field, re-stamped each frame (§1.16)
    cascade.ts            one tile: spectrum → evolve → fft → unpack (→ foam) + its textures
    oceanSim.ts           N cascades from cascadeLayout(); update(t, dt); HeightReadback
    readback.ts           readTarget/readTargetBlock (sync) + AsyncBlockReader (PBO + fence)
    gpuTimer.ts           EXT_disjoint_timer_query_webgl2 sections; NULL_TIMER no-op
    index.ts              public surface of the layer
  render/
    cascadeTextures.ts    the sim→renderer contract: CascadeTextures, CascadeProvider,
                          HeightReadback (OceanSim or a CPU stub can drive the renderer)
    ocean.ts              Ocean: Object3D composing sim + clipmap mesh + WaterMaterial + Sky
                          + ScenePass; update(camera, t, dt), renderSceneDepth(), setTerrain()
    clipmap.ts            clipmapGeometry(segments, rings, baseCell), snapCamera()
    waterMaterial.ts      RawShaderMaterial; uniforms from OceanParams, cascade/terrain/scene/
                          wake bindings, setUnderwater()
    sky.ts                procedural sky → 128² cubemap + skybox; sunDirection, sunColor(),
                          ambient(), moon; version counter for uniform gating
    skyConstants.ts       one colour table for TS and GLSL (#defines via withCommon)
    terrain.ts            Terrain mesh from the heightmap + half-float height texture (§1.11)
    scenePass.ts          colour + depth pre-pass of castsWaterDepth objects (§1.11, §1.12)
    sunShafts.ts          underwater radial light-shaft post (§1.13)
    underwater.ts         camera-locked water-volume box + caustics floor (§1.10)
    vegetation.ts         palms (InstancedMesh, glTF or procedural) + rocks (§1.15)
    vegetationPlacement.ts pure, seeded placement on islandHeight
    shaders/include.ts    withCommon(): splices common.glsl + sky defines into a shader
    shaders/common.glsl   tonemap, sky/sun helpers, underwater fog, cascade fade, terrain
    shaders/water.{vert,frag}.glsl · sky.{vert,frag}.glsl · terrain.{vert,frag}.glsl ·
    shaders/sunShafts.frag.glsl
  app/
    main.ts               composition root: renderer, scene, Ocean, Terrain, Ship, Wake,
                          Spray, SunShafts, cameras, GUI, HUD, loading, RAF loop, window.__app
    gui.ts                right-hand panel (every control has a data-testid)
    hud.ts                HUD line 1 (GPU/FPS/Frame/Draws/Tris/DPR) + line 2 (GPU sections)
    cameras.ts            CameraRig: Orbit (1) / Fly (2) / Boat (3), key state, chase camera
    presets.ts            fairWeather / arctic / corsair / dusk / foggy / moonlit / tropics /
                          storm / sunset (deep-partial patches on DEFAULT_PARAMS)
    buoyancy.ts           Buoyancy: async block readback → heightAt(x, z), covers()
    wake.ts               drives WakePass in boat mode; "Wake Probes" overlay
    loading.ts            five-stage loading overlay (LOADING_MESSAGES)
    ship/ship.ts          Ship group: HullPhysics + model (glTF or procedural) + probes
    ship/hullPhysics.ts   3×5 hull columns on a RigidBody; throttle, rudder, substeps
    ship/hullShape.ts     hull lines shared by the loft and the buoyancy columns
    ship/shipModel.ts     procedural galleon (the fallback)
    ship/probesOverlay.ts "Buoyancy Probes" discs + force arrows
    spray/sprayField.ts   pure spawn/velocity/lifetime rules (SPRAY_TUNING) + CPU pool
    spray/spraySystem.ts  drives SprayPass, draws it as Points
    rain/rainSystem.ts    the streak curtain (instanced quads) + drives RainPass (§1.16)
    assets/shipLoader.ts  GLTFLoader + Meshopt → dressed galleon, HullDimensions
    assets/shipMaterials.ts  shared MeshStandardMaterial set (hull, sail, iron, …)
    assets/proceduralTextures.ts  wood / canvas / rope / frond DataTextures
    styles.css
tests/         vitest, 19 files / 161 tests: core + pure app logic (see §4)
e2e/           playwright, 6 specs / 51 tests: gpu.spec, render.spec, app.spec,
               spray.spec, weather.spec, assets.spec; pages/{gpu,render}.{html,ts}
               test harnesses; __screenshots__/ (committed)
scripts/       perf.mjs (headless fps sweep, GPU section table), buildShipAsset.mjs
               (OBJ → classified glTF galleon)
public/assets/ models/galleon.glb, palm-{tall,short,bend}.glb, LICENSES.md
```

Data flow per frame: `OceanSim.update` runs evolve → FFT → unpack (→ foam)
per cascade; `Ocean.update` binds the cascade textures and the sky;
`Ocean.renderSceneDepth` draws the terrain, ship and vegetation into the
scene pre-pass; the wake and spray passes step; then the main render (or,
underwater, the sun-shaft chain) draws the water, sky and scene.

### Key interfaces

```ts
// core/params.ts
export interface OceanParams { waves: WaveParams; color: ColorParams;
  foam: FoamParams; sss: SssParams; fog: FogParams; sun: SunParams;
  sky: SkyParams; fresnel: FresnelParams; spray: SprayParams;
  underwater: UnderwaterParams; quality: QualityTier; maxScale: number }
export type QualityTier = "low" | "medium" | "high" | "ultra" | "max";
export interface TierConfig { N: number; finestN: number; cascades: number;
  meshSegments: number; foam: boolean; sss: boolean; spray: boolean; ssr: boolean }
export function tierConfig(t: QualityTier): TierConfig;

// core/cascades.ts
export interface CascadeLayout { size: number; N: number; kMin: number;
  kMax: number; kMinWidth: number; kMaxWidth: number }
export function cascadeLayout(maxScale: number, tier: QualityTier,
  Ns?: readonly number[]): CascadeLayout[];   // Ns overrides per-cascade N; bands unchanged

// core/rigidbody.ts
export class RigidBody { constructor(opts: { mass; inertia: Vec3; linearDrag?; angularDrag? });
  position; orientation; velocity; angularVelocity;
  applyForce(f); applyTorque(t); applyForceAt(f, worldPoint); velocityAt(worldPoint);
  localToWorld(p); worldToLocal(p); integrate(dt); reset(position, yaw?) }

// render/cascadeTextures.ts
export interface CascadeTextures { size; N; displacement; derivatives; jacobian; foam | null }
export interface CascadeProvider { cascades: readonly CascadeTextures[];
  setParams(p); update(t, dt); contextRestored?(); dispose() }
export interface HeightReadback { readDisplacementBlock(cascade, x, y, w, h): Float32Array;
  issueDisplacementBlock(slot, cascade, x, y, w, h): void;
  consumeDisplacementBlock(slot): Float32Array | null }

// gpu/oceanSim.ts — implements CascadeProvider & HeightReadback
export class OceanSim { constructor(renderer, params); cascades: Cascade[];
  timer: GpuTimer; setParams(p); update(t, dt); getParams(); contextRestored(); dispose() }

// render/ocean.ts
export class Ocean extends THREE.Object3D {
  constructor(renderer, params, opts?: { rings?; baseCell?; sim?: CascadeProvider; timer? });
  sim; sky: Sky; scenePass: ScenePass; material: WaterMaterial; mesh: THREE.Mesh;
  setParams(p); update(camera, t, dt); setTerrain(tex, x, z, extent);
  renderSceneDepth(scene, camera); stats(): { draws; tris }; contextRestored(); dispose() }

// render/scenePass.ts
export const SCENE_LAYER = 1;
export class ScenePass { constructor(renderer); color: Texture; depth: Texture;
  width; height; render(scene, camera); dispose() }

// render/sunShafts.ts
export class SunShafts { constructor(renderer); options: SunShaftOptions;
  sunDirW: Vector3; sunUv: Vector2; strength: number; get active();
  update(camera, sky, params, depthBelow, caustics, time); render(scene, camera, timer?); dispose() }

// gpu/sprayPass.ts
export class SprayPass { constructor(width, height); slots; positions; velocities;
  reset(); render(renderer, inputs: SprayInputs); count(renderer): { alive; crest; bow }; dispose() }

// app/ship
export class HullPhysics { static LENGTH/BEAM/DRAFT/CRUISE; body: RigidBody;
  samples: readonly HullSample[]; dims: HullDimensions; throttle; rudder;
  mass; heading; pitch; roll; speed; reset(x, y, z, heading?); step(dt, water: HeightSampler) }
export class Ship extends THREE.Group { physics: HullPhysics; model; modelKind: "gltf" | "procedural";
  probes: ProbesOverlay; setModel(model, dims, kind, dispose?); reset(…);
  update(dt, throttle, rudder, water) }

// app/main.ts — window.__app (the e2e test API)
interface AppApi { ready: Promise<void>; assetsReady: Promise<void>;
  params(); setParam(path, v); setPreset(name); setQuality(tier); setMode(m);
  frame(); step(dt, frames?); advance(seconds, dt?); simTime(); stats(): HudStats;
  setGpuTimer(on); contextLost(); camera(); setCameraPosition([x, y, z]);
  setCameraDirection([x, y, z]); underwater(); sunShafts(); spray(); hull(); ship();
  vegetation(); wakeSample(dx, dz); snapshot(name); diff(a, b); pixel(u, v); preset() }
```

## 4. Testing strategy

Three suites, all green per commit (`npm run typecheck`, `npx vitest run`,
`npx playwright test`): **vitest 19 files / 161 tests**, **playwright
6 specs / 51 tests**.

- **core + pure app logic (vitest, `tests/`):** `fft` (1-D/2-D vs naive
  DFT, round-trip), `butterfly` (table vs brute force, stage application),
  `random` (splitmix32 determinism, Gaussian moments), `spectrum`
  (dispersion, JONSWAP peak/integral, Hasselmann normalisation,
  `bandWeight` seam fade, `phi`, wave-height calibration), `cascades`
  (`tierConfig`, defaults/clone, layout contiguous and non-overlapping,
  `finestN`), `oceanCpu` (initial spectrum, evolve, zero-mean simulate whose
  RMS grows with wind), `clipmap` (ring geometry, seam `ring` equality,
  camera snapping), `iwave` (kernel and zero-mean variant), `rigidbody`,
  `hullPhysics` (2 m drop settles < 5 s, throttle, rudder, seas), `buoyancy`
  (block sampler against a stub readback), `terrain` (determinism, peak,
  beach band, seabed, stacks, heightmap), `vegetationPlacement`,
  `sprayField` (spawn rules, velocities, lifetimes, gravity, drag, bow
  gating), `foamModel` (the three heavy-sea terms of §1.16), `rainField`
  (streak wrap, ring kinematics, exact long-run spawn rate, pool
  determinism), `skyConstants` (TS table == GLSL defines), `assetBudget`
  (bytes under `public/assets/` ≤ 15 MB), `threeCompat` (sentinels for the
  three.js hooks we rely on, e.g. `isXRRenderTarget`).
- **gpu (playwright, `e2e/gpu.spec.ts`, real WebGL2):** `e2e/pages/gpu.html`
  exposes `window.__gpu`; the FFT pass at N=16/64 forward and inverse equals
  `core.fft2d`; `simulate(64)` equals `core.simulate` for default waves,
  wind 15, a band-limited cascade with choppiness, and standing waves; the
  foam field's source and `e^{-1}` decay; `OceanSim` builds the tier's
  cascades with foam on 0 and 1 only and no GL errors.
- **render (`e2e/render.spec.ts`):** `e2e/pages/render.html` drives `Ocean`
  with a CPU stub `CascadeProvider` (N=64 DataTextures) — centre pixel
  bluish, night darker than noon, wind 25 ≠ wind 3, storm has more
  near-white foam than calm, terrain peak is rock/sand, lighting is
  world-space under a camera roll, shoreline whiter than 200 m out.
- **app (`e2e/app.spec.ts`, `spray.spec.ts`, `weather.spec.ts`,
  `assets.spec.ts`):** loading overlay order, unsupported-GPU message,
  WebGL context loss and restore, HUD numeric and no console errors, panel
  formatting, every preset and tier renders (screenshots to
  `e2e/__screenshots__/`), orbit drag changes pixels, fly/boat modes, ship
  drop/throttle/rudder/probes, wake behind the hull and not ahead,
  underwater and sun shafts, key H, resize, rebuilding pill, island and SSR
  pixel checks, spray counts and toggle, rain streaks and ripples, glTF
  ship/palms load with fallbacks.
- **Deterministic driver.** `__app.step(dt, frames)` pauses the RAF loop
  and ticks the sim by exact fixed steps; `__app.advance(seconds)` is
  `step(dt, round(seconds/dt))`. e2e tests use these instead of sleeps, so
  sim time does not depend on the machine (a dedicated test asserts the
  clock and that RAF resumes).
- **Perf gate:** the spec's "High ≥ 30 fps at 1280×800 headless" is
  measured by `scripts/perf.mjs` and reported, not asserted. As measured
  (`docs/perf.md`, Apple M5, ANGLE Metal): vsync-paced headless pins every
  tier at 60 fps; unlocked, Low ~430, Medium ~320 (finest cascade N=128),
  High ~175, Ultra/Max ~65 fps; SSR costs ~1 ms/frame at DPR 1; the GPU
  timer costs ~6 % and is off by default.

## 5. Demo UI (mirrors the original)

**Left card:** big FPS, mode buttons `1 Orbit / 2 Fly / 3 Boat`, legend
Orbit LMB · Pan RMB · Zoom Scroll.

**Right panel "FFT OCEAN — DEMO"** (`src/app/gui.ts`, every control carries
a `data-testid`): Quality select (Low/Medium/High/Ultra/Max), Preset select
(Fair Weather, Arctic, Corsair, Dusk, Foggy, Moonlit, Tropics, Storm,
Sunset), sliders Wind Speed (m/s), Peak Wavelength (m), Time of Day
(HH:MM), Cloud Coverage (%), Spray Density (×), Rain (%,
`data-testid="rainAmount"`); toggles Buoyancy Probes (hull sample discs +
force arrows), Wake Probes (cyan hull ring + wake field plane — real,
§1.9), Reflections (SSR) (greyed on Low), Sun Shafts, Spray (greyed on
Low), Rain (greyed on Low, §1.16), Force WebGL (checked and disabled:
WebGL2 is the only backend); Pixel Ratio slider (0.5–2); Source / Docs
links; a "Rebuilding Shaders…" pill during a quality change.

**Loading screen** messages in order: LOADING MODELS & WATER → LOADING
ENVIRONMENT → GENERATING SKY → COMPILING SHADERS → READY (`loading.ts`;
the log stays in the DOM for the test).

**HUD** (bottom left, refreshed every 250 ms): line 1 `GPU WebGL2 · FPS ·
Frame ms · Draws · Tris · DPR`; line 2 GPU section timings `GPU ms total ·
spectrum · fft · unpack · prepass · water · spray · rain · wake · post` from
`EXT_disjoint_timer_query_webgl2` (`GPU ms off` unless enabled, `n/a`
without the extension).

**Keys:** `1`/`2`/`3` camera mode; `W A S D` move (Fly) / throttle + rudder
(Boat); `Q`/`E` down/up and `Shift` fast (Fly); `H` hides the UI.

**URL flags:** `?gpuTimer=1` turns the GPU section timer on at boot;
`?ship=procedural` keeps the procedural galleon instead of the glTF;
`?palms=procedural` keeps the procedural palms.

## 6. Status and roadmap

Everything in §1 is built and covered by the suites above: the FFT
pipeline and its cascades, the shading and sky, the clipmap, the island and
shoreline, the rigid-body ship and its wake, screen-space reflections, the
underwater volume and sun shafts, spray, the glTF assets, and the weather
pass. A WebGPU backend behind the "Force WebGL" toggle is deliberately not
built (§0).

Open items, in priority order, are kept in `docs/roadmap.md`: water tone
against the reference, storm whitecap density and the Kelvin wake angle,
SSR's uniform march and lack of roughness blur, sun shafts unoccluded by
ship/terrain, spray shadowing/soft depth, clipmap per-ring snapping, and
the WebGPU backend. The engineering review and its resolutions are in
`docs/engineering-review.md`; measured performance in `docs/perf.md`.
