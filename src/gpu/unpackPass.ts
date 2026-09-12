/**
 * Unpack pass: spatial MRT×4 (A,B,C,D after the inverse FFT) → the three
 * textures the renderer samples: displacement, derivatives, jacobian.
 */
import * as THREE from "three";
import { FullscreenPass } from "./passes/FullscreenPass";
import { makeFloatTarget } from "./targets";
import frag from "./unpack.frag.glsl?raw";

export class UnpackPass {
  /** MRT×3: 0 = displacement, 1 = derivatives, 2 = jacobian. */
  readonly targets: THREE.WebGLRenderTarget;
  private readonly pass: FullscreenPass;

  /** `linear`: trilinear (mipmapped) outputs — needs OES_texture_float_linear. */
  constructor(
    readonly N: number,
    linear = false,
  ) {
    this.targets = makeFloatTarget(N, 3, { mipmaps: linear });
    this.pass = new FullscreenPass(frag, {
      uIn0: { value: null },
      uIn1: { value: null },
      uIn2: { value: null },
      uIn3: { value: null },
      uN: { value: N },
      uLambda: { value: 1 },
    });
  }

  /** (λ·Dx, h, λ·Dz, ∂Dx/∂z) */
  get displacement(): THREE.Texture {
    return this.targets.textures[0]!;
  }
  /** (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — raw, not scaled by λ. */
  get derivatives(): THREE.Texture {
    return this.targets.textures[1]!;
  }
  /** (J, 0, 0, 0) */
  get jacobian(): THREE.Texture {
    return this.targets.textures[2]!;
  }

  render(renderer: THREE.WebGLRenderer, spatial: THREE.WebGLRenderTarget, choppiness: number): void {
    const u = this.pass.uniforms;
    const t = spatial.textures;
    u.uIn0!.value = t[0];
    u.uIn1!.value = t[1];
    u.uIn2!.value = t[2];
    u.uIn3!.value = t[3];
    u.uLambda!.value = choppiness;
    this.pass.render(renderer, this.targets);
  }

  dispose(): void {
    this.pass.dispose();
    this.targets.dispose();
  }
}
