# Engineering review

A read-only, fresh-eyes review of the whole repository against the design
spec, written before any of it was acted on. The findings are kept verbatim;
the resolution of each is recorded at the bottom.

Scope: spec `docs/design.md` (§0, §3, §4), all of `src/`, `tests/`, `e2e/`, `scripts/perf.mjs`, configs, README, `docs/perf.md`. Every finding below was verified by reading the referenced lines. `npx vitest run` at review time: 11 files / 105 tests pass. `tsc --noEmit` reported 2 errors in `src/app/main.ts` (147, 360: arity mismatches with `hud.frame` / `ocean.update`) — that file was mid-edit and uncommitted at the time, so it is treated as work in progress, not a finding.

Line numbers are against the working tree at review time and have drifted since.

---

## Findings (most severe first)

### 1. MAJOR — `animationSpeed` is applied twice (effective speed = animationSpeed²)
- `src/app/main.ts:246` — `simTime += dt * params.waves.animationSpeed;`
- `src/gpu/evolvePass.ts:33` — `u.uT!.value = t * waves.animationSpeed;`
- `src/core/oceanCpu.ts:107` also multiplies inside `evolve`, so the CPU oracle matches the GPU pass (the e2e parity test can't catch this); only the app double-applies.
- Why it matters: the panel's "animation speed" slider is quadratic, and at 0 it freezes time twice over. Any future feature that keys off `simTime` (foam decay, wake, spray already use raw `dt`, so wave motion and foam/spray drift relative to each other by a factor of animationSpeed).
- Fix: pick one owner. Simplest: `main.ts` keeps `simTime` in wall-clock seconds and the sim scales, i.e. `simTime += dt;` and leave `evolvePass`/`oceanCpu` as-is. Or (cleaner for the CPU oracle) delete the multiply in both `evolvePass.ts:33` and `oceanCpu.ts:107` and let the app own time. Add a unit test in `tests/oceanCpu.test.ts` that `evolve(h0, t, {animationSpeed: 2})` equals `evolve(h0, 2t, {animationSpeed: 1})` so the owner is pinned.

### 2. MAJOR — Terrain normals are in view space but lit in world space (island lighting rotates with the camera)
- `src/render/shaders/terrain.vert.glsl:22` — `vNormal = normalize(normalMatrix * normal);`
- `src/render/shaders/terrain.frag.glsl:73-88` — `n` is dotted with `uSunDir` (world) and used to look up `uSky` (world cubemap), and `n.y` drives the slope/rock mask (`:45`).
- In three.js `normalMatrix` is the inverse-transpose of `modelViewMatrix` (view space). So the sun term, sky ambient and even the rock-vs-sand slope mask all change as you orbit. It is subtle at the default view (camera roughly level) which is why the `island.png` e2e assertion passes.
- Fix (terrain has no non-uniform scale): `vNormal = normalize(mat3(modelMatrix) * normal);`. If you want to be strict, pass a `uNormalWorld` `mat3` = `normalMatrix` of `modelMatrix`. Add an e2e check: orbit 90° and assert the peak pixel's R/B ratio stays within a band.

### 3. MAJOR — No float-render-target capability check and no context-loss handling
- `grep` for `EXT_color_buffer_float`, `webglcontextlost`, `isContextLost`: no hits in `src/`, `index.html`, `e2e/`, `scripts/`. The only capability check is `e2e/pages/gpu.ts:285` (`instanceof WebGL2RenderingContext`).
- Every pass renders into `FloatType`/`HalfFloatType` targets (`src/gpu/targets.ts`, `scenePass.ts`, `sky.ts`). On a WebGL2 context that lacks `EXT_color_buffer_float` (some Android/older Intel, software GL) `gl.checkFramebufferStatus` fails silently in three.js → black ocean with no message. `floatLinearSupported()` is checked but not colour-buffer-float.
- Spec §0/§3 call out "unsupported tier" error paths; none exist.
- Fix: in the composition root right after `new WebGLRenderer`, `const gl = renderer.getContext(); if (!renderer.capabilities.isWebGL2 || !gl.getExtension("EXT_color_buffer_float")) { loading.fail("This demo needs WebGL2 with float render targets"); return; }`. Register `canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); hud.status("GPU context lost — reload") })` and, ideally, `webglcontextrestored` → `setQuality(params.quality)` (the rebuild path already disposes/recreates everything).

### 4. MAJOR (docs drift + visible) — Cascade band hand-off leaves spectral gaps; spec says "Nyquist"
- `src/core/cascades.ts` — `boundary(size) = 2π·HANDOFF_HARMONIC/size` with `HANDOFF_HARMONIC = 16`. Spec §1.4 says each cascade's band is bounded by "the Nyquist of the neighbouring cascade".
- With sizes [1024, 96, 9]: cascade 0 keeps λ > 64 m; cascade 1's longest representable wave is its fundamental, λ = 96 m, but its band starts at λ ≤ 64 m and its discrete bins are 96/k → 96, 48, 32… so the first *usable* bin inside its band is 48 m. Nothing produces 48–64 m. Likewise 4.5–6 m between cascades 1 and 2; on max tier (`[1024, 48, 2.25]`) the gaps are 48–64 m and 2.25–3 m.
- Why it matters: the default `peakWavelength = 70` m sits right against the 64 m edge; presets at 47 and 60 m (fairWeather, corsair, storm) have their peak *in or beside* the hole, so the spectrum's peak energy is under-represented and Hs is lower than `alphaFor` calibrates for.
- Fix options: (a) choose band edges on the coarse cascade's bin spacing instead of a fixed harmonic — cut at `2π·k/size_coarse` where `k` is the largest integer with `size_coarse/k ≥ size_fine/1` (i.e. hand off at the fine tile's fundamental, 96 m); (b) or make the fine tiles integer divisors of the coarse ones (1024/96 is not an integer; 1024, 128, 16 would make the bins nest). Either way, update spec §1.4 to describe the real rule and add a unit test in `tests/cascades.test.ts` that walks the discrete bins of all cascades and asserts no λ range between λ_min and λ_max is unrepresented.

