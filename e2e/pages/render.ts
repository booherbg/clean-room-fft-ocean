/**
 * Render-layer e2e page. Drives `Ocean` with a CPU stub simulation: the
 * cascade textures are filled from `core/oceanCpu.simulate()` at N = 64 into
 * float DataTextures, so shading, sky and clipmap are pixel-testable without
 * the GPU passes.
 *
 * window.__render = { ready, screenshotReady(), setParams(json), setTime(t),
 *                     stats(), frameStats(), snapshot(name), diff(a, b) }
 * Open with `?gpu` to drive the real `OceanSim` instead of the stub.
 */
import * as THREE from "three";
import { cascadeLayout } from "../../src/core/cascades";
import { simulate } from "../../src/core/oceanCpu";
import { cloneParams, DEFAULT_PARAMS, type OceanParams } from "../../src/core/params";
import type { CascadeProvider, CascadeTextures } from "../../src/render/cascadeTextures";
import { Ocean } from "../../src/render/ocean";
import { Terrain } from "../../src/render/terrain";

const N = 64;

function floatTex(N: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(N * N * 4), N, N, THREE.RGBAFormat, THREE.FloatType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

class CpuStubSim implements CascadeProvider {
  readonly cascades: CascadeTextures[] = [];
  private params: OceanParams;
  private dirty = true;
  private lastT = NaN;

  constructor(params: OceanParams) {
    this.params = cloneParams(params);
    for (const layout of cascadeLayout(this.params.maxScale, this.params.quality)) {
      this.cascades.push({
        size: layout.size,
        N,
        displacement: floatTex(N),
        derivatives: floatTex(N),
        jacobian: floatTex(N),
        foam: floatTex(N),
      });
    }
  }

  setParams(p: OceanParams): void {
    this.params = cloneParams(p);
    this.dirty = true;
  }

  update(t: number): void {
    if (!this.dirty && t === this.lastT) return;
    this.dirty = false;
    this.lastT = t;
    const layouts = cascadeLayout(this.params.maxScale, this.params.quality);
    const foam = this.params.foam;
    this.cascades.forEach((c, i) => {
      const layout = layouts[i];
      if (!layout) return;
      const f = simulate(this.params.waves, N, layout, t);
      const disp = (c.displacement as THREE.DataTexture).image.data as Float32Array;
      const der = (c.derivatives as THREE.DataTexture).image.data as Float32Array;
      const jac = (c.jacobian as THREE.DataTexture).image.data as Float32Array;
      const fo = (c.foam as THREE.DataTexture).image.data as Float32Array;
      for (let k = 0; k < N * N; k++) {
        disp[k * 4] = f.dx[k] as number;
        disp[k * 4 + 1] = f.height[k] as number;
        disp[k * 4 + 2] = f.dz[k] as number;
        disp[k * 4 + 3] = f.dxdz[k] as number;
        der[k * 4] = f.slopeX[k] as number;
        der[k * 4 + 1] = f.slopeZ[k] as number;
        der[k * 4 + 2] = f.dxdx[k] as number;
        der[k * 4 + 3] = f.dzdz[k] as number;
        const J = f.jacobian[k] as number;
        jac[k * 4] = J;
        jac[k * 4 + 3] = 1;
        // Steady-state foam energy (no memory in the stub): crest term only,
        // cascades 0 and 1 carry foam like the GPU sim.
        fo[k * 4] = foam.enabled && i < 2 ? foam.crestStrength * Math.max(0, Math.min(1, foam.threshold - J)) : 0;
      }
      c.displacement.needsUpdate = true;
      c.derivatives.needsUpdate = true;
      c.jacobian.needsUpdate = true;
      (c.foam as THREE.DataTexture).needsUpdate = true;
    });
  }

  dispose(): void {
    for (const c of this.cascades) {
      c.displacement.dispose();
      c.derivatives.dispose();
      c.jacobian.dispose();
      c.foam?.dispose();
    }
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 40000);
camera.position.set(0, 18, 40);
camera.lookAt(0, 4, -160);

let params = cloneParams(DEFAULT_PARAMS);
// `?gpu` drives the real OceanSim instead of the CPU stub (manual inspection).
const useGpu = new URLSearchParams(location.search).has("gpu");
const ocean = new Ocean(renderer, params, useGpu ? {} : { sim: new CpuStubSim(params) });
scene.add(ocean);
const terrain = new Terrain(params.waves.seed);
terrain.setParams(params);
terrain.attachTo(ocean);
scene.add(terrain);

let time = 3.0;
let lastT = 3.0;
function frame(): void {
  ocean.update(camera, time, time - lastT);
  terrain.update(ocean.sky, time, false);
  ocean.renderSceneDepth(scene, camera);
  lastT = time;
  renderer.render(scene, camera);
}

let framePromise: Promise<void> = Promise.resolve();
function renderFrames(n: number): Promise<void> {
  framePromise = new Promise<void>((resolve) => {
    let left = n;
    const tick = (): void => {
      frame();
      if (--left > 0) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  return framePromise;
}

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

/** Pixel statistics of the current frame, computed in-page (no PNG decode). */
export interface FrameStats {
  width: number;
  height: number;
  /** RGB of the pixel at (50 %, 70 %) — water, below the horizon. */
  centre: [number, number, number];
  /** Mean Rec.709 luminance, 0–255. */
  meanLuminance: number;
  /** Count of near-white pixels (all channels > 200) in the lower 55 %. */
  nearWhite: number;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const snapshots = new Map<string, Uint8Array>();

function readPixels(): { w: number; h: number; px: Uint8Array } {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { w, h, px };
}

function frameStats(): FrameStats {
  const { w, h, px } = readPixels();
  // readPixels is bottom-up: row 0 is the bottom of the screen.
  const at = (x: number, yTop: number): [number, number, number] => {
    const i = ((h - 1 - yTop) * w + x) * 4;
    return [px[i] as number, px[i + 1] as number, px[i + 2] as number];
  };
  let lum = 0;
  for (let i = 0; i < w * h; i++) {
    lum += 0.2126 * (px[i * 4] as number) + 0.7152 * (px[i * 4 + 1] as number) + 0.0722 * (px[i * 4 + 2] as number);
  }
  let white = 0;
  for (let yTop = Math.floor(h * 0.45); yTop < h; yTop++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, yTop);
      if (r > 200 && g > 200 && b > 200) white++;
    }
  }
  return { width: w, height: h, centre: at(Math.floor(w / 2), Math.floor(h * 0.7)), meanLuminance: lum / (w * h), nearWhite: white };
}

declare global {
  interface Window {
    __render: {
      ready: Promise<void>;
      screenshotReady: () => Promise<void>;
      setParams: (json: string | DeepPartial<OceanParams>) => Promise<void>;
      setTime: (t: number) => Promise<void>;
      stats: () => { draws: number; tris: number };
      frameStats: () => FrameStats;
      /** Store the current frame's pixels under a name. */
      snapshot: (name: string) => void;
      /** Mean absolute RGB difference (0–255) between two stored snapshots. */
      diff: (a: string, b: string) => number;
      /** RGB of the current frame at normalised (u, v), v down. */
      pixel: (u: number, v: number) => [number, number, number];
      /** Normalised screen (u, v) of a world point, v down; null if behind the camera. */
      project: (x: number, y: number, z: number) => [number, number] | null;
      /** Terrain height at world (x, z) (nearest sample). */
      terrainHeight: (x: number, z: number) => number;
      /** World (x, z) of the island centre. */
      island: () => [number, number];
      /** Move the camera: position, look-at target, and (optional) up vector; renders two frames. */
      setCamera: (pos: [number, number, number], target: [number, number, number], up?: [number, number, number]) => Promise<void>;
      /** Mean RGB of the current frame over the (2r+1)² pixel square centred at normalised (u, v). */
      regionMean: (u: number, v: number, r: number) => [number, number, number];
    };
  }
}

window.__render = {
  ready: renderFrames(2),
  screenshotReady: () => renderFrames(2),
  setParams: (json) => {
    const patch = (typeof json === "string" ? JSON.parse(json) : json) as DeepPartial<OceanParams>;
    const next = cloneParams(params);
    for (const key of Object.keys(patch) as (keyof OceanParams)[]) {
      const v = patch[key];
      if (v && typeof v === "object") Object.assign(next[key] as object, v);
      else (next as unknown as Record<string, unknown>)[key] = v;
    }
    params = next;
    ocean.setParams(params);
    terrain.setParams(params);
    return renderFrames(2);
  },
  setTime: (t) => {
    time = t;
    return renderFrames(2);
  },
  stats: () => ocean.stats(),
  frameStats,
  snapshot: (name) => {
    snapshots.set(name, readPixels().px);
  },
  diff: (a, b) => {
    const pa = snapshots.get(a);
    const pb = snapshots.get(b);
    if (!pa || !pb || pa.length !== pb.length) throw new Error("diff: missing or mismatched snapshots");
    let sum = 0;
    let n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      sum += Math.abs((pa[i] as number) - (pb[i] as number));
      sum += Math.abs((pa[i + 1] as number) - (pb[i + 1] as number));
      sum += Math.abs((pa[i + 2] as number) - (pb[i + 2] as number));
      n += 3;
    }
    return sum / n;
  },
  pixel: (u, v) => {
    const { w, h, px } = readPixels();
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const yTop = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    const i = ((h - 1 - yTop) * w + x) * 4;
    return [px[i] as number, px[i + 1] as number, px[i + 2] as number];
  },
  project: (x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    if (p.z > 1 || p.z < -1) return null;
    return [p.x * 0.5 + 0.5, 1 - (p.y * 0.5 + 0.5)];
  },
  terrainHeight: (x, z) => terrain.heightAt(x, z),
  island: () => [terrain.position.x, terrain.position.z],
  setCamera: (pos, target, up) => {
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.up.set(...(up ?? [0, 1, 0]));
    camera.lookAt(target[0], target[1], target[2]);
    return renderFrames(2);
  },
  regionMean: (u, v, r) => {
    const { w, h, px } = readPixels();
    const cx = Math.floor(u * w);
    const cy = Math.floor(v * h);
    const sum: [number, number, number] = [0, 0, 0];
    let n = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.min(w - 1, Math.max(0, cx + dx));
        const yTop = Math.min(h - 1, Math.max(0, cy + dy));
        const i = ((h - 1 - yTop) * w + x) * 4;
        sum[0] += px[i] as number;
        sum[1] += px[i + 1] as number;
        sum[2] += px[i + 2] as number;
        n++;
      }
    }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  },
};
