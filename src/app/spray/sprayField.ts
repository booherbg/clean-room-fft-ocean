/**
 * Spray emitter rules (spec §1.14), pure TypeScript. The GPU update pass
 * (`gpu/spray.frag.glsl`) implements exactly these rules per particle slot;
 * this module is the CPU reference the tests run and the source of the
 * numbers `SpraySystem` hands the shader (spawn probabilities, bow points,
 * bow rate). No three.js.
 *
 * Two emitters:
 *  - breaking crests: a slot that is free picks a random point around the
 *    camera and spawns where the foam energy there exceeds a threshold, with
 *    probability ∝ (energy − threshold) · density · dt;
 *  - bow spray: while the ship moves faster than `BOW_MIN_SPEED` the two
 *    hull sample points nearest the bow emit at a rate ∝ speed² · density,
 *    thrown outward and up.
 * A particle then falls under gravity, is dragged toward the wind, fades
 * over its life and dies when it drops below the water.
 */
import type { Vec3 } from "../../core/rigidbody";

export interface SprayTuning {
  gravity: number;
  /** Mean lifetime of a crest droplet, s. */
  crestLife: number;
  /** Mean lifetime of a bow droplet, s. */
  bowLife: number;
  /** Rate (1/s) a droplet's velocity relaxes toward the wind. */
  dragRate: number;
  /** Foam energy a crest needs before it throws spray. */
  foamThreshold: number;
  /** Crest spawn probability per slot per second per unit excess energy. */
  crestGain: number;
  /** Bow spray, particles per second at 1 m/s (scaled by speed²). */
  bowGain: number;
  /** Below this speed (m/s) the bow throws nothing. */
  bowMinSpeed: number;
  /** Fraction of the wind speed the air near the crests carries. */
  windCarry: number;
}

export const SPRAY_TUNING: SprayTuning = {
  gravity: 9.81,
  crestLife: 1.5,
  bowLife: 1.4,
  dragRate: 0.8,
  foamThreshold: 0.35,
  crestGain: 100,
  bowGain: 200,
  bowMinSpeed: 2,
  windCarry: 0.55,
};

/**
 * Probability that a free slot spawns a crest droplet this step at a point
 * whose foam energy is `energy`: linear in the excess energy, in density and
 * in dt, so the expected spawn count is proportional to the foam energy
 * above the threshold.
 */
export function crestSpawnProbability(energy: number, density: number, dt: number, t = SPRAY_TUNING): number {
  const excess = Math.max(0, energy - t.foamThreshold);
  return Math.min(1, excess * t.crestGain * density * dt);
}

/** Bow spray emission, particles per second, for a hull moving at `speed` m/s. */
export function bowRate(speed: number, density: number, t = SPRAY_TUNING): number {
  const s = Math.abs(speed);
  if (s <= t.bowMinSpeed) return 0;
  return t.bowGain * s * s * density;
}

/**
 * Per-slot spawn probability that yields `rate` particles per second from a
 * pool of `slots` (assumes most slots are free, which holds for bow spray).
 */
export function bowSlotProbability(rate: number, dt: number, slots: number): number {
  return slots > 0 ? Math.min(1, (rate * dt) / slots) : 0;
}

export interface BowPoint {
  world: Vec3;
  /** Water height at the point this step (the sample's `waterY`), if known. */
  waterY: number | undefined;
  /** −1 port, +1 starboard. */
  side: -1 | 1;
}

interface SampleLike {
  local: Vec3;
  world: Vec3;
  waterY?: number;
}

/**
 * The two side samples of the foremost station (smallest body z): where the
 * bow wave leaves the hull. Returns [] if no side samples exist.
 */
export function bowPoints(samples: readonly SampleLike[]): BowPoint[] {
  const sides = samples.filter((s) => s.local.x !== 0);
  if (sides.length === 0) return [];
  const zMin = Math.min(...sides.map((s) => s.local.z));
  return sides
    .filter((s) => Math.abs(s.local.z - zMin) < 1e-6)
    .map((s) => ({ world: s.world, waterY: s.waterY, side: (s.local.x < 0 ? -1 : 1) as -1 | 1 }));
}

/** Initial velocity of a crest droplet: carried by the wind, thrown up, jittered. */
export function crestVelocity(
  windDir: [number, number],
  windSpeed: number,
  rnd: [number, number, number],
  t = SPRAY_TUNING,
): Vec3 {
  const carry = windSpeed * t.windCarry;
  const jitter = 0.35 * carry + 1.0;
  return {
    x: windDir[0] * carry + (rnd[0] - 0.5) * 2 * jitter,
    y: 1.5 + 0.18 * windSpeed + rnd[1] * (1.0 + 0.12 * windSpeed),
    z: windDir[1] * carry + (rnd[2] - 0.5) * 2 * jitter,
  };
}