### 5. MINOR (dead code + spec drift) — Foam `uCameraOffset` is never driven
- `src/gpu/foamPass.ts:46,87`, `src/gpu/foam.frag.glsl:19,28`, `src/gpu/cascade.ts:118-129` accept a camera offset; `src/gpu/oceanSim.ts:60` always passes `undefined` → `[0,0]`.
- Spec §1.5 says the foam field is "anchored to the camera in tile-sized steps". In practice the field is tile-periodic, which is actually correct (it must match the periodic displacement it is derived from) — so the spec sentence is wrong, and the shader's shift branch is dead.
- Fix: delete `uCameraOffset` from the pass/shader/`cascade.ts` and remove the sentence from §1.5. (Or, if a non-periodic foam was intended, this is a real missing feature — decide, don't leave both.)

### 6. MINOR — Vertex and fragment cascade fade curves disagree
- `src/render/shaders/water.vert.glsl:61-64` — `1 − smoothstep(8·size, 24·size, dist)`
- `src/render/shaders/water.frag.glsl:154-156` — `1 − smoothstep(5·size, 16·size, dist)`
- Same function name, different constants: the geometry of a fine cascade is still displaced where its normals/foam have already faded. Not visibly wrong (the fragment fade is tighter) but it is exactly the kind of duplicated constant this review was looking for.
- Fix: move `fadeWeight` into `common.glsl` (already spliced by `withCommon`) with one pair of constants, and comment why the number is what it is.

### 7. MINOR — Clipmap seam weighting uses the fine ring's cell for coincident vertices
- `src/render/shaders/water.vert.glsl:69-76` — cascade cell weight is `1 − smoothstep(size/8, size/2, cell)` with `cell` = this ring's cell. `src/render/clipmap.ts` averages seam vertices on ring r using neighbours at `cell`, but the coincident vertex on ring r+1 evaluates the weight with `2·cell`. For the fine cascade (size 9 m: weight starts dropping at cell > 1.1 m) the two rings compute *different* weights at the same world position → potential T-junction cracks where the 9 m cascade is active and the ring cell is in the 1–4.5 m range. Also `snapCamera` snaps to `baseCell*2` only; coarser rings are not snapped to their own cell, so rings ≥ 2 swim by sub-cell amounts (minor shimmer).
- Fix: compute the cell weight from the *coarser* of the two rings at seam vertices (pass the seam flag as an attribute, or evaluate with `max(cell, seamCell)`), and snap each ring's origin to `cell_r`.

### 8. MINOR — Layering: `withCommon` lives in `waterMaterial.ts` and is imported by sky/terrain/underwater/sunShafts
- `src/render/sky.ts`, `terrain.ts`, `underwater.ts`, `sunShafts.ts` all `import { withCommon } from "./waterMaterial"`. `src/app/spray/spraySystem.ts:18` bypasses it and does its own `frag.replace("//#include common", common)`.
- Not a cross-layer violation (all in `render`, and `app` may import `render`), but it makes the water material the de facto shader-utils module and there are now two include mechanisms.
- Fix: move `withCommon` to `src/render/shaders/include.ts` (or `src/gpu/passes/glsl.ts` since gpu passes could use it too) and use it in `spraySystem.ts`.

### 9. MINOR — Sky constants duplicated in TS and GLSL
- `src/render/sky.ts` `sunColor()` / `ambient()` re-implement `sunTint()` and the sky gradient from `common.glsl` in TypeScript so the CPU can hand sun/ambient colours to spray and terrain. Nothing ties them together; a tweak in one drifts the other (spray colour vs water sun highlight).
- Fix: either read the cubemap back once per sky rebuild (a 1×1 mip of the 128² cube is cheap) or generate both from one source (a tiny GLSL→TS constant table checked by a unit test that samples both at a few elevations).

### 10. MINOR — `sunShafts.ts` relies on three.js private flag `isXRRenderTarget` and `internalFormat = "RGBA8"`
- `src/render/sunShafts.ts` sets `target.isXRRenderTarget = true` to get an MSAA-resolved frame target with a non-float format. That's an undocumented three.js path (r186) and will break silently on upgrade.
- Fix: use `new WebGLRenderTarget(w, h, { samples: 4, type: UnsignedByteType })` — public since r138 — and drop the flag; or document why the public path was insufficient.

### 11. MINOR — Test coverage gaps vs spec §4 and flaky patterns in e2e
- Missing vs §4: no "FFT pass alone vs CPU FFT" at the *unpack* stage for the mipmapped path (`OES_texture_float_linear` on/off); no perf gate test ("High ≥ 30 fps" — only `scripts/perf.mjs`, which is manual and documented in `docs/perf.md` but not asserted anywhere); no test that a quality change frees GPU memory (`renderer.info.memory.textures` before/after a low→max→low round trip would catch leaks in one line); no test for the double-`animationSpeed` (finding 1) — add `oceanCpu` invariance test.
- Flaky patterns: `e2e/app.spec.ts:118,148,152,173,183,187,204` and `e2e/spray.spec.ts:278,301,303` use `keyboard.down` + `waitForTimeout(500…5000)` — the distance travelled depends on the headless frame rate (the RAF loop runs independently of `__app.frame()`), so the `> 0.5 m`, `> 3 m/s`, `heading > 0.15` thresholds are machine-dependent. Total fixed sleeps ≈ 20 s across the app spec.
- Fix: expose `__app.step(dt, nFrames, keys)` that drives the tick deterministically with a fixed `dt` (the tick already takes `dt` as a parameter) and pause the RAF loop while a test drives it; replace `waitForTimeout` with `frame()` loops. For the wake/ssr tests, switch pixel-probe assertions (`pixel(0.4,0.2)`) to `__app.snapshot` + region mean so they are robust to a 1-px shift.
- Weak assertions: `render.spec.ts:139` — `expect(page.evaluate(...)).resolves...` is not awaited (the promise assertion is fire-and-forget; a failure would be an unhandled rejection after the test). Add `await`. `app.spec.ts:44-46` hardcodes `windSpeed 15.0 / peakWavelength 47` from `INITIAL_PRESET = "fairWeather"` rather than reading `PRESETS`.

### 12. MINOR — `Buoyancy` camera-underwater probe reads outside the hull-centred block
- `src/app/main.ts` (boat mode): `buoyancy.update(hull.x, hull.z, footprintRadius)` is called for the hull, then `heightAt(cam.x, cam.z)` is used for the underwater test. `Buoyancy.read()` clamps to the block (`buoyancy.ts:186-190`), so a chase camera > footprintRadius from the hull silently gets the block-edge texel's height, not the camera's. In boat mode the camera sits ~30–60 m astern; the footprint block is ~24 m + 4 texels.
- Fix: a second `Buoyancy` instance (or a `heightAtPoint(x,z)` that reads its own 4×4 block) for the camera; or make `heightAt` return `NaN` outside its block and have the caller fall back.

### 13. NIT — `readTarget` is `async` but never awaits
- `src/gpu/readback.ts:9` — `export async function readTarget(...)` wraps a synchronous `readRenderTargetPixels`. Callers `await` a value that was already computed; it suggests an async path (PBO / `readRenderTargetPixelsAsync`) that isn't there.
- Fix: drop `async`, or actually use `renderer.readRenderTargetPixelsAsync` for the HUD spray `count()` (which reads the whole 180² pool synchronously every HUD tick — `spraySystem.ts:196`).

### 14. NIT — Deprecated aliases and stale names
- `src/render/scenePass.ts:28-29,74` — `DEPTH_LAYER` and `ScenePass.texture` `@deprecated` with no remaining callers (grep). Delete.
- `src/render/terrain.ts:5` doc comment says `DepthPass`; the class is `ScenePass`.
- `src/gpu/sprayPass.ts` — `makeFloatTarget(width, 2)` then `setSize(width, height)`; just pass the size.
- `src/render/ocean.ts` `stats()` returns hardcoded `draws: 2`, `tris + 12`; `e2e/render.spec.ts:139` asserts on it, so the assertion tests a constant.
- `src/app/main.ts:221` — `let simTime` is declared after the `setQuality` closure that reads it (`:168`). TDZ-safe because the closure runs later, but move the declaration up with the other frame state.

### 15. NIT — `src/core/terrain.ts` hills term can go negative inland
- `26*(n − 0.35)` with `n ∈ [0,1]` gives up to −9 m in the island interior; masked by the beach/shore terms near the coast but produces sub-sea pockets inland that the water plane then fills (no visible bug at the default view; visible if the camera flies over the island).
- Fix: `Math.max(0, …)` or add a floor equal to the shore height.

---

## What's good

- Layering is genuinely respected: `src/core` has zero three.js imports (verified by grep), `gpu` depends only on `core` + three, `render` on `gpu`/`core`, `app` on all. No circular imports found.
- Sign conventions are consistent and correct end-to-end: `Dx = −i·nx·h`, slope `= i·k·h`, `dxdx = kx·nx·h` in `oceanCpu.ts` match the GLSL line-for-line; the `(−1)^{x+y}` unpack; the wake shift (`wake.frag.glsl:45` `q = p + uShift`, `wake.ts:126` origin moves by +shift cells) is right; hull heading 0 = −z / starboard +x is used consistently by `hullPhysics`, `wake.ts` forward vector, and `spraySystem` bow points; the depth linearisation `P[3][2]/(ndc+P[2][2])` is correct for three.js' projection.
- Resource hygiene is better than most three.js code: `Ocean.buildSurface`, `Wake.dispose`, `SpraySystem.dispose`, `ScenePass` target recreation on drawing-buffer change, and every pass saves/restores render target, clear colour, autoClear, and camera layer mask.
- Wake stability: iWave kernel zero-mean + Laplacian pinch, substep 1/40, dt clamp 0.1, ClampToEdge — no NaN risk found; `hullPhysics` mass is derived from the columns so rest draft is exact by construction, and the stability argument in the header comment is right (BM ≈ 5 m vs d ≈ 2 m).
- The CPU oracle strategy (`oceanCpu` + e2e GPU parity at `relRms < 0.02`, foam decay `e^−1` test, FFT vs `core.fft2d` at 1e-3) is exactly what §4 asked for and it is what makes finding 1 safe to fix.
- `presets.ts` `applyPatch` / `setPath` / `getPath` are small, pure, and unit-testable; `params.ts` `cloneParams` is explicit rather than `structuredClone`, which keeps the shape auditable.
- Shaders are commented with the *why* (Monahan whitecap coverage, sheer curve, forward scatter), which makes drift like finding 9 findable.

## Verdict

Solid, spec-faithful implementation with a clean layer split and a real oracle test strategy. Two user-visible correctness bugs (animationSpeed squared; terrain normal in view space) and one operational gap (no float-target / context-loss handling) should be fixed before this is shown to anyone on unfamiliar hardware; the cascade band gap is a design-level fidelity issue that the spec text currently hides. The rest is tidy-up. Nothing here needs a rearchitecture; `main.ts` (~510 lines) is at the edge of comfortable — if it grows further, split the `window.__app` test API (~140 lines) into `src/app/testApi.ts` and the mode/rig state machine into `src/app/modes.ts`.

## Resolution

Each finding was verified against the code before acting; one commit per
finding, failing test first where a test could state the defect. The suite
(`npm run typecheck`, `npx vitest run`, `npx playwright test`) was green
after every commit.

| # | Status | Notes |
|---|---|---|
| 1 | fixed | `animationSpeed` applied once, in the sim; the app clock is wall-clock seconds. Test pins the effective rate. |
| 2 | fixed | Terrain lit with world-space normals (three's `normalMatrix` is view-space). |
| 3 | fixed | Float-target capability gate at boot with a visible message; `webglcontextlost` / `restored` handled (sim rebuilt, RAF resumes). |
| 4 | fixed | Hand-off at the finer tile's fundamental (`2π/tileSize`) with a one-bin linear cross-fade (`bandWeight`, mirrored in GLSL). `tests/cascades.test.ts` checks contiguity and no double counting; spec §1.4 rewritten. |
| 5 | fixed | `uCameraOffset` removed from the foam pass and the spec. |
| 6 | fixed | One cascade fade curve shared by the vertex and fragment stages. |
| 7 | fixed (first half) / declined (second half) | Ring-edge vertices now carry the coarser level's `ring` so coincident vertices drop the same cascades (`tests/clipmap.test.ts`). Per-ring origin snapping is **declined**: each ring snapping to its own cell shifts ring extents against each other by up to a cell and needs L-shaped trim strips — a clipmap rewrite for no visible defect today. Spec §1.8 says so. |
| 8 | fixed | `withCommon` moved to `render/shaders/include.ts`; spray uses it too. |
| 9 | fixed | One sky constant table (`render/skyConstants.ts`) emits the GLSL `#define`s; `tests/skyConstants.test.ts` checks `common.glsl` uses them and carries no literal copies. |
| 10 | replaced by documentation + sentinel | Kept `isXRRenderTarget` / `internalFormat = "RGBA8"`: three r186 keys "tone-map into this target" on that flag alone and there is no public option; the alternative (every built-in material applying ACES+sRGB itself, renderer set to NoToneMapping, exposure plumbed as a uniform) is a wider change for no gain. The reasoning is in the `sunShafts.ts` header and `tests/threeCompat.test.ts` fails loudly if an upgrade drops the hook. |
| 11 | fixed | Deterministic driver: `__app.step(dt, frames)` / `advance(seconds)` pause the RAF loop and tick synchronously; every `waitForTimeout` hold/settle in e2e replaced (one 250 ms HUD-flush sleep remains). Found and fixed on the way: after a driven run the first RAF tick could get a **negative dt** (RAF's `now` precedes the `performance.now()` taken at hand-back), which flipped the spray spawn probability's sign and flooded the pool — the "frame-rate dependent spray" seen while writing the test was this, not the spray model. `rafTick` clamps dt ≥ 0. Storm spray is now asserted as a whole-frame diff against measured frozen-sea drift (0.18 vs 0.018). |
| 12 | fixed | Camera owns a second `Buoyancy` (`slotBase` keeps readback slots disjoint); `covers(x, z)` guards the block-edge clamp; hull sampler used only when its block covers the camera. `tests/buoyancy.test.ts`. |
| 13 | fixed | `readTarget` is synchronous; e2e page helpers de-asynced. |
| 14 | fixed | `DEPTH_LAYER` alias and deprecated `texture` getter removed; terrain header corrected; `makeFloatTarget` takes a height (spray target no longer N×N); `ocean.stats()` reports real draw/tri counts. |
| 15 | fixed | Land floor `h = max(h, min(inland/8, 1))`; ray-walk test over five seeds: once inland, never below sea level. A scan of seeds 0–39 found no pool with current constants — the floor is a structural guard. |

Landed alongside the resolutions: GPU timer queries are off by default
(`?gpuTimer=1` or `__app.setGpuTimer(true)`), and the docs and screenshots
were refreshed to match.
