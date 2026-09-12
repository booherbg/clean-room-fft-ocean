/**
 * Evolve pass: h0 → time-evolved spectra A/B/C/D (MRT×4), packed exactly as
 * `core/oceanCpu.ts evolve()`.
 */
import * as THREE from "three";
import type { WaveParams } from "../core/params";
import frag from "./evolve.frag.glsl?raw";
import { FullscreenPass } from "./passes/FullscreenPass";
import { makeFloatTarget } from "./targets";

export class EvolvePass {
  /** MRT×4: attachments 0..3 = A, B, C, D. */
  readonly targets: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;

  constructor(
    readonly N: number,
    readonly size: number,
  ) {
    this.targets = makeFloatTarget(N, 4);
    this.pass = new FullscreenPass(frag, {
      uH0: { value: null },
      uN: { value: N },
      uL: { value: size },
      uT: { value: 0 },
      uGravity: { value: 9.81 },
    });
  }

  render(renderer: THREE.WebGLRenderer, h0: THREE.Texture, t: number, waves: WaveParams): void {
    const u = this.pass.uniforms;
    u.uH0!.value = h0;
    u.uT!.value = t * waves.animationSpeed;
    u.uGravity!.value = waves.gravity;
    this.pass.render(renderer, this.targets);
  }

  dispose(): void {
    this.pass.dispose();
    this.targets.dispose();
  }
}
