import { describe, expect, it } from "vitest";
import {
  RAIN_TUNING,
  RainDropletPool,
  rainVelocity,
  ringAmplitude,
  ringRadius,
  snapToCell,
  spawnBudget,
  streakCount,
  streakHalfLength,
  streakPosition,
  wrap,
} from "../src/core/rainField";

describe("wrap", () => {
  it("is a positive modulo", () => {
    expect(wrap(5, 4)).toBe(1);
    expect(wrap(-1, 4)).toBe(3);
    expect(wrap(-9, 4)).toBe(3);
    expect(wrap(0, 4)).toBe(0);
    expect(wrap(4, 4)).toBe(0);
  });
});

describe("rainVelocity", () => {
  it("falls at the tuned speed with no wind, jitter centred", () => {
    const v = rainVelocity([1, 0], 0, 0.5);
    expect(v[0]).toBe(0);
    expect(v[2]).toBe(0);
    expect(v[1]).toBeCloseTo(-RAIN_TUNING.fallSpeed, 10);
  });
  it("drifts with the wind by the carry fraction", () => {
    const v = rainVelocity([0, 1], 10, 0.5);
    expect(v[0]).toBeCloseTo(0, 10);
    expect(v[2]).toBeCloseTo(10 * RAIN_TUNING.windCarry, 10);
    expect(v[1]).toBeLessThan(0);
  });
  it("jitter spans ±fallJitter of the fall speed", () => {
    const slow = rainVelocity([1, 0], 0, 0)[1];
    const fast = rainVelocity([1, 0], 0, 1)[1];
    expect(-slow).toBeCloseTo(RAIN_TUNING.fallSpeed * (1 - RAIN_TUNING.fallJitter), 10);
    expect(-fast).toBeCloseTo(RAIN_TUNING.fallSpeed * (1 + RAIN_TUNING.fallJitter), 10);
  });
});

describe("streakPosition", () => {
  const seed: [number, number, number] = [0.25, 0.8, 0.5];
  const vel: [number, number, number] = [1.5, -11, 0.5];

  it("stays inside the box for any time and box origin", () => {
    for (const t of [0, 0.7, 13.9, 1234.5]) {
      for (const min of [
        [-30, 0, -30],
        [512.3, 40, -1000.7],
      ] as [number, number, number][]) {
        const p = streakPosition(seed, vel, t, min);
        for (let a = 0; a < 3; a++) {
          expect(p[a]).toBeGreaterThanOrEqual(min[a] as number);
          expect(p[a]).toBeLessThan((min[a] as number) + (RAIN_TUNING.volume[a] as number));
        }
      }
    }
  });

  it("holds its world position while the camera moves (until it wraps)", () => {
    // A drop well inside the box: shifting the box by less than the drop's
    // distance to the walls must not move the drop.
    const t = 2.0;
    const a = streakPosition(seed, vel, t, [-30, -21, -30]);
    const b = streakPosition(seed, vel, t, [-30 + 3, -21 - 2, -30 + 1]);
    const inset = (p: [number, number, number], min: [number, number, number]): number => {
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const lo = (p[i] as number) - (min[i] as number);
        const hi = (min[i] as number) + (RAIN_TUNING.volume[i] as number) - (p[i] as number);
        m = Math.min(m, lo, hi);
      }
      return m;
    };
    if (inset(a, [-30, -21, -30]) > 4) {
      expect(b[0]).toBeCloseTo(a[0], 6);
      expect(b[1]).toBeCloseTo(a[1], 6);
      expect(b[2]).toBeCloseTo(a[2], 6);
    }
  });

  it("moves along the velocity between nearby times (modulo wrap)", () => {
    const t = 5.0;
    const dt = 0.01;
    const p0 = streakPosition(seed, vel, t, [0, 0, 0]);
    const p1 = streakPosition(seed, vel, t + dt, [0, 0, 0]);
    // Either the exact step, or a wrap by one extent on some axis.
    for (let a = 0; a < 3; a++) {
      const d = (p1[a] as number) - (p0[a] as number) - (vel[a] as number) * dt;
      const e = RAIN_TUNING.volume[a] as number;
      expect(Math.min(Math.abs(d), Math.abs(d + e), Math.abs(d - e))).toBeLessThan(1e-6);
    }
  });
});

