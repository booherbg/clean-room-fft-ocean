/**
 * GPU e2e page: runs the GPU passes and the CPU oracle side by side in a real
 * WebGL2 context and exposes comparisons on `window.__gpu`. Playwright calls
 * these and asserts on the returned numbers (no arrays cross the bridge).
 */
import * as THREE from "three";
import { cascadeLayout, type CascadeLayout } from "../../src/core/cascades";
import { fft2d } from "../../src/core/fft";
import { simulate as cpuSimulate } from "../../src/core/oceanCpu";
import { DEFAULT_PARAMS, type FoamParams, type WaveParams } from "../../src/core/params";
import { splitmix32 } from "../../src/core/random";
import { FftPass } from "../../src/gpu/fftPass";
import { FoamPass } from "../../src/gpu/foamPass";
import { OceanSim } from "../../src/gpu/oceanSim";
import { readTarget } from "../../src/gpu/readback";
import { Cascade } from "../../src/gpu/cascade";
import { makeFloatDataTexture } from "../../src/gpu/targets";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: false });
renderer.autoClear = true;

// ---------- small numeric helpers ----------

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) ** 2;
  return Math.sqrt(s / a.length);
}

function mean(a: Float32Array, stride = 1, offset = 0): number {
  let s = 0;
  let n = 0;
  for (let i = offset; i < a.length; i += stride) {
    s += a[i] as number;
    n++;
  }
  return s / n;
}

/** Pull one float channel (`lo`) out of an RGBA array. */
function channel(rgba: Float32Array, lo: number): Float32Array {
  const n = rgba.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + lo] as number;
  return out;
}

export interface FieldError {
  relRms: number;
  maxAbsErr: number;
  cpuRms: number;
  /** Index of the first texel whose abs error exceeds 1e-3·cpuRms, or -1. */
  firstDiff: number;
  gpuAt: number;
  cpuAt: number;
}

function compare(gpu: Float32Array, cpu: Float32Array): FieldError {
  const diff = new Float32Array(cpu.length);
  let maxAbsErr = 0;
  const cpuRms = rms(cpu);
  let firstDiff = -1;
  for (let i = 0; i < cpu.length; i++) {
    const d = (gpu[i] as number) - (cpu[i] as number);
    diff[i] = d;
    maxAbsErr = Math.max(maxAbsErr, Math.abs(d));
    if (firstDiff < 0 && Math.abs(d) > 1e-3 * cpuRms) firstDiff = i;
  }
  const at = Math.max(firstDiff, 0);
  return {
    relRms: cpuRms > 0 ? rms(diff) / cpuRms : rms(diff),
    maxAbsErr,
    cpuRms,
    firstDiff,
    gpuAt: gpu[at] as number,
    cpuAt: cpu[at] as number,
  };
}

// ---------- FFT pass vs core.fft2d ----------

export interface FftResult {
  maxErr: number;
  maxAbs: number;
  rel: number;
}

function fftRoundTrip(N: number, inverse: boolean): FftResult {
  const rng = splitmix32(42 + N);
  const inputs: Float32Array[] = [];
  const textures: THREE.DataTexture[] = [];
  for (let t = 0; t < 4; t++) {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
    inputs.push(data);
    textures.push(makeFloatDataTexture(data, N, N));
  }
  const pass = new FftPass(N, { inverse });
  const out = pass.render(renderer, textures);

  let maxErr = 0;
  let maxAbs = 0;
  for (let t = 0; t < 4; t++) {
    const gpu = readTarget(renderer, out, t);
    for (const lo of [0, 2]) {
      const work = new Float32Array(N * N * 2);
      const src = inputs[t]!;
      for (let p = 0; p < N * N; p++) {
        work[p * 2] = src[p * 4 + lo] as number;
        work[p * 2 + 1] = src[p * 4 + lo + 1] as number;
      }
      fft2d(work, N, inverse);
      const scale = inverse ? N * N : 1; // GPU inverse is unnormalised
      for (let p = 0; p < N * N; p++) {
        const cr = (work[p * 2] as number) * scale;
        const ci = (work[p * 2 + 1] as number) * scale;
        maxAbs = Math.max(maxAbs, Math.abs(cr), Math.abs(ci));
        maxErr = Math.max(maxErr, Math.abs((gpu[p * 4 + lo] as number) - cr), Math.abs((gpu[p * 4 + lo + 1] as number) - ci));
      }
    }
  }
  pass.dispose();
  for (const tex of textures) tex.dispose();
  return { maxErr, maxAbs, rel: maxErr / maxAbs };
}

// ---------- full cascade vs core.simulate ----------

export type SimResult = Record<"h" | "dx" | "dz" | "dxdz" | "sx" | "sz" | "dxdx" | "dzdz" | "jacobianDev", FieldError>;

function simulateCompare(N: number, waves: WaveParams, t: number, layoutIndex = 0): SimResult {
  const layout: CascadeLayout = cascadeLayout(1024, "high")[layoutIndex]!;
  const cascade = new Cascade(renderer, N, layout);
  cascade.update(t, waves);
  const disp = readTarget(renderer, cascade.unpack.targets, 0);
  const deriv = readTarget(renderer, cascade.unpack.targets, 1);
  const jac = readTarget(renderer, cascade.unpack.targets, 2);
  cascade.dispose();

  const cpu = cpuSimulate(waves, N, layout, t);
  const dev = (a: Float32Array) => a.map((v) => v - 1);
  return {
    dx: compare(channel(disp, 0), cpu.dx),
    h: compare(channel(disp, 1), cpu.height),
    dz: compare(channel(disp, 2), cpu.dz),
    dxdz: compare(channel(disp, 3), cpu.dxdz),
    sx: compare(channel(deriv, 0), cpu.slopeX),
    sz: compare(channel(deriv, 1), cpu.slopeZ),
    dxdx: compare(channel(deriv, 2), cpu.dxdx),
    dzdz: compare(channel(deriv, 3), cpu.dzdz),
    jacobianDev: compare(dev(channel(jac, 0)), dev(cpu.jacobian)),
  };
}

