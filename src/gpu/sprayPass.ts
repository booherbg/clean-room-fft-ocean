/**
 * Spray pass (spec §1.14): a pool of `width × height` particle slots stepped
 * on the GPU, ping-ponged between two MRT float targets. Attachment 0 is
 * `(x, y, z, age)`, attachment 1 `(vx, vy, vz, life)` with life < 0 marking
 * a bow droplet; a slot is free when life == 0 or age ≥ |life|. The rules
 * mirror `app/spray/sprayField.ts`; the `Points` renderer reads the state
 * textures by vertex id.
 */
import * as THREE from "three";
import frag from "./spray.frag.glsl?raw";
import { FullscreenPass } from "./passes/FullscreenPass";
import { readTargetBlock } from "./readback";
import { makeFloatTarget } from "./targets";

export interface SprayCascadeInput {
  displacement: THREE.Texture;
  foam: THREE.Texture;
  jacobian: THREE.Texture;
  size: number;
}

export interface SprayInputs {
  dt: number;
  /** Cascades 0 and 1 (1 may be absent on the one-cascade tier). */
  cascade0: SprayCascadeInput;
  cascade1: SprayCascadeInput | null;
  gravity: number;
  dragRate: number;
  /** Unit vector the wind blows towards (x, z), its speed, and the carried fraction. */
  windDir: [number, number];
  windSpeed: number;
  windCarry: number;
  foamThreshold: number;
  /** The foam pass's J threshold (`params.foam.threshold`): fresh breaking below it. */
  jacThreshold: number;
  /** crestGain · density · dt (probability per unit excess foam energy). */
  crestP: number;
  crestLife: number;
  /** Spawn disc centre (world xz) and radius (m). */
  centre: [number, number];
  radius: number;
  /** Bow spray, or null when not emitting. */
  bow: { p: number; a: [number, number, number]; b: [number, number, number]; forward: [number, number]; speed: number; life: number } | null;
}

export interface SprayCounts {
  alive: number;
  crest: number;
  bow: number;
}

