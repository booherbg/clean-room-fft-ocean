import { describe, expect, it } from "vitest";
import { fbm, islandHeight, ISLAND_RADIUS, sampleHeightmap, SEA_STACKS, valueNoise } from "../src/core/terrain";

const SEED = 1337;

describe("terrain noise", () => {
  it("value noise is in [0, 1] and deterministic per seed", () => {
    for (let i = 0; i < 200; i++) {
      const x = (i * 7.3) % 50;
      const z = (i * 3.1) % 50;
      const v = valueNoise(x, z, SEED);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(valueNoise(x, z, SEED)).toBe(v);
    }
    expect(valueNoise(3.3, 4.4, 1)).not.toBe(valueNoise(3.3, 4.4, 2));
  });

  it("fbm is continuous (no lattice jumps)", () => {
    let maxStep = 0;
    for (let i = 0; i < 2000; i++) {
      const a = fbm(i * 0.01, 2.5, SEED);
      const b = fbm((i + 1) * 0.01, 2.5, SEED);
      maxStep = Math.max(maxStep, Math.abs(a - b));
    }
    expect(maxStep).toBeLessThan(0.05);
  });
});

describe("islandHeight", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(islandHeight(12, -30, SEED)).toBe(islandHeight(12, -30, SEED));
    expect(islandHeight(12, -30, SEED)).not.toBe(islandHeight(12, -30, SEED + 1));
  });

  it("has a rocky peak of roughly 60 m near the centre", () => {
    let peak = -Infinity;
    for (let z = -60; z <= 60; z += 4) for (let x = -60; x <= 60; x += 4) peak = Math.max(peak, islandHeight(x, z, SEED));
    expect(peak).toBeGreaterThan(45);
    expect(peak).toBeLessThan(90);
  });

  it("has a beach: a gentle band around sea level about ISLAND_RADIUS out", () => {
    // Walk out along several bearings; the zero crossing should sit near the
    // nominal radius and the slope through it should be gentle (≈ 1:30).
    for (const bearing of [0, 0.7, 1.9, 3.1, 4.4, 5.6]) {
      const dx = Math.cos(bearing);
      const dz = Math.sin(bearing);
      let shore = -1;
      for (let r = 60; r < 320; r += 1) {
        if (islandHeight(dx * r, dz * r, SEED) < 0) {
          shore = r;
          break;
        }
      }
      expect(shore, `bearing ${bearing}`).toBeGreaterThan(ISLAND_RADIUS - 60);
      expect(shore, `bearing ${bearing}`).toBeLessThan(ISLAND_RADIUS + 60);
      const above = islandHeight(dx * (shore - 15), dz * (shore - 15), SEED);
      const below = islandHeight(dx * (shore + 15), dz * (shore + 15), SEED);
      expect(above, `bearing ${bearing}`).toBeGreaterThan(0);
      expect(above, `bearing ${bearing}`).toBeLessThan(4);
      expect(below, `bearing ${bearing}`).toBeLessThan(0);
      expect(below, `bearing ${bearing}`).toBeGreaterThan(-4);
    }
  });

  it("once above the shore, the land never dips back under water (no inland pools)", () => {
    // Walk rays inward: after the first point above 0.5 m every later point
    // is above 0 m. The fBm hills term can be negative where the hills fade
    // in past the beach; the land floor keeps it from cutting below the sea.
    for (const seed of [0, 1, 7, 1337, 4242]) {
      for (let a = 0; a < 90; a++) {
        const ang = (a / 90) * Math.PI * 2;
        let above = false;
        for (let r = ISLAND_RADIUS + 50; r >= 0; r -= 1) {
          const h = islandHeight(r * Math.cos(ang), r * Math.sin(ang), seed);
          if (above) expect(h, `seed ${seed} ray ${a} r ${r}`).toBeGreaterThan(0);
          if (h > 0.5) above = true;
        }
      }
    }
  });

  it("the seabed drops below the water's 30 m virtual floor by 450 m out", () => {
    for (const bearing of [0.3, 1.5, 2.8, 4.1, 5.3]) {
      const h = islandHeight(Math.cos(bearing) * 600, Math.sin(bearing) * 600, SEED);
      expect(h, `bearing ${bearing}`).toBeLessThan(-30);
    }
  });

  it("sea stacks stand above the water", () => {
    for (const s of SEA_STACKS) {
      expect(islandHeight(s.x, s.z, SEED)).toBeGreaterThan(2);
    }
  });
});

describe("sampleHeightmap", () => {
  it("matches islandHeight on the grid, x fastest", () => {
    const N = 17;
    const extent = 800;
    const hm = sampleHeightmap(N, extent, SEED);
    expect(hm.length).toBe(N * N);
    const step = extent / (N - 1);
    expect(hm[8 * N + 8]).toBeCloseTo(islandHeight(0, 0, SEED), 3);
    expect(hm[3 * N + 12]).toBeCloseTo(islandHeight(-400 + 12 * step, -400 + 3 * step, SEED), 3);
    expect(hm[0]).toBeCloseTo(islandHeight(-400, -400, SEED), 3);
  });
});
