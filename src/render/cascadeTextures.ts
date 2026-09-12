/**
 * The contract between the simulation (gpu layer) and the renderer.
 *
 * The water material depends only on this shape, so it can be fed by the
 * real `OceanSim` cascades or by any stand-in (the e2e page fills these from
 * the CPU reference `core/oceanCpu.simulate()`).
 */
import type * as THREE from "three";
import type { OceanParams } from "../core/params";

export interface CascadeTextures {
  /** Tile side in metres; the material samples at worldXZ / size. */
  size: number;
  /** Texels per tile side (the FFT size). */
  N: number;
  /** RGBA float: (λ·Dx, h, λ·Dz, ∂Dx/∂z). */
  displacement: THREE.Texture;
  /** RGBA float: (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — raw, not λ-scaled. */
  derivatives: THREE.Texture;
  /** R float: J = (1+λ∂Dx/∂x)(1+λ∂Dz/∂z) − (λ∂Dx/∂z)². */
  jacobian: THREE.Texture;
  /** R float: foam energy, or null when the cascade carries no foam field. */
  foam: THREE.Texture | null;
}

/** Anything that can drive the renderer: `OceanSim` or a stub. */
export interface CascadeProvider {
  readonly cascades: readonly CascadeTextures[];
  setParams(p: OceanParams): void;
  update(t: number, dt: number): void;
  /**
   * After a WebGL context restore: rebuild everything whose GPU-side state
   * (render-target contents, PBOs) was lost. Optional: a CPU stub has none.
   */
  contextRestored?(): void;
  dispose(): void;
}

/**
 * CPU access to the displacement field (buoyancy, spec §1.9). Implemented by
 * `OceanSim`; a provider without it cannot float a hull.
 */
export interface HeightReadback {
  /**
   * A `w`×`h` texel block of cascade `cascadeIndex`'s displacement texture
   * starting at texel (x, y): `w*h*4` floats, rows bottom-up, RGBA =
   * (λ·Dx, h, λ·Dz, ∂Dx/∂z). Synchronous (`gl.readPixels`).
   */
  readDisplacementBlock(cascadeIndex: number, x: number, y: number, w: number, h: number): Float32Array;
  /**
   * Asynchronous variant (PBO + fence): start reading the block into `slot`;
   * `consumeDisplacementBlock(slot)` on a later frame returns it (rows
   * bottom-up, `w*h*4` floats, valid until the slot's next consume) or null
   * when nothing was issued.
   */
  issueDisplacementBlock(slot: number, cascadeIndex: number, x: number, y: number, w: number, h: number): void;
  consumeDisplacementBlock(slot: number): Float32Array | null;
}

export function hasHeightReadback(p: CascadeProvider): p is CascadeProvider & HeightReadback {
  return typeof (p as Partial<HeightReadback>).readDisplacementBlock === "function";
}
