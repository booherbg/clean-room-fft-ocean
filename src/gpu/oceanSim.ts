/**
 * The whole simulation: one `Cascade` per tile of the quality tier's layout.
 * `setParams` re-runs the spectrum only when the wave parameters changed;
 * a quality / maxScale change rebuilds the cascades.
 */
import type * as THREE from "three";
import { cascadeLayout } from "../core/cascades";
import { cloneParams, tierConfig, type OceanParams } from "../core/params";
import { Cascade } from "./cascade";
import { FftPass } from "./fftPass";
import { AsyncBlockReader } from "./readback";
import { NULL_TIMER, type GpuTimer } from "./gpuTimer";

/** Cascades that carry a foam field (0 and 1: the tiles foam is visible on). */
const FOAM_CASCADES = 2;

export class OceanSim {
  cascades: Cascade[] = [];
  /** GPU section timer the passes report into (a no-op timer by default). */
  timer: GpuTimer = NULL_TIMER;
  /** One FFT (ping-pong pair + butterfly table) per distinct N, shared by the cascades of that size. */
  private ffts = new Map<number, FftPass>();
  private readonly reader: AsyncBlockReader;
  private params: OceanParams;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    params: OceanParams,
  ) {
    this.params = cloneParams(params);
    this.reader = new AsyncBlockReader(renderer);
    this.build();
  }

  /** FFT size of the current tier. */
  get N(): number {
    return tierConfig(this.params.quality).N;
  }

  /** Current parameters (a copy). */
  getParams(): OceanParams {
    return cloneParams(this.params);
  }

  setParams(p: OceanParams): void {
    const prev = this.params;
    this.params = cloneParams(p);
    if (p.quality !== prev.quality || p.maxScale !== prev.maxScale) {
      this.build();
      return;
    }
    if (JSON.stringify(p.waves) !== JSON.stringify(prev.waves)) {
      for (const c of this.cascades) c.invalidateSpectrum();
    }
    if (!p.foam.enabled && prev.foam.enabled) {
      for (const c of this.cascades) c.foamPass?.reset();
    }
  }

  /** Advance to time `t`; `dt` drives foam decay. */
  update(t: number, dt: number): void {
    const { waves, foam } = this.params;
    const timer = this.timer;
    for (const c of this.cascades) {
      c.update(t, waves, timer);
      if (foam.enabled) c.updateFoam(dt, foam, waves.windDirection, waves.windSpeed, timer);
    }
  }

  /**
   * `HeightReadback`: a `w`×`h` texel block of cascade `cascadeIndex`'s
   * displacement texture from texel (x, y) — see `Cascade.readDisplacementBlock`.
   */
  readDisplacementBlock(cascadeIndex: number, x: number, y: number, w: number, h: number): Float32Array {
    const c = this.cascades[cascadeIndex];
    if (!c) throw new RangeError(`readDisplacementBlock: no cascade ${cascadeIndex}`);
    return c.readDisplacementBlock(x, y, w, h);
  }

  /** `HeightReadback`: asynchronous block read (one frame of latency) — see `AsyncBlockReader`. */
  issueDisplacementBlock(slot: number, cascadeIndex: number, x: number, y: number, w: number, h: number): void {
    const c = this.cascades[cascadeIndex];
    if (!c) throw new RangeError(`issueDisplacementBlock: no cascade ${cascadeIndex}`);
    this.reader.issue(slot, c.unpack.targets, x, y, w, h, 0);
  }

  consumeDisplacementBlock(slot: number): Float32Array | null {
    return this.reader.consume(slot);
  }

  /** After a WebGL context restore: fresh cascades (targets, foam) and readback buffers. */
  contextRestored(): void {
    this.reader.reset();
    this.build();
  }

  dispose(): void {
    this.disposeCascades();
    this.reader.dispose();
  }

  private disposeCascades(): void {
    for (const c of this.cascades) c.dispose();
    this.cascades = [];
    for (const f of this.ffts.values()) f.dispose();
    this.ffts.clear();
  }

  private build(): void {
    this.disposeCascades();
    const tier = tierConfig(this.params.quality);
    const layouts = cascadeLayout(this.params.maxScale, this.params.quality);
    this.cascades = layouts.map((layout, i) => {
      const N = layout.N;
      let fft = this.ffts.get(N);
      if (!fft) {
        fft = new FftPass(N, { inverse: true });
        this.ffts.set(N, fft);
      }
      return new Cascade(this.renderer, N, layout, { foam: tier.foam && i < FOAM_CASCADES, fft });
    });
  }
}