/**
 * Initial velocity of a bow droplet: outward on its side of the hull, a
 * little forward, up in proportion to speed, in a cone.
 */
export function bowVelocity(
  forward: [number, number],
  side: -1 | 1,
  speed: number,
  rnd: [number, number, number],
): Vec3 {
  const s = Math.abs(speed);
  // Right-hand perpendicular of forward in the xz plane (starboard).
  const rx = -forward[1];
  const rz = forward[0];
  const out = (0.5 + 0.6 * rnd[0]) * s * side;
  const fwd = (0.2 + 0.3 * rnd[2]) * s;
  return {
    x: rx * out + forward[0] * fwd,
    y: 1.5 + 0.6 * s * (0.6 + 0.8 * rnd[1]),
    z: rz * out + forward[1] * fwd,
  };
}

/**
 * One integration step: gravity, relaxation toward the wind, position update.
 * Semi-implicit Euler, matching the shader.
 */
export function integrate(p: Vec3, v: Vec3, dt: number, windVel: Vec3, t = SPRAY_TUNING): void {
  const k = Math.min(1, t.dragRate * dt);
  v.x += (windVel.x - v.x) * k;
  v.z += (windVel.z - v.z) * k;
  v.y -= t.gravity * dt;
  p.x += v.x * dt;
  p.y += v.y * dt;
  p.z += v.z * dt;
}

/** Opacity of a droplet at `age` of a `life`: quick in, linear out. */
export function fade(age: number, life: number): number {
  if (life <= 0 || age < 0 || age >= life) return 0;
  const u = age / life;
  return Math.min(1, u * 12) * (1 - u);
}

export interface SprayParticle {
  p: Vec3;
  v: Vec3;
  age: number;
  life: number;
  bow: boolean;
}

export interface SprayStepInputs {
  dt: number;
  density: number;
  /** Foam energy at a world xz. */
  foamAt: (x: number, z: number) => number;
  /** Water height at a world xz. */
  heightAt: (x: number, z: number) => number;
  /** Candidate spawn point for a free slot (around the camera). */
  pickPoint: () => [number, number];
  windDir: [number, number];
  windSpeed: number;
  /** Bow spray source, or null when not in boat mode / too slow. */
  bow: { points: BowPoint[]; forward: [number, number]; speed: number } | null;
  rng: () => number;
}

/**
 * CPU reference of the particle pool: `slots` fixed slots stepped with the
 * same rules as the GPU pass. Used by the tests; the app runs the shader.
 */
export class SprayField {
  readonly particles: SprayParticle[] = [];

  constructor(
    readonly slots: number,
    private readonly tuning: SprayTuning = SPRAY_TUNING,
  ) {
    for (let i = 0; i < slots; i++) {
      this.particles.push({ p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, age: 0, life: 0, bow: false });
    }
  }

  get alive(): number {
    return this.particles.filter((q) => q.life > 0).length;
  }

  get bowAlive(): number {
    return this.particles.filter((q) => q.life > 0 && q.bow).length;
  }

  step(inp: SprayStepInputs): void {
    const t = this.tuning;
    const { dt, rng } = inp;
    const windVel = { x: inp.windDir[0] * inp.windSpeed * t.windCarry, y: 0, z: inp.windDir[1] * inp.windSpeed * t.windCarry };
    const bow = inp.bow && inp.bow.points.length > 0 ? inp.bow : null;
    const pBow = bow ? bowSlotProbability(bowRate(bow.speed, inp.density, t), dt, this.slots) : 0;
    for (const q of this.particles) {
      if (q.life > 0) {
        integrate(q.p, q.v, dt, windVel, t);
        q.age += dt;
        if (q.age >= q.life || q.p.y < inp.heightAt(q.p.x, q.p.z) - 0.3) q.life = 0;
        continue;
      }
      if (bow && rng() < pBow) {
        const bp = bow.points[Math.floor(rng() * bow.points.length)]!;
        q.p = { x: bp.world.x, y: (bp.waterY ?? bp.world.y) + 0.3, z: bp.world.z };
        q.v = bowVelocity(bow.forward, bp.side, bow.speed, [rng(), rng(), rng()]);
        q.age = 0;
        q.life = t.bowLife * (0.6 + 0.8 * rng());
        q.bow = true;
        continue;
      }
      const [x, z] = inp.pickPoint();
      const e = inp.foamAt(x, z);
      if (rng() < crestSpawnProbability(e, inp.density, dt, t)) {
        q.p = { x, y: inp.heightAt(x, z) + 0.2, z };
        q.v = crestVelocity(inp.windDir, inp.windSpeed, [rng(), rng(), rng()], t);
        q.age = 0;
        q.life = t.crestLife * (0.6 + 0.8 * rng());
        q.bow = false;
      }
    }
  }
}
