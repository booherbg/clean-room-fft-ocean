/**
 * Foam pass: a persistent energy field with memory (spec §1.5), ping-ponged
 * between two float targets. Runs once per frame after `UnpackPass`.
 */
import * as THREE from "three";
import type { FoamParams } from "../core/params";
import frag from "./foam.frag.glsl?raw";
import { FullscreenPass } from "./passes/FullscreenPass";
import { makeFloatTarget } from "./targets";

export interface FoamInputs {
  jacobian: THREE.Texture;
  derivatives: THREE.Texture;
  /** Seconds since the previous foam step. */
  dt: number;
  /** Unit vector the wind blows towards (x, z). */
  windDir: [number, number];
  /** Wind speed, m/s — drives the foam's downwind drift (default 0). */
  windSpeed?: number;
}

/**
 * Fixed tuning of the §1.16 heavy-sea terms (core/foamModel.ts is the CPU
 * reference). The advection and trough terms are no-ops on the constant
 * fields the e2e oracle feeds, so they can stay on; `breakup` perturbs the
 * injection per texel and so defaults *off* — the app switches it on.
 */
export interface FoamPassOptions {
  /** Downslope slide, m/s per unit slope. */
  slide?: number;
  /** Downwind drift as a fraction of the wind speed. */
  windDrift?: number;
  /** Decay-time multiplier gained in a full trough (J ≥ 2). */
  troughBoost?: number;
  /** Injection breakup weight ∈ [0,1]; 0 keeps the closed-form model exact. */
  breakup?: number;
}

export class FoamPass {
  private readonly pingPong: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;
  private readonly pass: FullscreenPass;
  private needsClear = true;

  private readonly windDrift: number;
  /** Slow clock for the breakup lace (sum of dts, wrapped). */
  private phase = 0;

  /** `linear`: bilinear-filter the field (needs OES_texture_float_linear). */
  constructor(
    readonly N: number,
    readonly size: number,
    linear = false,
    opts: FoamPassOptions = {},
  ) {
    this.pingPong = [makeFloatTarget(N, 1, { linear }), makeFloatTarget(N, 1, { linear })];
    this.windDrift = opts.windDrift ?? 0.03;
    this.pass = new FullscreenPass(frag, {
      uPrev: { value: null },
      uJacobian: { value: null },
      uDerivatives: { value: null },
      uN: { value: N },
      uDt: { value: 0 },
      uDecayTime: { value: 0.5 },
      uThreshold: { value: 0.6 },
      uCrestStrength: { value: 2.5 },
      uWindwardStrength: { value: 1.5 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uCell: { value: size / N },
      uSlide: { value: opts.slide ?? 0.9 },
      uWindDrift: { value: 0 },
      uTroughBoost: { value: opts.troughBoost ?? 1.5 },
      uBreakup: { value: opts.breakup ?? 0 },
      uPhase: { value: 0 },
    });
  }

  /** Foam energy in .r, most recent step. */
  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Render target holding the most recent step (for readback). */
  get target(): THREE.WebGLRenderTarget {
    return this.pingPong[this.current]!;
  }

  /** Forget the accumulated energy (next step starts from zero). */
  reset(): void {
    this.needsClear = true;
  }

  render(renderer: THREE.WebGLRenderer, foam: FoamParams, inputs: FoamInputs): void {
    if (this.needsClear) {
      for (const t of this.pingPong) {
        renderer.setRenderTarget(t);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
      }
      this.needsClear = false;
    }
    const prev = this.pingPong[this.current]!;
    const next = this.pingPong[this.current ^ 1]!;
    const u = this.pass.uniforms;
    u.uPrev!.value = prev.texture;
    u.uJacobian!.value = inputs.jacobian;
    u.uDerivatives!.value = inputs.derivatives;
    u.uDt!.value = inputs.dt;
    u.uDecayTime!.value = foam.decayTime;
    u.uThreshold!.value = foam.threshold;
    u.uCrestStrength!.value = foam.crestStrength;
    u.uWindwardStrength!.value = foam.windwardStrength;
    (u.uWindDir!.value as THREE.Vector2).set(inputs.windDir[0], inputs.windDir[1]);
    u.uWindDrift!.value = this.windDrift * (inputs.windSpeed ?? 0);
    // The lace crawls in tile-texel units; wrap so precision never drifts.
    this.phase = (this.phase + inputs.dt * 0.6) % 1024;
    u.uPhase!.value = this.phase;
    this.pass.render(renderer, next);
    this.current ^= 1;
  }

  dispose(): void {
    this.pass.dispose();
    this.pingPong[0].dispose();
    this.pingPong[1].dispose();
  }
}