describe("streakHalfLength / streakCount", () => {
  it("half-length is half the exposure travel", () => {
    expect(streakHalfLength([0, -10, 0])).toBeCloseTo(0.5 * 10 * RAIN_TUNING.streakSeconds, 10);
  });
  it("count is 0 at rain 0, full at rain 1, sub-linear between", () => {
    expect(streakCount(16384, 0)).toBe(0);
    expect(streakCount(16384, 1)).toBe(16384);
    const half = streakCount(16384, 0.5);
    expect(half).toBeGreaterThan(16384 / 2);
    expect(half).toBeLessThan(16384);
    expect(streakCount(16384, 2)).toBe(16384); // clamped
  });
});

describe("ring kinematics", () => {
  it("radius grows linearly from r0 at ringSpeed", () => {
    const life = RAIN_TUNING.life;
    expect(ringRadius(0, life)).toBeCloseTo(RAIN_TUNING.r0, 10);
    const d = ringRadius(0.6, life) - ringRadius(0.1, life);
    expect(d).toBeCloseTo(RAIN_TUNING.ringSpeed * 0.5 * life, 10);
  });
  it("amplitude is 0 at birth and death, positive between, and fades as the ring spreads", () => {
    const life = RAIN_TUNING.life;
    expect(ringAmplitude(0, life)).toBe(0);
    expect(ringAmplitude(1, life)).toBe(0);
    expect(ringAmplitude(0.2, life)).toBeGreaterThan(0);
    expect(ringAmplitude(0.8, life)).toBeLessThan(ringAmplitude(0.2, life));
  });
});

describe("spawnBudget", () => {
  it("carries fractions so the long-run count is exact", () => {
    let carry = 0;
    let total = 0;
    const rate = 37.3;
    const dt = 1 / 61;
    const steps = 6100;
    for (let i = 0; i < steps; i++) {
      const b = spawnBudget(carry, rate, dt);
      carry = b.carry;
      total += b.spawn;
    }
    expect(total + carry).toBeCloseTo(rate * dt * steps, 6);
    expect(carry).toBeGreaterThanOrEqual(0);
    expect(carry).toBeLessThan(1);
  });
});

describe("snapToCell", () => {
  it("snaps down to the grid", () => {
    expect(snapToCell(10.7, 0.5)).toBeCloseTo(10.5, 10);
    expect(snapToCell(-10.7, 0.5)).toBeCloseTo(-11, 10);
  });
});

describe("RainDropletPool", () => {
  it("spawns at the tuned rate and ripples die after their life", () => {
    const pool = new RainDropletPool(1024, 7);
    const dt = 1 / 60;
    let t = 0;
    for (let i = 0; i < 60; i++) {
      pool.step(t, dt, 1, 0, 0);
      t += dt;
    }
    // One second at rain 1: rateMax drops spawned; those older than their
    // life are gone. Expected live ≈ rate·mean(life), well under capacity.
    const live = pool.countAt(t);
    expect(live).toBeGreaterThan(300);
    expect(live).toBeLessThanOrEqual(1024);
    // All collected ripples are inside the field square and in [0,1) age.
    for (const r of pool.collect(t)) {
      expect(Math.abs(r.x)).toBeLessThanOrEqual(RAIN_TUNING.fieldSize / 2);
      expect(Math.abs(r.z)).toBeLessThanOrEqual(RAIN_TUNING.fieldSize / 2);
      expect(r.age01).toBeGreaterThanOrEqual(0);
      expect(r.age01).toBeLessThan(1);
    }
    // Rain off: nothing new; everything dead once the longest life passes.
    const idle = RAIN_TUNING.life * (1 + RAIN_TUNING.lifeJitter) + 0.05;
    for (let i = 0; i < Math.ceil(idle / dt); i++) {
      pool.step(t, dt, 0, 0, 0);
      t += dt;
    }
    expect(pool.countAt(t)).toBe(0);
  });

  it("is deterministic for a seed and never exceeds capacity", () => {
    const a = new RainDropletPool(64, 42);
    const b = new RainDropletPool(64, 42);
    let t = 0;
    for (let i = 0; i < 120; i++) {
      a.step(t, 1 / 60, 0.8, 5, -3);
      b.step(t, 1 / 60, 0.8, 5, -3);
      t += 1 / 60;
    }
    expect(a.collect(t)).toEqual(b.collect(t));
    expect(a.countAt(t)).toBeLessThanOrEqual(64);
  });

  it("reset forgets everything", () => {
    const pool = new RainDropletPool(64, 1);
    pool.step(0, 0.1, 1, 0, 0);
    expect(pool.countAt(0.05)).toBeGreaterThan(0);
    pool.reset();
    expect(pool.countAt(0.05)).toBe(0);
  });
});
