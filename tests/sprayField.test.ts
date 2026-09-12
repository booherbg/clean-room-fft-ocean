import { describe, expect, it } from "vitest";
import { splitmix32 } from "../src/core/random";
import { HullPhysics } from "../src/app/ship/hullPhysics";
import {
  SPRAY_TUNING,
  SprayField,
  bowPoints,
  bowRate,
  bowVelocity,
  crestSpawnProbability,
  crestVelocity,
  fade,
  integrate,
  type SprayStepInputs,
} from "../src/app/spray/sprayField";

function inputs(over: Partial<SprayStepInputs>, seed = 1): SprayStepInputs {
  const rng = splitmix32(seed);
  return {
    dt: 1 / 60,
    density: 1,
    foamAt: () => 0,
    heightAt: () => 0,
    pickPoint: () => [rng() * 100, rng() * 100],
    windDir: [1, 0],
    windSpeed: 17,
    bow: null,
    rng,
    ...over,
  };
}

describe("crest spawning", () => {
  it("spawns nothing below the foam threshold", () => {
    expect(crestSpawnProbability(SPRAY_TUNING.foamThreshold, 1, 1 / 60)).toBe(0);
    const f = new SprayField(2000);
    f.step(inputs({ foamAt: () => SPRAY_TUNING.foamThreshold * 0.5 }));
    expect(f.alive).toBe(0);
  });

  it("spawn count is proportional to the foam energy above the threshold", () => {
    const thr = SPRAY_TUNING.foamThreshold;
    const count = (e: number): number => {
      const f = new SprayField(20000);
      f.step(inputs({ foamAt: () => e }, 7));
      return f.alive;
    };
    // Excesses small enough that the per-step probability stays well below 1.
    const one = count(thr + 0.1);
    const two = count(thr + 0.2);
    expect(one).toBeGreaterThan(50);
    expect(two / one).toBeGreaterThan(1.7);
    expect(two / one).toBeLessThan(2.3);
  });

  it("spawn count scales with density and dt", () => {
    const e = SPRAY_TUNING.foamThreshold + 0.5;
    expect(crestSpawnProbability(e, 2, 0.01)).toBeCloseTo(2 * crestSpawnProbability(e, 1, 0.01));
    expect(crestSpawnProbability(e, 1, 0.02)).toBeCloseTo(2 * crestSpawnProbability(e, 1, 0.01));
    expect(crestSpawnProbability(100, 1, 1)).toBe(1);
  });

  it("crest droplets go up and downwind", () => {
    const v = crestVelocity([0, 1], 17, [0.5, 0.5, 0.5]);
    expect(v.y).toBeGreaterThan(1);
    expect(v.z).toBeGreaterThan(5);
    expect(Math.abs(v.x)).toBeLessThan(1e-9);
  });
});

describe("lifetime and integration", () => {
  it("a droplet ages out after its life and never lives past 1.4 × crestLife", () => {
    const f = new SprayField(500);
    const inp = inputs({ foamAt: () => 3 }, 3);
    f.step(inp);
    const born = f.alive;
    expect(born).toBeGreaterThan(0);
    const lives = f.particles.filter((q) => q.life > 0).map((q) => q.life);
    for (const l of lives) {
      expect(l).toBeGreaterThanOrEqual(0.6 * SPRAY_TUNING.crestLife - 1e-9);
      expect(l).toBeLessThanOrEqual(1.4 * SPRAY_TUNING.crestLife + 1e-9);
    }
    // Deep water so nothing dies by falling in: only age kills.
    const quiet = inputs({ foamAt: () => 0, heightAt: () => -1e6 }, 4);
    for (let t = 0; t < 1.4 * SPRAY_TUNING.crestLife + 0.1; t += 1 / 60) f.step(quiet);
    expect(f.alive).toBe(0);
  });

  it("gravity: a still droplet falls ½gt² and dies when it hits the water", () => {
    const p = { x: 0, y: 10, z: 0 };
    const v = { x: 0, y: 0, z: 0 };
    const dt = 1 / 240;
    for (let i = 0; i < 240; i++) integrate(p, v, dt, { x: 0, y: 0, z: 0 });
    expect(p.y).toBeCloseTo(10 - 0.5 * 9.81, 1);
    expect(v.y).toBeCloseTo(-9.81, 3);

    const f = new SprayField(1);
    const q = f.particles[0]!;
    q.p = { x: 0, y: 0.5, z: 0 };
    q.v = { x: 0, y: 0, z: 0 };
    q.life = 10;
    for (let t = 0; t < 1; t += 1 / 60) f.step(inputs({ windSpeed: 0 }));
    expect(f.alive).toBe(0);
  });

  it("drag pulls the horizontal velocity toward the wind", () => {
    const p = { x: 0, y: 100, z: 0 };
    const v = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 600; i++) integrate(p, v, 1 / 60, { x: 5, y: 0, z: 0 });
    expect(v.x).toBeCloseTo(5, 2);
  });

  it("fade is 0 before birth and after death, and positive in between", () => {
    expect(fade(-0.1, 1)).toBe(0);
    expect(fade(1, 1)).toBe(0);
    expect(fade(0.5, 1)).toBeGreaterThan(0.4);
    expect(fade(0.9, 1)).toBeLessThan(fade(0.5, 1));
  });
});

describe("bow spray", () => {
  it("emits nothing at or below 2 m/s and ∝ speed² above", () => {
    expect(bowRate(0, 1)).toBe(0);
    expect(bowRate(2, 1)).toBe(0);
    expect(bowRate(6, 1) / bowRate(3, 1)).toBeCloseTo(4);
    expect(bowRate(-6, 1)).toBe(bowRate(6, 1));
    expect(bowRate(6, 0.5)).toBeCloseTo(bowRate(6, 1) / 2);
  });

  it("bow points are the two side samples of the foremost station", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0, 0);
    const pts = bowPoints(h.samples);
    expect(pts).toHaveLength(2);
    expect(pts.map((p) => p.side).sort()).toEqual([-1, 1]);
    // Heading 0 = −z: the bow points are ahead (more negative z) of the body.
    for (const p of pts) expect(p.world.z).toBeLessThan(-0.3 * HullPhysics.LENGTH);
  });

  it("bow droplets are thrown outward on their side and up", () => {
    const fwd: [number, number] = [0, -1];
    const stb = bowVelocity(fwd, 1, 7, [0.5, 0.5, 0.5]);
    const prt = bowVelocity(fwd, -1, 7, [0.5, 0.5, 0.5]);
    expect(stb.x).toBeGreaterThan(1);
    expect(prt.x).toBeLessThan(-1);
    expect(stb.y).toBeGreaterThan(1);
    expect(stb.z).toBeLessThan(0); // a little forward
  });

  it("the pool spawns bow particles only while the hull is fast", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0, 0);
    const pts = bowPoints(h.samples);
    const slow = new SprayField(4000);
    slow.step(inputs({ bow: { points: pts, forward: [0, -1], speed: 1 } }));
    expect(slow.bowAlive).toBe(0);
    const fast = new SprayField(4000);
    for (let i = 0; i < 30; i++) fast.step(inputs({ bow: { points: pts, forward: [0, -1], speed: 7 } }, 9));
    expect(fast.bowAlive).toBeGreaterThan(20);
    expect(fast.alive).toBe(fast.bowAlive);
  });
});
