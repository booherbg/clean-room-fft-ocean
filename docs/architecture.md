# Architecture

Where the code lives, what may import what, and how to run and test it.
The physics and shading are in [`design.md`](design.md); measured
performance is in [`perf.md`](perf.md).

## What this is

A clean-room reimplementation of the *observable* behaviour of a commercial
three.js ocean demo: a Tessendorf/JONSWAP FFT ocean on WebGL2 with an
island, a sailable galleon, screen-space reflections, underwater sun
shafts, spray, rain and a boat wake. Written for fun, but held to
"passable for engineering review".

## Ground rules

1. **Clean room.** Everything derives from published literature (Tessendorf
   2001, Hasselmann 1973/1980, JONSWAP, Horvath 2015, Tessendorf 2004 for
   iWave, Mitchell 2007 for light shafts), from the vendor's public API
   documentation, and from watching the public demo run in a browser. The
   product's shipped bundle is obfuscated and its licence forbids
   deobfuscation: it was never read, and no copy of it has ever been in this
   repository. Spec §0 states the boundary in full, and the README
   summarises it.
2. **WebGL2, not WebGPU.** Headless WebGPU is fragile on the development
   machine, so the FFT runs as fragment-shader ping-pong passes instead of
   WebGPU/TSL compute. This is the one deliberate divergence from the
   original — spec §0 has the reasoning.
3. **The suite is green at every commit:** `npm run typecheck`,
   `npx vitest run`, `npx playwright test`.

## Documents

| doc | role |
|---|---|
| [`design.md`](design.md) | the design spec: §0 ground rules, §1 physics and rendering, §2 technologies, §3 architecture, §4 tests, §5 UI, §6 status |
| [`engineering-review.md`](engineering-review.md) | a read-only review of the whole repo: 15 findings, with how each was resolved |
| [`roadmap.md`](roadmap.md) | what is built and what is deliberately not |
| [`perf.md`](perf.md) | per-tier fps, GPU section timings, ANGLE/Metal caveats |
| [`../README.md`](../README.md) | what it is, how to run it, the controls |
| [`../public/assets/LICENSES.md`](../public/assets/LICENSES.md) | source, author and licence of every shipped asset |

Source comments cite the spec by section (`spec §1.14`), so the § numbering
is stable: renumber a section and the comments go stale.

## Layout

```
src/core/     pure TS, no three.js — spectrum, random, fft, butterfly,
              cascades, oceanCpu (CPU oracle), params, iwave, rigidbody,
              terrain, foamModel, rainField
src/gpu/      RTT passes: spectrum, evolve, fft, unpack, foam, wake, spray,
              rain, cascade, oceanSim, targets, readback (async PBO),
              gpuTimer, passes/FullscreenPass (one shared quad)
src/render/   clipmap, waterMaterial + shaders/{water,common,include}, sky +
              skyConstants (TS table → GLSL defines), terrain (+ shaders),
              scenePass (colour + depth pre-pass of castsWaterDepth objects,
              feeds SSR/refraction/shoreline), sunShafts (post), underwater,
              vegetation + vegetationPlacement, ocean (composition of the above)
src/app/      main (composition root + `window.__app` test API), gui, hud,
              cameras (Orbit/Fly/Boat), presets, buoyancy, wake, loading,
              gpuWatch (which stage a WebGL context loss happened in),
              ship/{ship,shipModel,hullShape,hullPhysics,probesOverlay},
              spray/{sprayField (pure), spraySystem}, rain/rainSystem,
              assets/{shipLoader, proceduralTextures, shipMaterials}
tests/        vitest (core + pure app logic)         19 files, 161 tests
e2e/          playwright: gpu.spec (GPU vs CPU oracle), render.spec,
              app.spec, spray.spec, weather.spec, assets.spec;
              pages/{gpu,render}                     6 specs, 52 tests
scripts/      perf.mjs (build+preview fps sweep), buildShipAsset.mjs
```

