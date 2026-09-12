/**
 * Demo bootstrap: renderer, scene, Ocean, cameras, GUI, HUD, loading
 * sequence, RAF loop. Exposes `window.__app` for the e2e tests.
 */
import * as THREE from "three";
import { cloneParams, DEFAULT_PARAMS, type OceanParams, type QualityTier } from "../core/params";
import { GpuTimer } from "../gpu/gpuTimer";
import { hasHeightReadback } from "../render/cascadeTextures";
import { Ocean } from "../render/ocean";
import { Terrain } from "../render/terrain";
import { SunShafts } from "../render/sunShafts";
import { Underwater } from "../render/underwater";
import { loadShipGltf, makeGltfLoader, requestedShipModel, SHIP_GLTF_URL } from "./assets/shipLoader";
import { Vegetation } from "../render/vegetation";
import { sharedShipMaterials } from "./assets/shipMaterials";
import { Buoyancy } from "./buoyancy";
import { RainSystem, type RainFrame } from "./rain/rainSystem";
import { SpraySystem, type SprayBowSource, type SprayFrame } from "./spray/spraySystem";
import { Wake } from "./wake";
import { CameraRig, MODE_INDEX, type CameraMode } from "./cameras";
import { Gui } from "./gui";
import { Hud, type HudStats } from "./hud";
import { LoadingOverlay, nextFrame } from "./loading";
import { INITIAL_PRESET, getPath, presetParams, setPath } from "./presets";
import "./styles.css";

interface AppApi {
  ready: Promise<void>;
  params: () => OceanParams;
  setParam: (path: string, v: unknown) => Promise<void>;
  setPreset: (name: string) => Promise<void>;
  setQuality: (tier: QualityTier) => Promise<void>;
  setMode: (m: CameraMode) => Promise<void>;
  frame: () => Promise<void>;
  /**
   * Deterministic driver for tests: pause the RAF loop and run `frames`
   * ticks of exactly `dt` seconds each (default one), then resume RAF.
   * Key state set before the call (keyboard.down) is read by every tick.
   */
  step: (dt: number, frames?: number) => Promise<void>;
  /** `step(dt, round(seconds / dt))` — advance the sim by `seconds` of fixed-dt ticks. */
  advance: (seconds: number, dt?: number) => Promise<void>;
  /** Sim clock in seconds (the sum of the dts ticked so far). */
  simTime: () => number;
  stats: () => HudStats;
  /** Switch the GPU section timer (off by default; `?gpuTimer=1` in the URL turns it on at boot). */
  setGpuTimer: (on: boolean) => Promise<void>;
  /** True between `webglcontextlost` and the rebuild that follows `webglcontextrestored`. */
  contextLost: () => boolean;
  camera: () => { position: [number, number, number]; mode: CameraMode };
  /** Teleport the camera (switches to fly mode so nothing pulls it back). */
  setCameraPosition: (p: [number, number, number]) => Promise<void>;
  /** True while the camera is below the water surface. */
  underwater: () => boolean;
  /** Point the (fly) camera along a world direction. */
  setCameraDirection: (d: [number, number, number]) => Promise<void>;
  /** Sun-shaft state: refracted sun on screen (uv, v down) and the pass strength (0 = off). */
  sunShafts: () => { sunUv: [number, number]; strength: number; sunDir: [number, number, number] };
  /** Spray particle counts (live readback): all, breaking-crest, bow. */
  spray: () => { alive: number; crest: number; bow: number; capacity: number };
  /** Rain (spec §1.16): streaks drawn, ripples stamped, intensity in force. */
  rain: () => { streaks: number; ripples: number; intensity: number };
  hull: () => { position: [number, number, number]; waterHeight: number };
  /** Ship state: speed m/s along the heading; pitch/roll/heading radians. */
  ship: () => { speed: number; pitch: number; roll: number; heading: number; model: "gltf" | "procedural" };
  /** Resolves once the ship and palm assets have loaded or fallen back (spec §1.15). */
  assetsReady: Promise<void>;
  /** Island dressing: palm instances, rocks, and which palm model is showing. */
  vegetation: () => { palms: number; rocks: number; model: "gltf" | "procedural" };
  /** Wake field (max |height| m, max foam) over a 4×4 block at world offset (dx, dz) from the hull. */
  wakeSample: (dx: number, dz: number) => { height: number; foam: number };
  /** Store the current frame's pixels under a name (read on the next frame). */
  snapshot: (name: string) => Promise<void>;
  /** Mean absolute RGB difference (0–255) between two snapshots. */
  diff: (a: string, b: string) => number;
  /** RGBA (0–255) of the last rendered frame at normalised (u, v), v down. */
  pixel: (u: number, v: number) => Promise<[number, number, number, number]>;
  /**
   * Luminance (0–255) down the screen column at normalised `u`, top row
   * first — one `readPixels` of a 1-pixel-wide strip. The cheap way to
   * measure vertical high-frequency energy (rain streaks) from a test.
   */
  column: (u: number) => Promise<number[]>;
  preset: () => string;
}

