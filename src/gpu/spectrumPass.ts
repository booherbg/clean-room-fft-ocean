/**
 * Spectrum pass: waves → h0(k) texture (spec §1.1). Runs only when the wave
 * parameters change.
 *
 * The Gaussian pair ξ per texel is drawn on the CPU with `core/random`, in
 * exactly the order `initialSpectrum` draws it (row-major, always drawn), and
 * uploaded once per seed as a DataTexture. The shader does the
 * `sqrt(phi) / sqrt(2)` scaling so Φ(k) itself lives in GLSL too.
 */
import * as THREE from "three";
import type { CascadeLayout } from "../core/cascades";
import { cascadeSeed } from "../core/oceanCpu";
import type { WaveParams } from "../core/params";
import { gaussianPair, splitmix32 } from "../core/random";
import { alphaFor } from "../core/spectrum";
import { FullscreenPass } from "./passes/FullscreenPass";
import frag from "./spectrum.frag.glsl?raw";
import { makeFloatDataTexture, makeFloatTarget } from "./targets";

/** Finite stand-in for kMax = Infinity (highp float max is ~3.4e38). */
const K_INFINITY = 1e30;

/** ξ = (ξr, ξi) ~ N(0,1) per texel, packed RGBA (.ba unused). */
export function gaussianField(seed: number, N: number, size: number): Float32Array {
  const rng = splitmix32(cascadeSeed(seed, size));
  const out = new Float32Array(N * N * 4);
  for (let p = 0; p < N * N; p++) {
    const [xr, xi] = gaussianPair(rng);
    out[p * 4] = xr;
    out[p * 4 + 1] = xi;
  }
  return out;
}

export class SpectrumPass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;
  private gauss: THREE.DataTexture | null = null;
  private gaussSeed = NaN;

  constructor(
    readonly N: number,
    readonly layout: CascadeLayout,
  ) {
    this.target = makeFloatTarget(N, 1);
    this.pass = new FullscreenPass(frag, {
      uGauss: { value: null },
      uN: { value: N },
      uL: { value: layout.size },
      uKMin: { value: layout.kMin },
      uKMax: { value: Number.isFinite(layout.kMax) ? layout.kMax : K_INFINITY },
      uKMinWidth: { value: layout.kMinWidth },
      uKMaxWidth: { value: Number.isFinite(layout.kMax) ? layout.kMaxWidth : 0 },
      uAlpha: { value: 0 },
      uWindSpeed: { value: 1 },
      uWindDirection: { value: 0 },
      uGravity: { value: 9.81 },
      uGamma: { value: 3.3 },
      uPeakWavelength: { value: 70 },
      uSharpness: { value: 1 },
      uStandingWaveRatio: { value: 0 },
    });
  }

  /** h0(k).rg, h0(−k).ba */
  get texture(): THREE.Texture {
    return this.target.texture;
  }

  render(renderer: THREE.WebGLRenderer, waves: WaveParams): void {
    if (this.gauss === null || this.gaussSeed !== waves.seed) {
      this.gauss?.dispose();
      this.gauss = makeFloatDataTexture(gaussianField(waves.seed, this.N, this.layout.size), this.N, this.N);
      this.gaussSeed = waves.seed;
    }
    const u = this.pass.uniforms;
    u.uGauss!.value = this.gauss;
    u.uAlpha!.value = alphaFor(waves);
    u.uWindSpeed!.value = waves.windSpeed;
    u.uWindDirection!.value = waves.windDirection;
    u.uGravity!.value = waves.gravity;
    u.uGamma!.value = waves.jonswapGamma;
    u.uPeakWavelength!.value = waves.peakWavelength;
    u.uSharpness!.value = waves.spectralSharpness;
    u.uStandingWaveRatio!.value = waves.standingWaveRatio;
    this.pass.render(renderer, this.target);
  }

  dispose(): void {
    this.pass.dispose();
    this.target.dispose();
    this.gauss?.dispose();
  }
}
