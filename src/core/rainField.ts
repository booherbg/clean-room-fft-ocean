/**
 * Rain (spec §1.16), pure TypeScript — no three.js, no DOM.
 *
 * Two halves, mirroring the GPU exactly so the tests can run the same rules:
 *
 *  - **Streaks**: falling rain is a camera-locked volume of instanced quads
 *    whose positions are a *pure function of a static seed and the clock* —
 *    `streakPosition` is the CPU reference of the vertex-shader `mod()`
 *    trick (no per-frame CPU work, no state texture).
 *  - **Ripples**: drops that hit the sea live in `RainDropletPool`, a fixed
 *    ring buffer the app stamps into the rain field (`gpu/rainPass`) as
 *    expanding rings. The ring kinematics (`ringRadius`, `ringAmplitude`)
 *    are the same curves the stamp shader evaluates.
 */

import { splitmix32 } from "./random";

export interface RainTuning {
  /** Camera-locked streak volume (x, y, z), metres. */
  volume: [number, number, number];
  /** Base fall speed of a drop, m/s (terminal velocity of ~2 mm drops). */
  fallSpeed: number;
  /** Per-seed fall-speed jitter, fraction of `fallSpeed`. */
  fallJitter: number;
  /** Fraction of the wind speed the falling drops are carried by. */
  windCarry: number;
  /** Streak length as seconds of travel (an exposure time). */
  streakSeconds: number;
  /** Ripple pool size (drops being stamped at once). */
  poolCapacity: number;
  /** Drop impacts per second stamped into the field at rain = 1. */
  rateMax: number;
  /** Ripple lifetime, seconds (± `lifeJitter`). */
  life: number;
  lifeJitter: number;
  /** Ring radius at birth, m. */
  r0: number;
  /** Ring expansion speed, m/s. */
  ringSpeed: number;
  /** Gaussian ring half-width, m. */
  ringWidth: number;
  /** Side of the square rain field the ripples are stamped into, m. */
  fieldSize: number;
}

export const RAIN_TUNING: RainTuning = {
  volume: [60, 42, 60],
  // Terminal fall of a big drop is ~9 m/s, but the curtain has to read
  // near-vertical at a 17 m/s gale (the reference's Storm leans ~15°), so
  // the fall runs fast and the wind carries only a fifth of its speed.
  fallSpeed: 13,
  fallJitter: 0.25,
  windCarry: 0.18,
  streakSeconds: 0.07,
  poolCapacity: 4096,
  rateMax: 6000,
  // A drop's ring is done in half a second and never gets past ~40 cm
  // across: any slower or wider and the sea reads as a pond full of
  // pebbles instead of a surface boiling under rain. At the tuned rate
  // that is ~0.8 live rings per square metre.
  life: 0.55,
  lifeJitter: 0.35,
  r0: 0.04,
  ringSpeed: 0.55,
  ringWidth: 0.18,
  // 64 m at 512² is 12.5 cm a texel: a ring (r0 6 cm growing to ~1.3 m,
  // Gaussian half-width 30 cm) is a handful of texels wide, not one.
  fieldSize: 64,
};

// ---------------------------------------------------------------------------
// Streaks

/** Positive modulo (GLSL `mod`): result in [0, m) for m > 0. */
export function wrap(v: number, m: number): number {
  return v - Math.floor(v / m) * m;
}

/**
 * Velocity of a falling drop: gravity's terminal fall plus the wind drift.
 * `windDir` is the unit vector the wind blows towards (x, z); `jitter01`
 * scales the fall speed within ±`fallJitter` (0.5 = nominal).
 */
export function rainVelocity(
  windDir: [number, number],
  windSpeed: number,
  jitter01 = 0.5,
  t: RainTuning = RAIN_TUNING,
): [number, number, number] {
  const fall = t.fallSpeed * (1 + t.fallJitter * (jitter01 * 2 - 1));
  const carry = windSpeed * t.windCarry;
  return [windDir[0] * carry, -fall, windDir[1] * carry];
}

/**
 * World position of streak `seed` (∈ [0,1)³) at time `tSec` inside the
 * volume whose minimum corner is `boxMin` (the camera minus half the
 * volume): the drop travels along `vel` forever and re-enters the box on
 * the opposite face when it leaves (per-axis wrap). Because the wrap is in
 * *world* space the drops hold their world positions while the camera (and
 * so the box) moves — the CPU reference of the vertex shader.
 */
export function streakPosition(
  seed: [number, number, number],
  vel: [number, number, number],
  tSec: number,
  boxMin: [number, number, number],
  t: RainTuning = RAIN_TUNING,
): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const extent = t.volume[a] as number;
    out[a] = wrap((seed[a] as number) * extent + (vel[a] as number) * tSec - (boxMin[a] as number), extent) + (boxMin[a] as number);
  }
  return out;
}

/** Streak half-length in metres: half the distance travelled in the exposure. */
export function streakHalfLength(vel: [number, number, number], t: RainTuning = RAIN_TUNING): number {
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  return 0.5 * speed * t.streakSeconds;
}