// ---------- foam ----------

export interface FoamStepOptions {
  N: number;
  /** Constant Jacobian fed to the pass. */
  J: number;
  dt: number;
  foam: Partial<FoamParams>;
  steps: number;
  /** Optional constant slope (∂h/∂x, ∂h/∂z). */
  slope?: [number, number];
  windDir?: [number, number];
}

/** Mean foam energy after each step. */
function foamSteps(o: FoamStepOptions): number[] {
  const { N } = o;
  const jac = new Float32Array(N * N * 4);
  const der = new Float32Array(N * N * 4);
  for (let p = 0; p < N * N; p++) {
    jac[p * 4] = o.J;
    der[p * 4] = o.slope?.[0] ?? 0;
    der[p * 4 + 1] = o.slope?.[1] ?? 0;
  }
  const jacobian = makeFloatDataTexture(jac, N, N);
  const derivatives = makeFloatDataTexture(der, N, N);
  const pass = new FoamPass(N, 96);
  const foam: FoamParams = { ...DEFAULT_PARAMS.foam, ...o.foam };
  const means: number[] = [];
  for (let s = 0; s < o.steps; s++) {
    pass.render(renderer, foam, { jacobian, derivatives, dt: o.dt, windDir: o.windDir ?? [1, 0] });
    means.push(mean(readTarget(renderer, pass.target, 0), 4, 0));
  }
  pass.dispose();
  jacobian.dispose();
  derivatives.dispose();
  return means;
}

export interface FoamDecayResult {
  /** Mean energy right after charging with J ≡ 0. */
  charged: number;
  /** Mean energy after one J ≡ 1 step with dt = dtOverDecay·decayTime. */
  after: number;
  /** ... after three such steps. */
  after3: number;
}

/** Charge the field (J ≡ 0), then let it decay under J ≡ 1. Same pass, so memory carries over. */
function foamDecay(o: { N: number; dtOverDecay: number; foam: Partial<FoamParams> }): FoamDecayResult {
  const { N } = o;
  const constant = (v: number) => {
    const a = new Float32Array(N * N * 4);
    for (let p = 0; p < N * N; p++) a[p * 4] = v;
    return makeFloatDataTexture(a, N, N);
  };
  const folded = constant(0);
  const flat = constant(1);
  const derivatives = constant(0);
  const foam: FoamParams = { ...DEFAULT_PARAMS.foam, ...o.foam };
  const pass = new FoamPass(N, 96);
  const step = (jacobian: THREE.Texture, dt: number) => {
    pass.render(renderer, foam, { jacobian, derivatives, dt, windDir: [1, 0] });
    return mean(readTarget(renderer, pass.target, 0), 4, 0);
  };
  const charged = step(folded, 0.001);
  const dt = o.dtOverDecay * foam.decayTime;
  const after = step(flat, dt);
  step(flat, dt);
  const after3 = step(flat, dt);
  pass.dispose();
  folded.dispose();
  flat.dispose();
  derivatives.dispose();
  return { charged, after, after3 };
}

// ---------- OceanSim smoke ----------

export interface SimSmoke {
  cascades: number;
  N: number;
  sizes: number[];
  foam: boolean[];
  heightRms: number[];
  foamMean: number[];
}

function oceanSimSmoke(quality: "low" | "medium" | "high", frames: number): SimSmoke {
  const params = { ...DEFAULT_PARAMS, quality, waves: { ...DEFAULT_PARAMS.waves, windSpeed: 15 } };
  const sim = new OceanSim(renderer, params);
  for (let f = 0; f < frames; f++) sim.update(f / 30, 1 / 30);
  const heightRms: number[] = [];
  const foamMean: number[] = [];
  for (const c of sim.cascades) {
    heightRms.push(rms(channel(readTarget(renderer, c.unpack.targets, 0), 1)));
    if (c.foamPass) {
      foamMean.push(mean(readTarget(renderer, c.foamPass.target, 0), 4, 0));
    }
  }
  const out: SimSmoke = {
    cascades: sim.cascades.length,
    N: sim.N,
    sizes: sim.cascades.map((c) => c.size),
    foam: sim.cascades.map((c) => c.foam !== null),
    heightRms,
    foamMean,
  };
  sim.dispose();
  return out;
}

declare global {
  interface Window {
    __gpu: {
      ready: boolean;
      webgl2: boolean;
      fftRoundTrip: typeof fftRoundTrip;
      simulate: (N: number, wavesJson: string, t: number, layoutIndex?: number) => SimResult;
      foamSteps: typeof foamSteps;
      foamDecay: typeof foamDecay;
      oceanSimSmoke: typeof oceanSimSmoke;
      glError: () => number;
    };
  }
}

window.__gpu = {
  ready: true,
  webgl2: renderer.getContext() instanceof WebGL2RenderingContext,
  fftRoundTrip,
  simulate: (N, wavesJson, t, layoutIndex) => simulateCompare(N, JSON.parse(wavesJson) as WaveParams, t, layoutIndex),
  foamSteps,
  foamDecay,
  oceanSimSmoke,
  glError: () => renderer.getContext().getError(),
};