export class SprayPass {
  private readonly pingPong: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private current = 0;
  private readonly pass: FullscreenPass;
  private needsClear = true;
  private frame = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const make = (): THREE.WebGLRenderTarget => {
      const t = makeFloatTarget(width, 2, { height });
      for (const tex of t.textures) {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
      }
      return t;
    };
    this.pingPong = [make(), make()];
    this.pass = new FullscreenPass(frag, {
      uPrevA: { value: null },
      uPrevB: { value: null },
      uDisp0: { value: null },
      uFoam0: { value: null },
      uDisp1: { value: null },
      uFoam1: { value: null },
      uJac0: { value: null },
      uJac1: { value: null },
      uSizes: { value: new THREE.Vector2(1, 1) },
      uHasCascade1: { value: 0 },
      uDt: { value: 0 },
      uFrame: { value: 0 },
      uGravity: { value: 9.81 },
      uDragRate: { value: 0.8 },
      uWindVel: { value: new THREE.Vector3() },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindSpeed: { value: 0 },
      uWindCarry: { value: 0.55 },
      uFoamThreshold: { value: 0.9 },
      uJacThreshold: { value: 0.8 },
      uCrestP: { value: 0 },
      uCrestLife: { value: 1.5 },
      uCentre: { value: new THREE.Vector2() },
      uRadius: { value: 100 },
      uBowP: { value: 0 },
      uBowA: { value: new THREE.Vector3() },
      uBowB: { value: new THREE.Vector3() },
      uBowForward: { value: new THREE.Vector2(0, -1) },
      uBowSpeed: { value: 0 },
      uBowLife: { value: 1.2 },
    });
  }

  /** Number of particle slots. */
  get slots(): number {
    return this.width * this.height;
  }

  /** (x, y, z, age) of every slot, most recent step. */
  get positions(): THREE.Texture {
    return this.pingPong[this.current]!.textures[0]!;
  }

  /** (vx, vy, vz, life) of every slot, most recent step. */
  get velocities(): THREE.Texture {
    return this.pingPong[this.current]!.textures[1]!;
  }

  /** Kill every particle (next step starts from an empty pool). */
  reset(): void {
    this.needsClear = true;
  }

  render(renderer: THREE.WebGLRenderer, inputs: SprayInputs): void {
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
    u.uPrevA!.value = prev.textures[0];
    u.uPrevB!.value = prev.textures[1];
    u.uDisp0!.value = inputs.cascade0.displacement;
    u.uFoam0!.value = inputs.cascade0.foam;
    const c1 = inputs.cascade1;
    u.uDisp1!.value = c1 ? c1.displacement : inputs.cascade0.displacement;
    u.uFoam1!.value = c1 ? c1.foam : inputs.cascade0.foam;
    u.uJac0!.value = inputs.cascade0.jacobian;
    u.uJac1!.value = c1 ? c1.jacobian : inputs.cascade0.jacobian;
    (u.uSizes!.value as THREE.Vector2).set(inputs.cascade0.size, c1 ? c1.size : 1);
    u.uHasCascade1!.value = c1 ? 1 : 0;
    u.uDt!.value = inputs.dt;
    u.uFrame!.value = this.frame = (this.frame + 1) >>> 0;
    u.uGravity!.value = inputs.gravity;
    u.uDragRate!.value = inputs.dragRate;
    const carry = inputs.windSpeed * inputs.windCarry;
    (u.uWindVel!.value as THREE.Vector3).set(inputs.windDir[0] * carry, 0, inputs.windDir[1] * carry);
    (u.uWindDir!.value as THREE.Vector2).set(inputs.windDir[0], inputs.windDir[1]);
    u.uWindSpeed!.value = inputs.windSpeed;
    u.uWindCarry!.value = inputs.windCarry;
    u.uFoamThreshold!.value = inputs.foamThreshold;
    u.uJacThreshold!.value = inputs.jacThreshold;
    u.uCrestP!.value = inputs.crestP;
    u.uCrestLife!.value = inputs.crestLife;
    (u.uCentre!.value as THREE.Vector2).set(inputs.centre[0], inputs.centre[1]);
    u.uRadius!.value = inputs.radius;
    const bow = inputs.bow;
    u.uBowP!.value = bow ? bow.p : 0;
    if (bow) {
      (u.uBowA!.value as THREE.Vector3).set(bow.a[0], bow.a[1], bow.a[2]);
      (u.uBowB!.value as THREE.Vector3).set(bow.b[0], bow.b[1], bow.b[2]);
      (u.uBowForward!.value as THREE.Vector2).set(bow.forward[0], bow.forward[1]);
      u.uBowSpeed!.value = bow.speed;
      u.uBowLife!.value = bow.life;
    }
    this.pass.render(renderer, next);
    this.current ^= 1;
  }

  /**
   * Synchronous readback of the whole pool: live / crest / bow counts.
   * For tests and the HUD; ~260 KB of floats, so not every frame.
   */
  count(renderer: THREE.WebGLRenderer): SprayCounts {
    const prev = renderer.getRenderTarget();
    const target = this.pingPong[this.current]!;
    const a = readTargetBlock(renderer, target, 0, 0, this.width, this.height, 0);
    const b = readTargetBlock(renderer, target, 0, 0, this.width, this.height, 1);
    renderer.setRenderTarget(prev);
    let crest = 0;
    let bow = 0;
    for (let i = 0; i < this.slots; i++) {
      const life = b[i * 4 + 3]!;
      const age = a[i * 4 + 3]!;
      if (life === 0 || age >= Math.abs(life)) continue;
      if (life < 0) bow++;
      else crest++;
    }
    return { alive: crest + bow, crest, bow };
  }

  dispose(): void {
    this.pass.dispose();
    this.pingPong[0].dispose();
    this.pingPong[1].dispose();
  }
}
