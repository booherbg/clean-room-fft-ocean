/**
 * 2-D FFT as 2·log2(N) fullscreen butterfly passes (spec §1.3): log2(N)
 * horizontal stages then log2(N) vertical stages, ping-ponging between two
 * MRT×4 float targets so all eight complex channels travel together.
 *
 * The butterfly table comes from `core/butterflyTable` uploaded once as an
 * N × stages DataTexture. Output is *unnormalised*: the inverse transform
 * yields N² · IFFT, which `unpack` folds into its sign/scale step.
 */
import * as THREE from "three";
import { butterflyTable } from "../core/butterfly";
import frag from "./fft.frag.glsl?raw";
import { FullscreenPass } from "./passes/FullscreenPass";
import { makeFloatDataTexture, makeFloatTarget } from "./targets";

export interface FftPassOptions {
  /** Conjugate twiddles (inverse transform). Default true — the ocean only inverts. */
  inverse?: boolean;
}

export class FftPass {
  readonly stages: number;
  private readonly butterfly: THREE.DataTexture;
  private readonly pingPong: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly pass: FullscreenPass;

  constructor(
    readonly N: number,
    opts: FftPassOptions = {},
  ) {
    const table = butterflyTable(N);
    this.stages = table.stages;
    this.butterfly = makeFloatDataTexture(table.data, N, table.stages);
    this.pingPong = [makeFloatTarget(N, 4), makeFloatTarget(N, 4)];
    const defines: Record<string, string | number> = {};
    if (opts.inverse !== false) defines.INVERSE = 1;
    this.pass = new FullscreenPass(
      frag,
      {
        uIn0: { value: null },
        uIn1: { value: null },
        uIn2: { value: null },
        uIn3: { value: null },
        uButterfly: { value: this.butterfly },
        uStage: { value: 0 },
        uVertical: { value: false },
      },
      { defines },
    );
  }

  /**
   * Transform the four RGBA textures of `input` (an MRT×4 target or four
   * textures). Returns the ping-pong target holding the spatial result; it is
   * valid until the next `render` call.
   */
  render(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget | readonly THREE.Texture[]): THREE.WebGLRenderTarget {
    let src: readonly THREE.Texture[] = input instanceof THREE.WebGLRenderTarget ? input.textures : input;
    if (src.length !== 4) throw new Error(`FftPass.render: expected 4 input textures, got ${src.length}`);
    const u = this.pass.uniforms;
    let dstIndex = 0;
    for (let pass = 0; pass < 2 * this.stages; pass++) {
      const dst = this.pingPong[dstIndex]!;
      u.uIn0!.value = src[0];
      u.uIn1!.value = src[1];
      u.uIn2!.value = src[2];
      u.uIn3!.value = src[3];
      u.uStage!.value = pass % this.stages;
      u.uVertical!.value = pass >= this.stages;
      this.pass.render(renderer, dst);
      src = dst.textures;
      dstIndex ^= 1;
    }
    return this.pingPong[dstIndex ^ 1]!;
  }

  dispose(): void {
    this.pass.dispose();
    this.butterfly.dispose();
    this.pingPong[0].dispose();
    this.pingPong[1].dispose();
  }
}