declare global {
  interface Window {
    __app: AppApi;
  }
}

/** Thrown when the GPU cannot run the demo; the loading overlay shows the message. */
class UnsupportedError extends Error {}

/**
 * Every pass renders into float targets, which WebGL2 only guarantees with
 * `EXT_color_buffer_float` (absent on some Android / older Intel / software
 * GL). Without it three's framebuffers come up incomplete and the ocean is
 * silently black. (`OES_texture_float_linear` is optional: `gpu/targets`
 * falls back to nearest filtering.)
 */
function requireCapabilities(renderer: THREE.WebGLRenderer): void {
  if (!renderer.capabilities.isWebGL2) throw new UnsupportedError("This demo needs WebGL2.");
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    throw new UnsupportedError("This demo needs WebGL2 with float render targets (EXT_color_buffer_float), which this GPU or browser does not provide.");
  }
}

async function boot(loading: LoadingOverlay): Promise<void> {
  const root = document.getElementById("app") as HTMLElement;
  const ui = document.getElementById("ui") as HTMLElement;

  // 1. Water: renderer + simulation.
  await loading.next();
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch (err) {
    throw new UnsupportedError(`This demo needs WebGL2, which this browser could not create (${String(err)}).`);
  }
  requireCapabilities(renderer);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.id = "canvas";
  root.insertBefore(renderer.domElement, loading.el);

  let params = presetParams(INITIAL_PRESET, DEFAULT_PARAMS);
  let presetName = INITIAL_PRESET;
  const scene = new THREE.Scene();
  // GPU section timings (EXT_disjoint_timer_query_webgl2; no-op when absent).
  const gpuTimer = new GpuTimer(renderer);
  // Off by default: the queries cost 2–7 % of frame rate (docs/perf.md).
  // `?gpuTimer=1` or `__app.setGpuTimer(true)` turns them on.
  gpuTimer.enabled = new URLSearchParams(location.search).get("gpuTimer") === "1";
  const ocean = new Ocean(renderer, params, { timer: gpuTimer });
  scene.add(ocean);
  if (!hasHeightReadback(ocean.sim)) throw new Error("simulation has no height readback (buoyancy)");
  const sim = ocean.sim;
  await nextFrame();

  // 2. Environment: hull, lights, cameras.
  await loading.next();
  const buoyancy = new Buoyancy(sim);
  // The camera's own surface sampler: in boat / probe modes `buoyancy`
  // reads the block around the hull, and a camera outside it would get the
  // block's clamped edge (a false "underwater"). Separate readback slots.
  const cameraBuoyancy = new Buoyancy(sim, { slotBase: 1000 });
  const rig = new CameraRig(renderer.domElement, window.innerWidth / window.innerHeight, buoyancy);
  scene.add(rig.hull, rig.hull.probes);
  const wake = new Wake(renderer);
  scene.add(wake.debug);
  // Spray (spec §1.14): crest + bow particles, drawn after the water.
  const spray = new SpraySystem(renderer);
  scene.add(spray.points);
  // Rain (spec §1.16): the streak curtain, drawn last; its ripple field is
  // bound to the water each tick.
  const rain = new RainSystem(renderer);
  scene.add(rain.mesh);
  rig.onModeChange((m) => {
    if (m !== "boat") {
      wake.reset();
      ocean.material.setWake(null);
    }
    spray.reset();
    rain.reset();
  });
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x24405a, 0.8);
  scene.add(sun, hemi);
  // Sun shadow map (spec §1.15): masts and sails shadow the deck. 1024²,
  // a ±70 m box around the chase camera, refreshed by hand once per tick in
  // boat mode (the ship is the only caster; nothing else receives).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -70;
  sun.shadow.camera.right = sun.shadow.camera.top = 70;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  // Every lit material samples the map whether or not it receives shadows,
  // so it must exist from the first render; after that only boat mode
  // (the only mode with a receiver in the box) refreshes it.
  renderer.shadowMap.needsUpdate = true;
  const underwater = new Underwater();
  scene.add(underwater.mesh);
  const sunShafts = new SunShafts(renderer);
  // Island (spec §1.11): in front of the default camera; its depth feeds the water.
  const terrain = new Terrain(params.waves.seed);
  terrain.setParams(params);
  terrain.attachTo(ocean);
  scene.add(terrain);
  // Island dressing (spec §1.15): palms + rocks placed on the same heightfield.
  // `?palms=procedural` keeps the procedural palms (as `?ship=procedural` does for the ship).
  const vegetation = new Vegetation(params.waves.seed, {
    islandPosition: terrain.position,
    ...(new URLSearchParams(location.search).get("palms") === "procedural" ? {} : { loader: makeGltfLoader() }),
  });
  scene.add(vegetation);
  let isUnderwater = false;
  // "Buoyancy Probes": in boat mode the ship's sample points + force arrows;
  // otherwise a 5×5 grid of water-height markers around the camera.
  let probesOn = false;
  const probes = new THREE.Group();
  probes.visible = false;
  const probeGeo = new THREE.SphereGeometry(0.25, 8, 6);
  const probeMat = new THREE.MeshBasicMaterial({ color: 0xff5533 });
  for (let i = 0; i < 25; i++) probes.add(new THREE.Mesh(probeGeo, probeMat));
  scene.add(probes);
  await nextFrame();

  // 3. Sky.
  await loading.next();
  ocean.sky.update(params.sky.timeOfDay, params.sky.cloudCoverage, params.fog);
  await nextFrame();

  // 4. Shaders.
  await loading.next();
  ocean.update(rig.camera, 0, 0);
  renderer.compile(scene, rig.camera);
  renderer.render(scene, rig.camera);
  await nextFrame();

  // UI.
  const card = buildModeCard(ui, rig);
  const hud = new Hud(ui, card.fps, "GPU WebGL2", gpuTimer.supported);
  const gui = new Gui(ui, params, presetName, dpr);

  /** Sim clock (seconds); advanced by the tick, read by the rebuild too. */
  let simTime = 0;
  let rebuilding = false;
  const applyParams = (next: OceanParams): void => {
    params = next;
    ocean.setParams(params);
    terrain.setParams(params);
    gui.sync(params);
  };

  /**
   * Rebuild the GPU side for `tier` behind the "rebuilding" pill. With
   * `force` the ocean is rebuilt even when the tier is unchanged (context
   * restore: the render-target contents are gone).
   */
  const rebuild = async (tier: QualityTier, force = false): Promise<void> => {
    if (rebuilding) return;
    rebuilding = true;
    gui.setRebuilding(true);
    await nextFrame();
    await nextFrame();
    const next = cloneParams(params);
    next.quality = tier;
    if (force) {
      ocean.contextRestored();
      wake.reset();
      ocean.material.setWake(null);
      gpuTimer.reset();
    }
    applyParams(next);
    spray.reset();
    rain.reset();
    ocean.update(rig.camera, simTime, 0);
    renderer.compile(scene, rig.camera);
    await frame();
    gui.setRebuilding(false);
    rebuilding = false;
  };
  const setQuality = (tier: QualityTier): Promise<void> => rebuild(tier);

  // WebGL context loss (spec §3): three stops rendering by itself; we pause
  // the simulation and readbacks, say so in the HUD, and on restore rebuild
  // through the quality path.
  let contextLost = false;
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    contextLost = true;
    hud.setGpuLabel("GPU context lost");
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    void rebuild(params.quality, true).then(() => {
      contextLost = false;
      hud.setGpuLabel("GPU WebGL2");
    });
  });

  const setPreset = (name: string): Promise<void> => {
    presetName = name;
    gui.setPreset(name);
    applyParams(presetParams(name, params));
    return frame();
  };

  gui.onChange((e) => {
    switch (e.kind) {
      case "quality":
        void setQuality(e.tier);
        break;
      case "preset":
        void setPreset(e.name);
        break;
      case "param":
        applyParams(setPath(params, e.path, e.value));
        break;
      case "pixelRatio":
        dpr = e.value;
        renderer.setPixelRatio(dpr);
        renderer.setSize(window.innerWidth, window.innerHeight);
        break;
      case "toggle":
        if (e.id === "buoyancyProbes") probesOn = e.value;
        else if (e.id === "wakeProbes") wake.debug.visible = e.value;
        break;
      case "sunShafts":
        applyParams(setPath(params, "underwater.sunShafts", e.value));
        break;
    }
  });

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) return;
    if (e.key === "h" || e.key === "H") ui.classList.toggle("is-hidden");
  });

  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    rig.camera.aspect = window.innerWidth / window.innerHeight;
    rig.camera.updateProjectionMatrix();
  });

  // RAF loop.
  let lastNow = performance.now();
  let frameWaiters: (() => void)[] = [];
  let pendingSnapshot: string | null = null;
  let pendingPixel: { u: number; v: number; resolve: (p: [number, number, number, number]) => void } | null = null;
  let pendingColumn: { u: number; resolve: (c: number[]) => void } | null = null;
  const snapshots = new Map<string, Uint8Array>();
  const tmpDir = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const tmpAmbient = { sky: new THREE.Color(), ground: new THREE.Color() };
  // Per-frame inputs are mutated in place — the tick allocates nothing.
  const sprayBow: SprayBowSource = { samples: [], heading: 0, speed: 0 };
  const sprayFrame: SprayFrame = {
    dt: 0,
    params,
    cascades: sim.cascades,
    camera: rig.camera,
    sky: ocean.sky,
    bow: null,
    hidden: false,
    bufferHeight: 0,
  };
  const rainFrame: RainFrame = {
    dt: 0,
    t: 0,
    params,
    camera: rig.camera,
    sky: ocean.sky,
    hidden: false,
    bufferHeight: 0,
  };

  /** One sim + render step of `dt` seconds (RAF-timed live, fixed when driven). */
  const tick = (dt: number): void => {
    if (contextLost && !rebuilding) {
      // Nothing to draw into; keep the clock and the frame waiters moving.
      const waiters = frameWaiters;
      frameWaiters = [];
      for (const w of waiters) w();
      return;
    }
    // Wall-clock seconds: the sim applies `waves.animationSpeed` itself
    // (evolvePass / oceanCpu), so it must not be applied here as well.
    simTime += dt;
    const t0 = performance.now();
    gpuTimer.poll();

    const boat = rig.mode === "boat";
    probes.visible = probesOn && !boat;
    rig.hull.probes.visible = probesOn && boat;
    const probeCentre = boat ? rig.hull.position : rig.camera.position;
    // Read back last frame's displacement around the hull before it settles
    // (a block wide enough for every hull sample point in boat mode).
    if (boat || probes.visible) {
      buoyancy.update(probeCentre.x, probeCentre.z, boat ? rig.hull.physics.footprintRadius : 0);
    }
    rig.update(dt);
    ocean.update(rig.camera, simTime, dt);
    if (rig.mode === "boat") {
      const h = rig.hull;
      gpuTimer.begin("wake");
      wake.update(
        dt,
        { x: h.position.x, z: h.position.z, heading: h.heading, speed: h.speed, length: h.length, beam: h.beam },
        h.position.y,
      );
      gpuTimer.end();
      const [wx, wz] = wake.origin;
      ocean.material.setWake(wake.texture, wx, wz, wake.size);
    }
    if (probes.visible) {
      let i = 0;
      for (let gz = -2; gz <= 2; gz++) {
        for (let gx = -2; gx <= 2; gx++) {
          const x = probeCentre.x + gx * 3;
          const z = probeCentre.z + gz * 3;
          const m = probes.children[i++] as THREE.Object3D;
          m.position.set(x, buoyancy.heightAt(x, z), z);
        }
      }
    }
    // Underwater (spec §1.10): below the local surface height the skybox is
    // swapped for the water volume and the surface shades its underside.
    const cam = rig.camera.position;
    let depthBelow = 0;
    if (cam.y < 12) {
      cameraBuoyancy.update(cam.x, cam.z);
      // Prefer the hull's (wider) block when the camera is inside it: it is
      // the surface the hull is answering to this frame.
      const hullBlock = (boat || probes.visible) && buoyancy.covers(cam.x, cam.z);
      const sampler = hullBlock ? buoyancy : cameraBuoyancy;
      depthBelow = sampler.heightAt(cam.x, cam.z) - cam.y;
      isUnderwater = depthBelow > 0;
    } else {
      isUnderwater = false;
    }
    ocean.material.setUnderwater(isUnderwater);
    gpuTimer.begin("spray");
    sprayFrame.dt = dt;
    sprayFrame.params = params;
    sprayFrame.cascades = sim.cascades;
    sprayFrame.hidden = isUnderwater;
    sprayFrame.bufferHeight = renderer.getContext().drawingBufferHeight;
    if (boat) {
      sprayBow.samples = rig.hull.samples;
      sprayBow.heading = rig.hull.heading;
      sprayBow.speed = rig.hull.speed;
      sprayFrame.bow = sprayBow;
    } else {
      sprayFrame.bow = null;
    }
    spray.update(sprayFrame);
    gpuTimer.end();
    // Rain (spec §1.16): the curtain follows the camera, the ripple field
    // follows it in texel-snapped steps and feeds the water shader.
    gpuTimer.begin("rain");
    rainFrame.dt = dt;
    rainFrame.t = simTime;
    rainFrame.params = params;
    rainFrame.hidden = isUnderwater;
    rainFrame.bufferHeight = sprayFrame.bufferHeight;
    rain.update(rainFrame);
    const [rx, rz] = rain.fieldOrigin;
    ocean.material.setRain(rain.intensity > 0 ? rain.ripple.texture : null, rx, rz, rain.fieldSize, rain.intensity);
    gpuTimer.end();
    ocean.sky.skybox.visible = !isUnderwater;
    underwater.visible = isUnderwater;
    if (isUnderwater) underwater.update(rig.camera, params, ocean.sky, simTime);
    // Sun shafts (spec §1.13): only underwater, only when there is sun to shaft.
    rig.camera.updateMatrixWorld();
    if (isUnderwater) sunShafts.update(rig.camera, ocean.sky, params, depthBelow, underwater.caustics, simTime);
    else sunShafts.strength = 0;
    terrain.update(ocean.sky, simTime, isUnderwater);
    vegetation.update(simTime, params.waves.windDirection, params.waves.windSpeed);
    sun.position.copy(ocean.sky.sunDirection).multiplyScalar(100).add(rig.camera.position);
    sun.target.position.copy(rig.camera.position);
    sun.target.updateMatrixWorld();
    if (boat) renderer.shadowMap.needsUpdate = true;
    const sunEl = ocean.sky.sunDirection.y;
    sun.intensity = 0.4 + 2.2 * Math.max(0, sunEl);
    hemi.intensity = 0.3 + 1.2 * Math.max(0, tmpDir.copy(ocean.sky.sunDirection).y);
    // Light colours from the sky so the ship sits in the same light as the water.
    ocean.sky.sunColor(sun.color).lerp(tmpColor.setRGB(0.55, 0.65, 0.9), 1 - smoothstep(-0.2, 0.05, sunEl));
    const ambient = ocean.sky.ambient(tmpAmbient);
    hemi.color.copy(ambient.sky).multiplyScalar(2.2).lerp(tmpColor.setRGB(0.8, 0.85, 0.95), 0.35);
    hemi.groundColor.copy(ambient.ground).multiplyScalar(4.0);
    // Eye adaptation: open up a little once the sun is well below the horizon
    // (the night sky carries its own radiance; this is only a nudge).
    const night = 1 - smoothstep(-0.32, -0.08, sunEl);
    renderer.toneMappingExposure = 1 + 0.25 * night;

    // Scene depth (terrain, ship) for the water's shoreline / shallows.
    ocean.renderSceneDepth(scene, rig.camera);
    if (sunShafts.active) {
      sunShafts.render(scene, rig.camera, gpuTimer);
    } else {
      gpuTimer.begin("water");
      renderer.render(scene, rig.camera);
      gpuTimer.end();
    }

    if (pendingSnapshot) {
      snapshots.set(pendingSnapshot, readPixels(renderer));
      pendingSnapshot = null;
    }
    if (pendingPixel) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const x = Math.floor(pendingPixel.u * (gl.drawingBufferWidth - 1));
      const y = Math.floor((1 - pendingPixel.v) * (gl.drawingBufferHeight - 1));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      pendingPixel.resolve([px[0]!, px[1]!, px[2]!, px[3]!]);
      pendingPixel = null;
    }
    if (pendingColumn) {
      const gl = renderer.getContext();
      const h = gl.drawingBufferHeight;
      const strip = new Uint8Array(h * 4);
      const x = Math.floor(pendingColumn.u * (gl.drawingBufferWidth - 1));
      gl.readPixels(x, 0, 1, h, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      const out = new Array<number>(h);
      // GL rows come back bottom-up; hand them over top-down.
      for (let i = 0; i < h; i++) {
        const j = (h - 1 - i) * 4;
        out[i] = 0.2126 * (strip[j] as number) + 0.7152 * (strip[j + 1] as number) + 0.0722 * (strip[j + 2] as number);
      }
      pendingColumn.resolve(out);
      pendingColumn = null;
    }
    const info = renderer.info.render;
    hud.frame(performance.now() - t0, info.calls, info.triangles, dpr, gpuTimer.smoothed(), gpuTimer.floor());

    const waiters = frameWaiters;
    frameWaiters = [];
    for (const w of waiters) w();
  };

  // The live loop. While a test drives the sim (`step`) the RAF chain is
  // dropped and restarted afterwards, so driven ticks never interleave with
  // wall-clock ones.
  let driving = false;
  let rafScheduled = false;
  const rafTick = (now: number): void => {
    rafScheduled = false;
    if (driving) return;
    // RAF's `now` is the frame's start, which can precede the `performance.now()`
    // taken when a driven run ended — never step backwards.
    const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    tick(dt);
    scheduleRaf();
  };
  const scheduleRaf = (): void => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(rafTick);
  };
  const frame = (): Promise<void> => new Promise((r) => frameWaiters.push(r));
  const step = (dt: number, frames = 1): Promise<void> => {
    if (driving) return Promise.reject(new Error("step: already driving"));
    if (!(dt > 0) || !(frames >= 0)) return Promise.reject(new Error("step: dt must be > 0 and frames ≥ 0"));
    driving = true;
    try {
      for (let i = 0; i < frames; i++) tick(dt);
    } finally {
      driving = false;
      lastNow = performance.now();
      scheduleRaf();
    }
    return Promise.resolve();
  };
  const advance = (seconds: number, dt = 1 / 60): Promise<void> => step(dt, Math.round(seconds / dt));

  scheduleRaf();

  // 5. Ready.
  await frame();
  await loading.finish();

  // Assets stream in after the ocean is up (spec §1.15): the glTF galleon
  // replaces the procedural one when it lands; on any failure (or
  // `?ship=procedural`) the procedural model stays.
  const assetsReady = (async (): Promise<void> => {
    await vegetation.ready;
    if (requestedShipModel() !== "gltf") return;
    try {
      const loaded = await loadShipGltf(SHIP_GLTF_URL, sharedShipMaterials(), { targetLength: rig.hull.length, targetDraft: rig.hull.physics.dims.draft });
      rig.hull.setModel(loaded.model, loaded.dims, "gltf", loaded.dispose);
      renderer.compile(scene, rig.camera);
    } catch (err) {
      console.warn(`ship glTF unavailable, keeping the procedural galleon: ${String(err)}`);
    }
  })();

  window.__app = {
    ...window.__app,
    params: () => cloneParams(params),
    setParam: (path, v) => {
      const cur = getPath(params, path);
      const value = typeof cur === "number" && typeof v === "string" ? Number(v) : v;
      applyParams(setPath(params, path, value));
      return frame();
    },
    setPreset,
    setQuality,
    setMode: (m) => {
      rig.setMode(m);
      return frame();
    },
    frame,
    step,
    advance,
    simTime: () => simTime,
    stats: () => hud.stats(),
    setGpuTimer: (on) => {
      gpuTimer.enabled = on;
      return frame();
    },
    contextLost: () => contextLost,
    camera: () => ({ position: rig.camera.position.toArray() as [number, number, number], mode: rig.mode }),
    setCameraPosition: (p) => {
      rig.setMode("fly");
      rig.camera.position.set(p[0], p[1], p[2]);
      return frame();
    },
    underwater: () => isUnderwater,
    setCameraDirection: (d) => {
      rig.setMode("fly");
      rig.setFlyDirection(new THREE.Vector3(d[0], d[1], d[2]));
      return frame();
    },
    sunShafts: () => ({
      sunUv: [sunShafts.sunUv.x, 1 - sunShafts.sunUv.y],
      strength: sunShafts.strength,
      sunDir: sunShafts.sunDirW.toArray() as [number, number, number],
    }),
    spray: () => ({ ...spray.count(), capacity: spray.capacity }),
    rain: () => ({ streaks: rain.streaks, ripples: rain.ripples, intensity: rain.intensity }),
    hull: () => ({
      position: rig.hull.position.toArray() as [number, number, number],
      waterHeight: rig.lastWaterHeight,
    }),
    ship: () => ({
      speed: rig.hull.speed,
      pitch: rig.hull.pitch,
      roll: rig.hull.roll,
      heading: rig.hull.heading,
      model: rig.hull.modelKind,
    }),
    assetsReady,
    vegetation: () => ({ palms: vegetation.palmCount, rocks: vegetation.rockCount, model: vegetation.palmModel }),
    snapshot: (name) => {
      pendingSnapshot = name;
      return frame();
    },
    diff: (a, b) => {
      const pa = snapshots.get(a);
      const pb = snapshots.get(b);
      if (!pa || !pb || pa.length !== pb.length) throw new Error("diff: missing or mismatched snapshots");
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) {
        sum += Math.abs((pa[i] as number) - (pb[i] as number));
        sum += Math.abs((pa[i + 1] as number) - (pb[i + 1] as number));
        sum += Math.abs((pa[i + 2] as number) - (pb[i + 2] as number));
      }
      return sum / ((pa.length / 4) * 3);
    },
    pixel: (u, v) => new Promise((resolve) => (pendingPixel = { u, v, resolve })),
    column: (u) => new Promise((resolve) => (pendingColumn = { u, resolve })),
    preset: () => presetName,
    wakeSample: (dx, dz) => wake.sample(dx, dz),
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function readPixels(renderer: THREE.WebGLRenderer): Uint8Array {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

interface ModeCard {
  fps: HTMLElement;
}

const LEGENDS: Record<CameraMode, [string, string][]> = {
  orbit: [
    ["Orbit", "LMB"],
    ["Pan", "RMB"],
    ["Zoom", "Scroll"],
  ],
  fly: [
    ["Move", "WASD"],
    ["Up / Down", "E / Q"],
    ["Look", "Drag"],
  ],
  boat: [
    ["Throttle", "W / S"],
    ["Rudder", "A / D"],
    ["Hide UI", "H"],
  ],
};

function buildModeCard(parent: HTMLElement, rig: CameraRig): ModeCard {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.testid = "mode-card";
  card.innerHTML = `
    <div class="fps"><div class="fps-num" data-testid="fps-big">—</div><div class="fps-label">FPS</div></div>
    <div class="modes"></div>
    <dl class="legend" data-testid="legend"></dl>`;
  parent.appendChild(card);
  const modes = card.querySelector(".modes") as HTMLElement;
  const legend = card.querySelector(".legend") as HTMLElement;
  const buttons = new Map<CameraMode, HTMLButtonElement>();
  for (const m of ["orbit", "fly", "boat"] as CameraMode[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mode";
    b.dataset.testid = `mode-${m}`;
    b.innerHTML = `<span class="mode-key">${MODE_INDEX[m]}</span><span class="mode-name">${m[0]!.toUpperCase()}${m.slice(1)}</span>`;
    b.addEventListener("click", () => rig.setMode(m));
    modes.appendChild(b);
    buttons.set(m, b);
  }
  const paint = (m: CameraMode): void => {
    for (const [k, b] of buttons) b.classList.toggle("is-active", k === m);
    legend.innerHTML = LEGENDS[m]
      .map(([what, key]) => `<div class="legend-row"><dt>${what}</dt><dd><kbd>${key}</kbd></dd></div>`)
      .join("");
  };
  paint(rig.mode);
  rig.onModeChange(paint);
  return { fps: card.querySelector(".fps-num") as HTMLElement };
}

const loadingOverlay = new LoadingOverlay(document.getElementById("app") as HTMLElement);
const ready = boot(loadingOverlay);
window.__app = { ready } as AppApi;
ready.catch((err: unknown) => {
  if (err instanceof UnsupportedError) {
    console.warn(err.message);
    loadingOverlay.fail(err.message);
  } else {
    console.error(err);
    loadingOverlay.fail(`FAILED: ${String(err)}`);
  }
});
