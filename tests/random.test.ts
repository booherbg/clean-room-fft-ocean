import { describe, expect, it } from "vitest";
import { gaussianPair, splitmix32 } from "../src/core/random";

describe("splitmix32", () => {
  it("is deterministic for a given seed", () => {
    const a = splitmix32(1);
    const b = splitmix32(1);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("differs across seeds", () => {
    const a = splitmix32(1);
    const b = splitmix32(2);
    const xs = Array.from({ length: 8 }, () => a());
    const ys = Array.from({ length: 8 }, () => b());
    expect(xs).not.toEqual(ys);
  });

  it("yields uniform [0,1) with mean ≈ 0.5", () => {
    const rng = splitmix32(1);
    let sum = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      sum += x;
    }
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.02);
  });
});

describe("gaussianPair", () => {
  it("produces N(0,1) samples", () => {
    const rng = splitmix32(42);
    const n = 20_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n / 2; i++) {
      const [a, b] = gaussianPair(rng);
      expect(Number.isFinite(a)).toBe(true);
      expect(Number.isFinite(b)).toBe(true);
      sum += a + b;
      sumSq += a * a + b * b;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});
