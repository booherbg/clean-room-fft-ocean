/**
 * Wake pass: an iWave height field (spec §1.9) on a world-space square that
 * follows the hull in cell-snapped steps, ping-ponged between two float MRT
 * targets. Attachment 0 is the simulation state, attachment 1 the
 * renderer-facing view `(h, ∂h/∂x, ∂h/∂z, foam)`.
 */
import * as THREE from "three";
import { iwaveKernel } from "../core/iwave";
import frag from "./wake.frag.glsl?raw";
import { FullscreenPass } from "./passes/FullscreenPass";
import { readTargetBlock } from "./readback";
import { makeFloatTarget } from "./targets";

const KERNEL_P = 6;

export interface WakeInputs {
  /** Seconds since the previous step (clamped and sub-stepped inside). */
  dt: number;
  /** Texel shift of the anchor since the previous step. */
  shift: [number, number];
  /** Hull centre in texel space of *this* frame's square. */
  hull: [number, number];
  /** Unit forward direction of the hull in texel space. */
  forward: [number, number];
  /** Hull half-length and half-beam in texels. */
  halfSize: [number, number];
  /** |speed| / cruise speed, 0..1. */
  speedFactor: number;
}

export interface WakeOptions {
  /** Obstruction depth at full speed, metres (default 1.0). */
  draft?: number;
  /** Velocity damping α, 1/s (default 0.12). */
  damping?: number;
  /** Foam memory, seconds (default 3). */
  foamDecay?: number;
  gravity?: number;
  /** Longest explicit step; larger frame gaps are sub-stepped (default 1/40). */
  maxStep?: number;
}

export class WakePass {
  private readonly pingPong: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;
  private readonly pass: FullscreenPass;
  private needsClear = true;
  private readonly maxStep: number;

  /** `linear`: bilinear-filter the view (needs OES_texture_float_linear). */
  constructor(
    readonly N: number,
    readonly size: number,
    linear = false,
    opts: WakeOptions = {},
  ) {
    const make = (): THREE.WebGLRenderTarget => {
      const t = makeFloatTarget(N, 2, { linear });
      for (const tex of t.textures) {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
      }
      return t;
    };
    this.pingPong = [make(), make()];
    this.maxStep = opts.maxStep ?? 1 / 40;
    this.pass = new FullscreenPass(frag, {
      uPrev: { value: null },
      uN: { value: N },
      uCell: { value: size / N },
      uDt: { value: 0 },
      uGravity: { value: opts.gravity ?? 9.81 },
      uDamping: { value: opts.damping ?? 0.12 },
      uKernel: { value: Array.from(iwaveKernel(KERNEL_P, 1, true)) },
      uShift: { value: new THREE.Vector2(0, 0) },
      uHull: { value: new THREE.Vector2(0, 0) },
      uHullFwd: { value: new THREE.Vector2(0, -1) },
      uHullHalf: { value: new THREE.Vector2(8, 3) },
      uSpeedFactor: { value: 0 },
      uDraft: { value: opts.draft ?? 1.0 },
      uFoamDecay: { value: opts.foamDecay ?? 3 },
    });
  }

  /** Metres per texel. */
  get cell(): number {
    return this.size / this.N;
  }

  /** `(h, ∂h/∂x, ∂h/∂z, foam)`, most recent step. */
  get texture(): THREE.Texture {
    return this.target.textures[1]!;
  }

  get target(): THREE.WebGLRenderTarget {
    return this.pingPong[this.current]!;
  }

  reset(): void {
    this.needsClear = true;
  }

  /** `w`×`h` texels of the view attachment from (x, y): `w*h*4` floats. */
  readBlock(renderer: THREE.WebGLRenderer, x: number, y: number, w: number, h: number): Float32Array {
    const prev = renderer.getRenderTarget();
    const out = readTargetBlock(renderer, this.target, x, y, w, h, 1);
    renderer.setRenderTarget(prev);
    return out;
  }

  render(renderer: THREE.WebGLRenderer, inputs: WakeInputs): void {
    const prevTarget = renderer.getRenderTarget();
    if (this.needsClear) {
      for (const t of this.pingPong) {
        renderer.setRenderTarget(t);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
      }
      this.needsClear = false;
    }
    const u = this.pass.uniforms;
    (u.uHull!.value as THREE.Vector2).set(inputs.hull[0], inputs.hull[1]);
    (u.uHullFwd!.value as THREE.Vector2).set(inputs.forward[0], inputs.forward[1]);
    (u.uHullHalf!.value as THREE.Vector2).set(inputs.halfSize[0], inputs.halfSize[1]);
    u.uSpeedFactor!.value = inputs.speedFactor;

    // The anchor shift applies once; extra sub-steps see a zero shift.
    const dt = Math.min(inputs.dt, 0.1);
    const steps = Math.max(1, Math.ceil(dt / this.maxStep));
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      const prev = this.pingPong[this.current]!;
      const next = this.pingPong[this.current ^ 1]!;
      u.uPrev!.value = prev.textures[0]!;
      u.uDt!.value = sub;
      if (i === 0) (u.uShift!.value as THREE.Vector2).set(inputs.shift[0], inputs.shift[1]);
      else (u.uShift!.value as THREE.Vector2).set(0, 0);
      this.pass.render(renderer, next);
      this.current ^= 1;
    }
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.pass.dispose();
    this.pingPong[0].dispose();
    this.pingPong[1].dispose();
  }
}
