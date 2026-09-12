import { describe, expect, it } from "vitest";
import { besselJ0, iwaveG, iwaveKernel } from "../src/core/iwave";

describe("iWave kernel", () => {
  it("J0 matches tabulated values", () => {
    expect(besselJ0(0)).toBeCloseTo(1, 6);
    expect(besselJ0(1)).toBeCloseTo(0.7651977, 5);
    expect(besselJ0(2.4048)).toBeCloseTo(0, 3);
    expect(besselJ0(5)).toBeCloseTo(-0.1775968, 5);
    expect(besselJ0(10)).toBeCloseTo(-0.2459358, 5);
  });

  it("G(0) equals the closed form (1/2π)·√π/4 for σ=1", () => {
    expect(iwaveG(0)).toBeCloseTo(Math.sqrt(Math.PI) / 4 / (2 * Math.PI), 5);
  });

  it("the kernel is symmetric, positive at the centre, negative nearby", () => {
    const P = 6;
    const W = 2 * P + 1;
    const k = iwaveKernel(P);
    expect(k.length).toBe(W * W);
    const c = k[P * W + P]!;
    expect(c).toBeGreaterThan(0);
    // σ=1 smears the centre over ~2 texels; the negative ring sits further out.
    expect(Math.min(...k)).toBeLessThan(0);
    expect(k[P * W + P + 1]).toBeCloseTo(k[P * W + P - 1]!, 9);
    expect(k[(P + 1) * W + P]).toBeCloseTo(k[P * W + P + 1]!, 9);
    // D annihilates constants, so the untruncated kernel sums to zero; the
    // tail beyond P (≈ −1/(2πr³)) that the stencil drops integrates to ~1/P,
    // which is the DC residual the truncated kernel is left with. That is the
    // known iWave limit: waves longer than ~2πP texels see a floor on |k|.
    let sum = 0;
    for (const v of k) sum += v;
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThan(1 / P);
    expect(sum).toBeGreaterThan(0.7 / P);
  });

  it("acts like |k| on a long plane wave (per-texel units)", () => {
    const P = 6;
    const W = 2 * P + 1;
    const k = iwaveKernel(P);
    const kx = 0.4; // rad/texel, well inside the exp(−k²) window
    let acc = 0;
    for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) acc += k[(j + P) * W + (i + P)]! * Math.cos(kx * i);
    // Expect |k|·exp(−σk²) at the origin (cos = 1); the P=6 truncation costs a few %.
    const want = kx * Math.exp(-kx * kx);
    expect(Math.abs(acc - want) / want).toBeLessThan(0.06);
  });
});

describe("iWave kernel, zero-mean", () => {
  it("sums to zero and keeps the mid-band response", () => {
    const P = 6;
    const W = 2 * P + 1;
    const k = iwaveKernel(P, 1, true);
    let sum = 0;
    for (const v of k) sum += v;
    expect(Math.abs(sum)).toBeLessThan(1e-7);
    const response = (kx: number): number => {
      let acc = 0;
      for (let j = -P; j <= P; j++) for (let i = -P; i <= P; i++) acc += k[(j + P) * W + (i + P)]! * Math.cos(kx * i);
      return acc;
    };
    // Monotonic from DC up to the exp(−σk²) roll-off: group velocity > 0.
    let prev = 0;
    for (const kx of [0.05, 0.1, 0.2, 0.3, 0.5, 0.7]) {
      const r = response(kx);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    expect(response(0.8)).toBeGreaterThan(0.25);
  });

  it("has a non-negative response everywhere up to the Nyquist (no negative stiffness)", () => {
    const P = 6;
    const W = 2 * P + 1;
    const k = iwaveKernel(P, 1, true);
    let min = Infinity;
    for (let a = 0; a <= 32; a++) {
      for (let b = 0; b <= 32; b++) {
        const kx = (a / 32) * Math.PI;
        const ky = (b / 32) * Math.PI;
        let acc = 0;
        for (let j = -P; j <= P; j++)
          for (let i = -P; i <= P; i++) acc += k[(j + P) * W + (i + P)]! * Math.cos(kx * i) * Math.cos(ky * j);
        min = Math.min(min, acc);
      }
    }
    expect(min).toBeGreaterThan(-1e-6);
  });
});
