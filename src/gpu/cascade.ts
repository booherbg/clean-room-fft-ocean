/**
 * One cascade = one tile of side `layout.size` with its own band of
 * wavenumbers: spectrum → evolve → FFT → unpack (→ foam), plus the textures
 * the renderer samples.
 */
import type * as THREE from "three";
import type { CascadeLayout } from "../core/cascades";
import type { FoamParams, WaveParams } from "../core/params";
import { EvolvePass } from "./evolvePass";
import { FftPass } from "./fftPass";
import { FoamPass } from "./foamPass";
import { NULL_TIMER, type GpuTimer } from "./gpuTimer";
import { readTargetBlock } from "./readback";
import { SpectrumPass } from "./spectrumPass";
import { floatLinearSupported } from "./targets";
import { UnpackPass } from "./unpackPass";

export interface CascadeOptions {
  /** Attach a foam energy field to this cascade. */
  foam?: boolean;
  /**
   * A shared `FftPass` of the same N (its ping-pong pair and butterfly
   * table serve every cascade of that size; the result is consumed by
   * `unpack` before the next cascade runs). Owned by the caller.
   */
  fft?: FftPass;
}

export class Cascade {
  readonly spectrum: SpectrumPass;
  readonly evolve: EvolvePass;
  readonly fft: FftPass;
  readonly unpack: UnpackPass;
  readonly foamPass: FoamPass | null;
  private readonly ownsFft: boolean;
  private spectrumDirty = true;
  /** Reused every frame (no per-frame allocation on the main path). */
  private readonly foamInputs = {
    jacobian: null as unknown as THREE.Texture,
    derivatives: null as unknown as THREE.Texture,
    dt: 0,
    windDir: [1, 0] as [number, number],
    windSpeed: 0,
  };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly N: number,
    readonly layout: CascadeLayout,
    opts: CascadeOptions = {},
  ) {
    this.spectrum = new SpectrumPass(N, layout);
    this.evolve = new EvolvePass(N, layout.size);
    if (opts.fft && opts.fft.N !== N) throw new Error(`Cascade: shared FftPass is N=${opts.fft.N}, cascade is N=${N}`);
    this.fft = opts.fft ?? new FftPass(N, { inverse: true });
    this.ownsFft = !opts.fft;
    // The renderer samples these with world-space UVs; bilinear filtering
    // stops the fine cascade aliasing into near-field sparkle noise.
    const linear = floatLinearSupported(renderer);
    this.unpack = new UnpackPass(N, linear);
    // Breakup on in the app (the e2e oracle rig builds its own FoamPass with
    // the default 0 so the closed-form checks stay exact).
    this.foamPass = opts.foam ? new FoamPass(N, layout.size, linear, { breakup: 0.45 }) : null;
  }

  /** Tile side in metres. */
  get size(): number {
    return this.layout.size;
  }
  /** (λ·Dx, h, λ·Dz, ∂Dx/∂z) */
  get displacement(): THREE.Texture {
    return this.unpack.displacement;
  }
  /** (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) */
  get derivatives(): THREE.Texture {
    return this.unpack.derivatives;
  }
  /** (J, 0, 0, 0) */
  get jacobian(): THREE.Texture {
    return this.unpack.jacobian;
  }
  /** Foam energy in .r, or null when this cascade carries no foam. */
  get foam(): THREE.Texture | null {
    return this.foamPass?.texture ?? null;
  }

  /**
   * Synchronous CPU readback of a `w`×`h` texel block of the displacement
   * texture starting at texel (x, y): `w*h*4` floats, rows bottom-up, RGBA =
   * (λ·Dx, h, λ·Dz, ∂Dx/∂z). Leaves the renderer's target as it found it.
   */
  readDisplacementBlock(x: number, y: number, w: number, h: number): Float32Array {
    const prev = this.renderer.getRenderTarget();
    const out = readTargetBlock(this.renderer, this.unpack.targets, x, y, w, h, 0);
    this.renderer.setRenderTarget(prev);
    return out;
  }

  /** Mark h0 stale; it is re-rendered on the next `update`. */
  invalidateSpectrum(): void {
    this.spectrumDirty = true;
  }

  /**
   * Advance the surface to time `t` (seconds). `timer` brackets the GPU
   * sections `spectrum` (spectrum + evolve), `fft` and `unpack`.
   */
  update(t: number, waves: WaveParams, timer: GpuTimer = NULL_TIMER): void {
    timer.begin("spectrum");
    if (this.spectrumDirty) {
      this.spectrum.render(this.renderer, waves);
      this.spectrumDirty = false;
    }
    this.evolve.render(this.renderer, this.spectrum.texture, t, waves);
    timer.end();
    timer.begin("fft");
    const spatial = this.fft.render(this.renderer, this.evolve.targets);
    timer.end();
    timer.begin("unpack");
    this.unpack.render(this.renderer, spatial, waves.choppiness);
    timer.end();
  }

  /** Advance the foam field by `dt` seconds (no-op without foam); timed under `unpack`. */
  updateFoam(dt: number, foam: FoamParams, windDirection: number, windSpeed = 0, timer: GpuTimer = NULL_TIMER): void {
    if (!this.foamPass) return;
    const inputs = this.foamInputs;
    inputs.jacobian = this.jacobian;
    inputs.derivatives = this.derivatives;
    inputs.dt = dt;
    inputs.windDir[0] = Math.cos(windDirection);
    inputs.windDir[1] = Math.sin(windDirection);
    inputs.windSpeed = windSpeed;
    timer.begin("unpack");
    this.foamPass.render(this.renderer, foam, inputs);
    timer.end();
  }

  dispose(): void {
    this.spectrum.dispose();
    this.evolve.dispose();
    if (this.ownsFft) this.fft.dispose();
    this.unpack.dispose();
    this.foamPass?.dispose();
  }
}
