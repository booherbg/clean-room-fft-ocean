import { describe, expect, it } from "vitest";
import {
  foamAdvectionOffset,
  foamDecayScale,
  foamDecayed,
  foamFold,
  foamSource,
  foamStep,
  foamWindward,
  type FoamAdvect,
} from "../src/core/foamModel";

const ADV: FoamAdvect = { slide: 0.9, wind: 0.35, capTexels: 3 };

describe("foamFold", () => {
  it("is 0 at and above the threshold", () => {
    expect(foamFold(0.8, 0.8)).toBe(0);
    expect(foamFold(0.8, 1.3)).toBe(0);
  });
  it("grows linearly below the threshold and is NOT clamped at 1", () => {
    expect(foamFold(0.8, 0.3)).toBeCloseTo(0.5, 10);
    // An overturned crest (J < 0) injects in proportion to the overturn.
    expect(foamFold(0.8, -0.6)).toBeCloseTo(1.4, 10);
    expect(foamFold(0.8, -0.6)).toBeGreaterThan(1);
  });
});

describe("foamWindward", () => {
  it("is 0 on flat water and on the lee face, 1 dead windward", () => {
    expect(foamWindward([0, 0], [1, 0])).toBe(0);
    expect(foamWindward([-1, 0], [1, 0])).toBe(0);
    expect(foamWindward([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(foamWindward([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe("foamSource", () => {
  it("matches the e2e oracle's closed form at J = 0", () => {
    // gpu.spec.ts: windward[0] ≈ (crest + windward)·threshold with slope ∥ wind.
    const threshold = 0.6;
    const fold = foamFold(threshold, 0);
    expect(foamSource(fold, 1, 2.5, 1.5)).toBeCloseTo((2.5 + 1.5) * threshold, 10);
  });
});

describe("foamDecayScale / foamDecayed", () => {
  it("is 1 in compressed and neutral water (J ≤ 1) — the oracle's exp(−dt/decay) stands", () => {
    expect(foamDecayScale(0, 1.5)).toBe(1);
    expect(foamDecayScale(1, 1.5)).toBe(1);
    expect(foamDecayed(2, 0.5, 0.5, foamDecayScale(1, 1.5))).toBeCloseTo(2 * Math.exp(-1), 10);
  });
  it("slows decay in stretched water, saturating one J past neutral", () => {
    expect(foamDecayScale(1.5, 1.5)).toBeCloseTo(1.75, 10);
    expect(foamDecayScale(2, 1.5)).toBeCloseTo(2.5, 10);
    expect(foamDecayScale(3, 1.5)).toBeCloseTo(2.5, 10);
    const trough = foamDecayed(2, 0.5, 0.5, foamDecayScale(2, 1.5));
    const crest = foamDecayed(2, 0.5, 0.5, foamDecayScale(1, 1.5));
    expect(trough).toBeGreaterThan(crest);
  });
  it("zero decay time forgets everything", () => {
    expect(foamDecayed(5, 0.01, 0, 1)).toBe(0);
  });
});

describe("foamAdvectionOffset", () => {
  it("reads from up the slope (foam slides down) and from upwind (foam drifts along)", () => {
    const [ox, oz] = foamAdvectionOffset([1, 0], [0, 0], 0.1, 0.375, ADV);
    expect(ox).toBeGreaterThan(0); // +slope direction = uphill
    expect(oz).toBe(0);
    const [wx] = foamAdvectionOffset([0, 0], [1, 0], 0.1, 0.375, ADV);
    expect(wx).toBeLessThan(0); // upwind
  });
  it("scales with dt over the cell and is capped in texels", () => {
    const a = foamAdvectionOffset([1, 0], [0, 0], 0.01, 0.375, ADV);
    const b = foamAdvectionOffset([1, 0], [0, 0], 0.02, 0.375, ADV);
    expect(b[0]).toBeCloseTo(2 * a[0], 10);
    const big = foamAdvectionOffset([200, 0], [0, 0], 1, 0.375, ADV);
    expect(Math.hypot(big[0], big[1])).toBeCloseTo(ADV.capTexels, 6);
  });
  it("is zero on flat calm (the oracle's constant fields are advection-invariant)", () => {
    expect(foamAdvectionOffset([0, 0], [0, 0], 0.1, 0.375, ADV)).toEqual([0, 0]);
  });
});

describe("foamStep", () => {
  const base = {
    prev: 0,
    J: 0,
    slope: [0, 0] as [number, number],
    windDir: [1, 0] as [number, number],
    dt: 0.1,
    threshold: 0.6,
    crestStrength: 2.5,
    windwardStrength: 1.5,
    decayTime: 0.5,
    troughBoost: 1.5,
  };

  it("reproduces the e2e oracle numbers with breakup off", () => {
    // Seeded: J ≡ 0 → at least crest·threshold.
    expect(foamStep(base)).toBeCloseTo(2.5 * 0.6, 10);
    // Calm: J ≡ 1 sources nothing.
    expect(foamStep({ ...base, J: 1 })).toBe(0);
    // Windward: slope ∥ wind at J ≡ 0.
    expect(foamStep({ ...base, slope: [1, 0] })).toBeCloseTo((2.5 + 1.5) * 0.6, 10);
    // Decay: charged 1.5, one J ≡ 1 step with dt = decayTime → e^−1.
    expect(foamStep({ ...base, prev: 1.5, J: 1, dt: 0.5 })).toBeCloseTo(1.5 * Math.exp(-1), 10);
  });

  it("memory: keeps the larger of the decayed field and the new source", () => {
    const hot = foamStep({ ...base, prev: 10, J: 1, dt: 0.01 });
    expect(hot).toBeGreaterThan(9.5);
    const sourced = foamStep({ ...base, prev: 0.01 });
    expect(sourced).toBeCloseTo(1.5, 10);
  });

  it("breakup thins the source by up to its weight, never below zero", () => {
    const full = foamStep(base);
    const thinned = foamStep({ ...base, breakup: 0.4, breakupNoise: 1 });
    expect(thinned).toBeCloseTo(full * 0.6, 10);
    const untouched = foamStep({ ...base, breakup: 0.4, breakupNoise: 0 });
    expect(untouched).toBeCloseTo(full, 10);
  });

  it("an overturned crest under wind injects far more than a barely folded one", () => {
    const mild = foamStep({ ...base, J: 0.55, slope: [1, 0] });
    const overturned = foamStep({ ...base, J: -0.5, slope: [1, 0] });
    expect(overturned / mild).toBeGreaterThan(10);
  });
});