/** Instances drawn from a pool of `capacity` at rain intensity `rain` ∈ [0,1]. */
export function streakCount(capacity: number, rain: number): number {
  const r = Math.min(1, Math.max(0, rain));
  if (r <= 0) return 0;
  // Sub-linear: half the slider is well over half the drops, as rain looks.
  return Math.max(1, Math.round(capacity * Math.sqrt(r)));
}

// ---------------------------------------------------------------------------
// Ripples

/** Ring radius (m) at `age01` ∈ [0,1] of a ripple's life. */
export function ringRadius(age01: number, life: number, t: RainTuning = RAIN_TUNING): number {
  return t.r0 + t.ringSpeed * age01 * life;
}

/**
 * Ring slope amplitude at `age01`: a quick rise (the drop lands), then a
 * fade to zero as the ring spreads its energy over its circumference.
 */
export function ringAmplitude(age01: number, life: number, t: RainTuning = RAIN_TUNING): number {
  if (age01 <= 0 || age01 >= 1) return 0;
  const attack = Math.min(1, age01 / 0.08);
  const spread = t.r0 / ringRadius(age01, life, t);
  return attack * (1 - age01) * Math.sqrt(spread);
}

/**
 * Drops to spawn this step at `rate` per second: the fractional part is
 * carried so the long-run average is exact at any frame rate.
 */
export function spawnBudget(carry: number, rate: number, dt: number): { spawn: number; carry: number } {
  const want = carry + rate * dt;
  const spawn = Math.floor(want);
  return { spawn, carry: want - spawn };
}

/** Snap `v` to the grid of `cell` metres (keeps the field texel-stable). */
export function snapToCell(v: number, cell: number): number {
  return Math.floor(v / cell) * cell;
}

/** One live ripple, produced by `RainDropletPool.collect`. */
export interface RippleInstance {
  x: number;
  z: number;
  /** Age as a fraction of this drop's life, [0,1). */
  age01: number;
  /** This drop's life, seconds (the ring radius needs real time). */
  life: number;
}

/**
 * Fixed-size ring buffer of drop impacts. `step` spawns `rate(intensity)`
 * drops per second uniformly over the field square around the camera,
 * overwriting the oldest slots; a slot is live while its age is under its
 * life. Deterministic for a given seed and call sequence.
 */
export class RainDropletPool {
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly born: Float32Array;
  private readonly life: Float32Array;
  private head = 0;
  private carry = 0;
  private readonly rng: () => number;

  constructor(
    readonly capacity: number = RAIN_TUNING.poolCapacity,
    rngSeed = 20260912,
    private readonly tuning: RainTuning = RAIN_TUNING,
  ) {
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.born = new Float32Array(capacity).fill(-1e9);
    this.life = new Float32Array(capacity).fill(1);
    this.rng = splitmix32(rngSeed);
  }

  /** Forget every ripple (preset change, teleport). */
  reset(): void {
    this.born.fill(-1e9);
    this.head = 0;
    this.carry = 0;
  }

  /**
   * Advance to clock `t` (s): spawn `intensity`·`rateMax` drops/s in the
   * square of side `fieldSize` centred on (cx, cz). Call once per frame.
   */
  step(t: number, dt: number, intensity: number, cx: number, cz: number): void {
    const tun = this.tuning;
    const rate = Math.min(1, Math.max(0, intensity)) * tun.rateMax;
    const b = spawnBudget(this.carry, rate, Math.max(0, dt));
    this.carry = b.carry;
    const half = tun.fieldSize / 2;
    for (let i = 0; i < b.spawn; i++) {
      const s = this.head;
      this.head = (this.head + 1) % this.capacity;
      this.x[s] = cx + (this.rng() * 2 - 1) * half;
      this.z[s] = cz + (this.rng() * 2 - 1) * half;
      this.born[s] = t;
      this.life[s] = tun.life * (1 + tun.lifeJitter * (this.rng() * 2 - 1));
    }
  }

  /** Live ripples at clock `t`, oldest first. */
  collect(t: number): RippleInstance[] {
    const out: RippleInstance[] = [];
    for (let s = 0; s < this.capacity; s++) {
      const age = t - (this.born[s] as number);
      const life = this.life[s] as number;
      if (age < 0 || age >= life) continue;
      out.push({ x: this.x[s] as number, z: this.z[s] as number, age01: age / life, life });
    }
    return out;
  }

  /**
   * Write the live ripples at clock `t` into `out` as (x, z, age01, life)
   * quads — the GPU stamp's instance buffer — and return the count. No
   * allocation; `out` must hold `capacity * 4` floats.
   */
  fillAttributes(t: number, out: Float32Array): number {
    let n = 0;
    for (let s = 0; s < this.capacity; s++) {
      const age = t - (this.born[s] as number);
      const life = this.life[s] as number;
      if (age < 0 || age >= life) continue;
      out[n * 4] = this.x[s] as number;
      out[n * 4 + 1] = this.z[s] as number;
      out[n * 4 + 2] = age / life;
      out[n * 4 + 3] = life;
      n++;
    }
    return n;
  }

  /** Live count at clock `t` (no allocation). */
  countAt(t: number): number {
    let n = 0;
    for (let s = 0; s < this.capacity; s++) {
      const age = t - (this.born[s] as number);
      if (age >= 0 && age < (this.life[s] as number)) n++;
    }
    return n;
  }
}
