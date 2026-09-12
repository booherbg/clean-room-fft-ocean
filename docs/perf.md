# Performance

Headless numbers for each quality tier, measured with `scripts/perf.mjs`.
The [performance pass](#performance-pass) section near the end has the
current before/after tables and the GPU section breakdown; the tables above
it predate the island, the ship and SSR and are kept for the tier-shape
discussion.

## Setup

- **Machine:** Apple M5 (Mac), macOS. GPU string from
  `WEBGL_debug_renderer_info`: `ANGLE (Apple, ANGLE Metal Renderer: Apple M5,
  Unspecified Version)`.
- **Browser:** Chrome for Testing (Playwright `chromium-1243`), `--headless=new`,
  `--use-angle=metal --ignore-gpu-blocklist` — the exact launch options from
  `playwright.config.ts`, which the script imports.
- **Viewport:** 1280×800, `deviceScaleFactor: 1` (HUD DPR = 1).
- **Scene:** the `fairWeather` preset the app boots into, Orbit camera at its
  default position, buoyancy probes off.
- **Method:** `window.__app.setQuality(tier)`, settle 1 s, then await
  `window.__app.frame()` in a loop for 3 s and count frames. `ms/frame (wall)`
  is that loop's mean inter-frame interval; `ms/frame (CPU submit)` is the
  HUD's `stats().frameMs`, i.e. main-thread time from the top of the RAF tick
  to the end of `renderer.render()` (simulation passes + scene submit, no GPU
  wait). `draws`/`tris` are `renderer.info.render` after the scene render.

```sh
node scripts/perf.mjs                                    # vsync, as the e2e tests run
node scripts/perf.mjs --unlocked                         # + --disable-frame-rate-limit --disable-gpu-vsync
node scripts/perf.mjs --url http://localhost:5179        # against `vite preview` of a build
node scripts/perf.mjs --tiers medium --set fresnel.ssr=false   # subset of tiers; param overrides
node scripts/perf.mjs --unlocked --gpu-timer                   # + GPU section table (timer queries on)
```

## Results — vsync (default headless)

Headless Chromium still paces `requestAnimationFrame` at 60 Hz, so every
tier pins to 60 fps and the wall column is uninformative. This is the
configuration the perf gate in the spec (§4, "High ≥ 30 fps") is measured in;
it passes trivially.

| tier | N | cascades | draws | tris | fps | ms/frame (wall) | ms/frame (CPU submit) |
|---|---|---|---|---|---|---|---|
| low | 256 | 1 | 2 | 4,364 | 60.0 | 16.67 | 0.15 |
| medium | 256 | 2 | 2 | 17,420 | 60.1 | 16.63 | 0.29 |
| high | 256 | 3 | 2 | 69,644 | 60.1 | 16.65 | 0.37 |
| ultra | 512 | 3 | 2 | 69,644 | 60.1 | 16.64 | 0.19 |
| max | 512 | 3 | 2 | 69,644 | 60.0 | 16.67 | 0.22 |

## Results — unlocked (`--disable-frame-rate-limit --disable-gpu-vsync`)

The number that actually says something about cost per tier.

| tier | N | cascades | draws | tris | fps | ms/frame (wall) | ms/frame (CPU submit) |
|---|---|---|---|---|---|---|---|
| low | 256 | 1 | 2 | 4,364 | 549.5 | 1.82 | 2.71 |
| medium | 256 | 2 | 2 | 17,420 | 404.2 | 2.47 | 2.54 |
| high | 256 | 3 | 2 | 69,644 | 304.9 | 3.28 | 3.38 |
| ultra | 512 | 3 | 2 | 69,644 | 71.7 | 13.95 | 13.72 |
| max | 512 | 3 | 2 | 69,644 | 80.6 | 12.41 | 12.25 |

## Screen-space reflections (spec §1.12)

Measured against a `vite preview` build with the island and
the ship in the scene (the default view; `draws` is 4 and `tris` ~147 k at
Medium since the terrain landed, so these rows are not comparable with the
tables above). Unlocked, medium tier, settle 2 s, sample 6 s, two runs each:

| SSR | fps | ms/frame (wall) | ms/frame (CPU submit) |
|---|---|---|---|
| on (`fresnel.ssr=true`) | 191.1 / 192.7 | 5.23 / 5.19 | 4.22 / 4.06 |
| off (`fresnel.ssr=false`) | 240.7 / 237.7 | 4.15 / 4.21 | 3.17 / 3.16 |

```sh
node scripts/perf.mjs --unlocked --url http://localhost:5179 --tiers medium --settle 2000 --sample 6000 --set fresnel.ssr=true
node scripts/perf.mjs --unlocked --url http://localhost:5179 --tiers medium --settle 2000 --sample 6000 --set fresnel.ssr=false
```

- The march (24 steps + 4 refinements, one depth fetch each, per water
  pixel) costs **~1.0 ms at 1280×800** — it is fragment-bound, so expect
  ~4 ms at DPR 2. The Low tier forces it off.
- Both rows include the scene pre-pass (`ScenePass`: terrain + ship into a
  half-float colour target with a float depth texture), which the shallows
  and shoreline need regardless of the toggle; the toggle only removes the
  march and the scene-colour refraction fetch.
- The CPU-submit column moves with the toggle even though the JS work is
  identical: with vsync off the main thread waits on the GPU inside
  `renderer.render()` (see below), so it tracks GPU time.

## Reading the numbers

- **N dominates.** Going from N=256 to N=512 with the same three cascades
  costs ~4× per frame (3.3 ms → ~13 ms): the 2·log₂N butterfly passes each
  touch N² texels of four MRT float targets, so it scales as N²·log₂N ×
  cascades. Ultra/Max at 1280×800 are ~75 fps unlocked on this GPU; High is
  the comfortable default.
- **Cascades are roughly linear.** Low → Medium → High (1 → 2 → 3 cascades at
  N=256) is 1.8 → 2.5 → 3.3 ms.
- **The mesh is cheap.** Tris only differ through `meshSegments` (16/32/64);
  Ultra and Max share High's mesh. Vertex shading with three displacement
  fetches per vertex does not register against the FFT.
- **Ultra vs Max** differ only in tile sizes (1024/96/9 vs 1024/48/2.25 m),
  not in work; the gap between them is run-to-run noise (± ~10 fps at this
  frame time).
- **`draws` = 2** is the scene pass only (clipmap + skybox). Every simulation
  pass is its own `renderer.render()` into a render target, and three.js
  resets `renderer.info` per call, so spectrum/evolve/FFT/unpack/foam
  passes are not in this count. Per frame and per cascade that is
  1 evolve + 2·log₂N FFT + 1 unpack + 1 foam fullscreen draws (19 at N=256,
  21 at N=512).
- With vsync off, `CPU submit ≈ wall`: the main thread is issuing work as
  fast as the GPU drains it, i.e. we are GPU-bound, not JS-bound.

## Caveats

- **Headless, not a window.** Same GPU path (ANGLE → Metal), but no
  compositor, no display scaling, no other tabs. Treat as an upper bound on
  what a real window sees at the same resolution.
- **ANGLE over Metal**, not native GL: float MRT and the `readPixels` used
  by buoyancy go through ANGLE's translation. Different backends
  (D3D11, Vulkan, native GL on Linux) will differ in absolute terms.
- **vsync caps at 60 in default headless**, which is why the unlocked table
  exists; `--disable-frame-rate-limit --disable-gpu-vsync` is a Chromium-wide
  switch, not a per-page one, so the script launches a separate browser for
  that mode.
- **Measure against a static build when the dev server is busy.** Vite pushes
  a full reload whenever a source file under `src/` changes; that destroys
  the page's execution context mid-sample. `--url` against
  `npx vite build && npx vite preview --port 5179` sidesteps it (the tables
  above were taken that way).
- **3 s samples**, single run per tier, no warm-up beyond the 1 s settle.
  Good to ±5 %; do not read the second decimal.
- DPR 1 only. At DPR 2 the fragment cost of the water shader (three cascade
  fetches, cubemap reflection, foam) quadruples while the FFT cost does not
  change, so the tier gaps narrow on a Retina display.

## Performance pass

Four changes, each measured against a `vite preview` build of the tree
before the pass (`dist-before`) and after it, unlocked, 1280×800 DPR 1,
settle 2 s, sample 5 s, default scene (island + ship, Orbit camera,
buoyancy probes off), GPU timer queries **off** in both unless stated.
Before/after sweeps were interleaved (before, after, before, after, …)
because this machine drifts a few percent slower with every consecutive
sweep; the pairs below are one interleaved pair each, and the spread across
the four pairs taken was ±6 % — anything inside that is noise.

1. **GPU timer queries** (`src/gpu/gpuTimer.ts`): `EXT_disjoint_timer_query_webgl2`,
   async, polled at the top of the frame; sections spectrum+evolve, FFT,
   unpack+foam, scene pre-pass, water, spray, post. HUD line 2 and
   `__app.stats().gpu`; `n/a` without the extension.
2. **Texture/pass reuse**: one `FftPass` (ping-pong targets + butterfly
   table) per distinct N shared by every cascade; one fullscreen quad +
   ortho camera shared by every `FullscreenPass`; no per-frame target
   allocation.
3. **Half-resolution finest cascade on Medium**: the 9 m tile runs at N=128
   while the 1024 m tile stays at 256 (`TierConfig.finestN`). The band
   layout depends on tile sizes only, so kMin/kMax are unchanged and the
   cascades still abut (unit test); only the finest tile's Nyquist drops,
   from 89 to 45 rad/m — waves shorter than 14 cm, sub-pixel at any sensible
   camera distance.
4. **Frame budget hygiene**: buoyancy readback is asynchronous (`readPixels`
   into a `PIXEL_PACK_BUFFER` + `fenceSync`, consumed the next frame, one
   frame of latency, no stall); sky uniforms are re-sent only when the sky
   changes (`Sky.version`); temporaries in the spray, buoyancy, camera and
   ambient paths were hoisted so `update()` allocates nothing per frame.

### Per tier, before → after (fps / ms wall / ms CPU submit)

| tier | N (coarse/finest) | before | after | Δ fps |
|---|---|---|---|---|
| low | 256 | 449.9 / 2.22 / 2.25 | 424.6 / 2.36 / 2.33 | −6 % (noise) |
| medium | 256 → 256/128 | 251.0 / 3.98 / 3.96 | 311.4 / 3.21 / 3.17 | **+24 %** |
| high | 256 | 177.0 / 5.65 / 5.71 | 171.8 / 5.82 / 5.82 | −3 % (noise) |
| ultra | 512 | 64.9 / 15.40 / 15.21 | 64.1 / 15.61 / 15.56 | −1 % |
| max | 512 | 66.3 / 15.09 / 14.95 | 66.2 / 15.10 / 15.04 | 0 % |

Second interleaved pair, same setup: low 476.0 → 437.8, medium 274.1 → 323.7,
high 191.8 → 175.4, ultra 67.1 → 65.1, max 68.1 → 67.1 (the "after" in that
pair had the timer on). Draws/tris after: low 3 / 134,414; medium 4 /
147,470; high+ 4 / 199,694 — unchanged by the round.

- **Medium is the win: +24–28 %**, all from the half-resolution finest
  cascade (the FFT scales as N²·log₂N, so the small tile now costs a
  quarter of what it did).
- **Low, High, Ultra, Max are flat.** Sharing the FFT targets and the quad
  saves memory (one set of four float MRT ping-pong targets per N instead
  of per cascade) and CPU allocations, not GPU time — the passes were
  already reusing their targets frame to frame. The sky-uniform gating and
  the hoisted temporaries move nothing measurable on a GPU-bound frame.
- **Boat mode** (buoyancy probes on) is where the async readback shows:
  medium 233.9 → 310.2 fps, high 158.8 → 195.3 fps (`scripts/perf.mjs`
  does not drive Boat mode; these were taken with a one-off script that
  called `__app.setMode("boat")` and otherwise used the same settle/sample).
  Before, `readRenderTargetPixels` on three cascades stalled the pipeline
  every frame; now the main path has no synchronous readback at all.

### GPU section breakdown (this machine, timer on)

`node scripts/perf.mjs --unlocked --url http://localhost:5179 --settle 2000 --sample 5000 --gpu-timer`,
EMA-smoothed ms per section. `post` only runs underwater and is `—` here.

| tier | spectrum | fft | unpack | prepass | water | spray | sum | frame (wall) |
|---|---|---|---|---|---|---|---|---|
| low | 3.18 | 2.87 | 2.94 | 1.24 | 1.82 | 0.56 | 12.62 | 2.27 |
| medium | 1.47 | 1.83 | 1.67 | 0.93 | 1.26 | 0.23 | 7.40 | 3.09 |
| high | 2.51 | 2.06 | 2.39 | 0.97 | 1.61 | 0.50 | 10.04 | 5.71 |
| ultra | 4.08 | 2.76 | 3.21 | 1.29 | 2.28 | 0.86 | 14.48 | 15.43 |
| max | 11.00 | 17.49 | 13.02 | 2.92 | 2.60 | 4.45 | 51.49 | 15.09 |

Read this table with the ANGLE-Metal caveat firmly in mind:

- **The sum exceeds the frame time** (12.6 ms of sections in a 2.3 ms
  frame at Low). ANGLE over Metal implements a `TIME_ELAPSED` query by
  splitting the command buffer, and the reported interval covers that
  buffer's scheduling and everything in flight alongside it, so sections
  overlap and each carries a large fixed cost. `spectrum` (2 fullscreen
  draws per cascade) reading about the same as `fft` (16 draws per cascade
  at N=256) says the numbers are overhead-dominated at N=256. The empty
  calibration section reads 0.00 because it is issued at the top of the
  frame with nothing in flight — it does not capture that overhead.
- **Max is the one tier where the sections are informative**: N=512 with
  three cascades is big enough that `fft` (17.5) > `unpack` (13.0) ≈
  `spectrum` (11.0) ≫ `prepass`/`water`, i.e. the FFT chain is ~80 % of the
  GPU and the shading is a rounding error. Ultra should look the same and
  does not (its sections read like High's) — Ultra and Max differ only in
  tile sizes, and the section readings drift with frame-to-frame
  scheduling; treat the per-section ratios, not the absolute values, as
  the signal.
- **Relative ordering across tiers still tracks the frame**: Medium's sum
  is the smallest (7.4 ms) because its finest cascade is N=128.
- On native GL / D3D11 / Vulkan the queries are cheap and do not overlap;
  there the table would be worth reading literally. Re-measure there before
  drawing conclusions from the Metal numbers.

### Cost of the timer itself

Every query splits a Metal command buffer, and the app issues ~11 per
frame at High (3 cascades × 3 sections + pre-pass + water). Same build,
same sweep, timer off vs on: low 473.5 → 440.8 fps (−7 %), medium
347.6 → 323.3 (−7 %), high 187.0 → 175.2 (−6 %), ultra 66.0 → 64.8 (−2 %),
max 67.8 → 66.2 (−2 %). The queries also change *where* the main thread
waits: with them on, Low's CPU-submit column drops from ~2.2 ms to
~0.2 ms while the wall time does not — the GPU wait moves from inside
`renderer.render()` to the swap.

The timer is off by default (the HUD's second line reads "GPU ms off");
`?gpuTimer=1` in the URL or `__app.setGpuTimer(true)` turns it on.
`scripts/perf.mjs` measures with it off unless passed `--gpu-timer`, and
the numbers in the per-tier table above were taken that way.

## Rain (spec §1.16)

Measured on the same machine, against the dev server, unlocked,
High only, the `fairWeather` preset at the default Orbit camera (the scene the
tables above use — the rain is the only variable):

```sh
node scripts/perf.mjs --unlocked --tiers high --set weather.rain=0
node scripts/perf.mjs --unlocked --tiers high --set weather.rain=0.9
```

Three interleaved pairs, settle 1 s, sample 3 s, timer off:

| rain | draws | tris | fps (3 runs) | mean fps | mean ms/frame (wall) |
|---|---|---|---|---|---|
| 0 (off) | 11 | 225,766 | 209.3 / 186.9 / 186.4 | 194.2 | 5.16 |
| 0.9 (Storm) | 12 | 240,944 | 195.2 / 178.4 / 175.4 | 183.0 | 5.48 |

**+0.32 ms a frame, −5.8 % fps.** Where it goes:

- **One extra draw call and 15,178 triangles** — the streak curtain, a
  single instanced mesh of `8000 · √0.9 = 7589` quads. No per-frame CPU
  work at all: the positions are a `mod()` of a static seed buffer against
  the clock in the vertex shader, so the app only writes eight uniforms.
  The cost is overdraw of ~1.2-pixel-wide alpha-blended quads, which is
  small at 1280×800 and would scale with resolution, not with the tier.
- **The ripple stamp reads 0.18 ms** of GPU section time (`--gpu-timer`,
  same caveats as the section table above — each query splits the Metal
  command buffer, so read the ratios, not the absolutes): one clear plus
  ~3 000 instanced ring quads into a 512² RGBA-float target.
- **The water shader's rain block is free when it is off** — `rain 0`
  leaves `uRainIntensity` at 0 and the whole sample + shading block is
  branched over, so nothing above changes for the eight dry presets.
- **CPU:** `RainDropletPool.step` spawns ~100 impacts a frame and
  `fillAttributes` scans its 4 096 slots; both are well under the noise
  floor of the `ms/frame (CPU submit)` column, which tracks the wall
  column throughout.

Run-to-run drift on this machine is larger than the effect on a single
pair (the first "off" run was 209 fps and the third 186), which is why the
runs are interleaved and averaged. Rain is off on Low
(`tierConfig(...).rain`), so the cheapest tier never pays it.