**Layer rule:** `core` → `gpu` → `render` → `app`, and each layer imports
only the ones beneath it. `core` imports nothing at all — no three.js, no
DOM — which is what lets vitest run it in node and what makes it usable as
the oracle the GPU passes are checked against. Nothing enforces the rule
mechanically; it is checked by review and by the fact that `core` would
stop running under vitest the moment it imported three.

Spec §3 has the same tree file by file, with a one-line responsibility for
each and the key interfaces between the layers.

## Test API (`window.__app`)

`main.ts` hangs a small API off `window` for the e2e suite:

`ready, assetsReady, params, setParam, setPreset, setQuality, setMode,
frame, step(dt, frames), advance(seconds), simTime, stats (incl. `.gpu`),
setGpuTimer, contextLost, camera, setCameraPosition, setCameraDirection,
underwater, sunShafts, spray, rain, hull, ship, vegetation, wakeSample,
snapshot, diff, pixel, column, preset, gpuWatch`.

Two things to know about it:

- **`step` / `advance` drive time deterministically.** They pause the RAF
  loop and tick the sim by exact fixed steps, so a test's sim time does not
  depend on how fast the machine renders. Use them instead of sleeps.
- **`column(u)` reads a one-pixel-wide strip** of the frame, and only one
  read may be pending at a time.

## Running

```sh
npm i
npm run dev            # http://localhost:5178
npm run typecheck
npx vitest run
lsof -ti:5178 | xargs kill; npx playwright test
node scripts/perf.mjs --tiers medium,high
```

Playwright launches a pinned Chrome for Testing build (`chromium-1243`)
with `--headless=new`, which is the full browser with a GPU process — the
tests need real ANGLE/Metal WebGL2 and float render targets, not
SwiftShader. The README explains the launch options.

URL flags: `?gpuTimer=1` turns on GPU section timing (it costs ~6 %, so it
is off by default); `?ship=procedural` and `?palms=procedural` skip the
glTF assets and use the procedural fallbacks; `?diag=1` makes `gpuWatch`
probe the GPU after every stage of every frame (normally only the first
eight frames after a mode switch), so a context loss is charged to the
stage that caused it rather than to the end of the frame.

## When the GPU goes away

A WebGL context loss (driver reset, the browser killing its GPU process,
a phone's GPU giving up on a heavy frame) fires `webglcontextlost`
*after* the frame that caused it. `app/gpuWatch.ts` keeps a breadcrumb of
the stage the frame is in and, for a few frames after anything that
changes the workload, calls `gl.finish()` plus a one-texel `readPixels`
after each stage so a loss surfaces inside the stage that triggered it.
The report (stage, frame, mode, GPU string, tier, buffer size, UA) is shown
on the loading overlay, logged with `console.warn`, and stored in
`localStorage["fft-ocean.lastContextLoss"]`; if the *next* visit cannot
create a WebGL2 context, the unsupported-GPU gate quotes both the
browser's `webglcontextcreationerror.statusMessage` and that stored
report, so a phone that will not run the demo can still say why.

On `webglcontextrestored`, `main.ts` runs `rebuild(tier, force=true)`:
the sim, wake, readback PBOs, fences and timer queries are reset before
any tick runs on the new context. Objects that were uploaded before the
loss are dropped, not disposed — three's old `WebGLTextures` /
`WebGLGeometries` instances keep their `dispose` listeners across a
restore and would try to delete GL objects that no longer exist (one
`INVALID_OPERATION: delete: object does not belong to this context` per
object). The e2e suite covers the whole path with `WEBGL_lose_context`.

## Known flakes

- **A stale dev server on :5178.** Playwright reuses an existing server, so
  a leftover `npm run dev` makes the loading-overlay test in `app.spec.ts`
  see an already-warm page. Kill the port before the suite.
- **A source file saved mid-run.** Vite pushes a full reload and the test
  dies with "Execution context was destroyed". Rerun.
