import { describe, expect, it } from "vitest";
import { cascadeLayout, type CascadeLayout } from "../src/core/cascades";
import { DEFAULT_PARAMS, cloneParams, tierConfig, type QualityTier } from "../src/core/params";
import { bandWeight } from "../src/core/spectrum";

const TIERS: QualityTier[] = ["low", "medium", "high", "ultra", "max"];

describe("tierConfig", () => {
  it("matches the table", () => {
    expect(tierConfig("low")).toEqual({ N: 256, finestN: 256, cascades: 1, meshSegments: 16, foam: false, sss: false, spray: false, rain: false, ssr: false });
    expect(tierConfig("medium")).toEqual({ N: 256, finestN: 128, cascades: 2, meshSegments: 32, foam: true, sss: false, spray: true, rain: true, ssr: true });
    expect(tierConfig("high")).toEqual({ N: 256, finestN: 256, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true });
    expect(tierConfig("ultra")).toEqual({ N: 512, finestN: 512, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true });
    expect(tierConfig("max")).toEqual({ N: 512, finestN: 512, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true });
  });
});

describe("DEFAULT_PARAMS / cloneParams", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_PARAMS.waves).toEqual({
      amplitude: 1,
      animationSpeed: 1,
      choppiness: 1,
      gravity: 9.81,
      jonswapGamma: 3.3,
      peakWavelength: 70,
      spectralSharpness: 1,
      standingWaveRatio: 0,
      windDirection: 0,
      windSpeed: 8,
      seed: 1337,
    });
    expect(DEFAULT_PARAMS.quality).toBe("high");
    expect(DEFAULT_PARAMS.maxScale).toBe(1024);
    expect(DEFAULT_PARAMS.foam.threshold).toBe(0.8);
    expect(DEFAULT_PARAMS.fog).toEqual({ color: "#b4c0cc", near: 500, far: 1800 });
    expect(DEFAULT_PARAMS.weather).toEqual({ rain: 0, rainEnabled: true });
  });

  it("clones deeply", () => {
    const c = cloneParams(DEFAULT_PARAMS);
    expect(c).toEqual(DEFAULT_PARAMS);
    expect(c).not.toBe(DEFAULT_PARAMS);
    c.waves.windSpeed = 99;
    expect(DEFAULT_PARAMS.waves.windSpeed).toBe(8);
    c.weather.rain = 1;
    expect(DEFAULT_PARAMS.weather.rain).toBe(0);
  });
});

describe("cascadeLayout", () => {
  it("sizes per table", () => {
    expect(cascadeLayout(1024, "low").map((c) => c.size)).toEqual([1024]);
    expect(cascadeLayout(1024, "medium").map((c) => c.size)).toEqual([1024, 96]);
    expect(cascadeLayout(1024, "high").map((c) => c.size)).toEqual([1024, 96, 9]);
    expect(cascadeLayout(1024, "ultra").map((c) => c.size)).toEqual([1024, 96, 9]);
    expect(cascadeLayout(1024, "max").map((c) => c.size)).toEqual([1024, 48, 2.25]);
    expect(cascadeLayout(512, "high").map((c) => c.size)).toEqual([512, 48, 4.5]);
  });

  it("bands are contiguous, increasing, and below each cascade's Nyquist", () => {
    for (const tier of TIERS) {
      const layout = cascadeLayout(1024, tier);
      expect(layout[0]!.kMin).toBe(0);
      expect(layout[0]!.kMinWidth).toBe(0);
      expect(layout[layout.length - 1]!.kMax).toBe(Infinity);
      expect(layout[layout.length - 1]!.kMaxWidth).toBe(0);
      for (let i = 0; i < layout.length; i++) {
        const c = layout[i]!;
        expect(c.kMax).toBeGreaterThan(c.kMin);
        // The whole cross-fade sits below this tile's Nyquist, with ≥ 16 texels per wavelength.
        expect(c.kMax === Infinity ? c.kMin + c.kMinWidth / 2 : c.kMax + c.kMaxWidth / 2).toBeLessThanOrEqual(
          (Math.PI * c.N) / c.size / 8 + 1e-12,
        );
        if (i + 1 < layout.length) {
          const next = layout[i + 1]!;
          // Hand off at the finer tile's fundamental, cross-fading over one of its bins.
          expect(c.kMax).toBe(next.kMin);
          expect(c.kMax).toBeCloseTo((2 * Math.PI) / next.size, 12);
          expect(c.kMaxWidth).toBe(next.kMinWidth);
          expect(c.kMaxWidth).toBeCloseTo((2 * Math.PI) / next.size, 12);
        }
      }
    }
  });

  /**
   * Each bin (m, n) of a tile of side L stands for the dk×dk cell
   * (dk = 2π/L) of k-space around 2π(m, n)/L, carrying its band weight. A
   * point of k-space is therefore represented by one cell per cascade;
   * the sum of their weights is how many times the cascades count that
   * wave. It cannot be exactly 1 pointwise (a fine cell straddles many
   * coarse cells across a seam), but its average over any annulus wider
   * than a seam must be ≈ 1: no hole, no double counting.
   */
  function pointCoverage(layout: CascadeLayout[], kx: number, kz: number): number {
    let sum = 0;
    for (const c of layout) {
      const dk = (2 * Math.PI) / c.size;
      const m = Math.round(kx / dk);
      const n = Math.round(kz / dk);
      if (Math.abs(m) > c.N / 2 || Math.abs(n) > c.N / 2) continue;
      sum += bandWeight(Math.hypot(m * dk, n * dk), c);
    }
    return sum;
  }

  /**
   * Energy bookkeeping: each bin of each cascade contributes `weight · dk²`
   * of k-space. Summed over the bins whose centre lies in k0 ≤ |k| < k1
   * and divided by what a single lattice of spacing `refDk` puts there
   * with weight 1 (the reference is a lattice, not π(k1² − k0²): near its
   * origin a lattice's bin count in a disc is 10 % off the area — the
   * Gauss circle problem — and the cascades inherit that quantisation)
   * this is ≈ 1 when the cascades neither drop nor double count energy.
   * (Averaging `pointCoverage` over an annulus instead reads ±20 % at a
   * seam: the finer tile's cells are square and dk wide while the ramp is
   * radial, so a cell's inner corner over-reads and its outer corner
   * under-reads, and only whole cells sum to 1.)
   */
  function bandEnergy(layout: CascadeLayout[], k0: number, k1: number, refDk: number): number {
    const sumBins = (dk: number, weight: (k: number) => number, half: number): number => {
      let sum = 0;
      const mMax = Math.min(half, Math.ceil(k1 / dk));
      for (let m = -mMax; m <= mMax; m++) {
        for (let n = -mMax; n <= mMax; n++) {
          const k = Math.hypot(m * dk, n * dk);
          if (k < k0 || k >= k1) continue;
          sum += weight(k) * dk * dk;
        }
      }
      return sum;
    };
    let sum = 0;
    for (const c of layout) sum += sumBins((2 * Math.PI) / c.size, (k) => bandWeight(k, c), c.N / 2);
    return sum / sumBins(refDk, () => 1, Infinity);
  }

  it("bin coverage: no wavelength between λmax and the finest tile's Nyquist is unrepresented, nor double counted", () => {
    for (const tier of TIERS) {
      const layout = cascadeLayout(1024, tier);
      const coarse = layout[0]!;
      const fine = layout[layout.length - 1]!;
      const kLo = (2 * Math.PI * 2) / coarse.size; // λ = 512 m
      const kHi = (Math.PI * fine.N) / fine.size / 2; // half the finest Nyquist
      // Hole guard: every point of k-space in range sits in some cell with
      // real weight (a seam cell carries ≥ 0.5 on its own).
      let worstPoint = Infinity;
      for (let i = 0; i <= 2000; i++) {
        const k = kLo * Math.pow(kHi / kLo, i / 2000);
        for (let a = 0; a < 24; a++) {
          const theta = (a / 24) * Math.PI * 2 + 0.013;
          worstPoint = Math.min(worstPoint, pointCoverage(layout, k * Math.cos(theta), k * Math.sin(theta)));
        }
      }
      expect(worstPoint, `${tier}: hole`).toBeGreaterThan(0.3);
      // Energy guard: across each seam (two octaves either side) and over
      // the whole range the weighted bin area matches the k-space area.
      for (let i = 1; i < layout.length; i++) {
        const ks = layout[i]!.kMin;
        expect(bandEnergy(layout, ks / 4, ks * 4, ks), `${tier}: seam ${i} energy`).toBeCloseTo(1, 1);
      }
      expect(bandEnergy(layout, kLo, kHi, (2 * Math.PI) / fine.size), `${tier}: total energy`).toBeCloseTo(1, 1);
    }
  });

  it("the old 16th-harmonic hand-off had holes (regression guard for the rule)", () => {
    // Standard layout, 1024 m → 96 m seam. The old cut at the 1024 m tile's
    // 16th harmonic (64 m, k = 1.5·dk of the 96 m tile) dropped the 96 m
    // tile's (1,0) and (1,1) bins; along the diagonal nothing then stood
    // for waves between 64 m and 45 m (λ = 56 m here). The cross-fade at the
    // 96 m fundamental keeps them.
    const layout = cascadeLayout(1024, "high");
    const k = (2 * Math.PI) / 56;
    const kx = k * Math.SQRT1_2;
    expect(pointCoverage(layout, kx, kx)).toBeGreaterThan(0.3);
    const cut = (2 * Math.PI * 16) / 1024;
    const oldRule = layout.map((c, i) =>
      i === 0 ? { ...c, kMax: cut, kMaxWidth: 0 } : i === 1 ? { ...c, kMin: cut, kMinWidth: 0 } : c,
    );
    expect(pointCoverage(oldRule, kx, kx)).toBe(0);
    // ... and the octave either side of the seam was short by the dropped bins.
    const seam = layout[1]!.kMin;
    expect(bandEnergy(oldRule, seam / 2, seam * 2, seam)).toBeLessThan(0.9);
    expect(bandEnergy(layout, seam / 2, seam * 2, seam)).toBeCloseTo(1, 1);
  });

  it("per-cascade N: the tier's N, finestN on the last cascade, overridable", () => {
    expect(cascadeLayout(1024, "high").map((c) => c.N)).toEqual([256, 256, 256]);
    expect(cascadeLayout(1024, "ultra").map((c) => c.N)).toEqual([512, 512, 512]);
    expect(cascadeLayout(1024, "medium").map((c) => c.N)).toEqual([256, 128]);
    expect(cascadeLayout(1024, "high", [256, 128, 64]).map((c) => c.N)).toEqual([256, 128, 64]);
  });

  it("half-resolution finest cascade keeps the bands abutting and the k-range unchanged", () => {
    const half = cascadeLayout(1024, "medium");
    const full = cascadeLayout(1024, "medium", [256, 256]);
    expect(half.map((c) => c.size)).toEqual(full.map((c) => c.size));
    expect(half.map((c) => c.kMin)).toEqual(full.map((c) => c.kMin));
    expect(half.map((c) => c.kMax)).toEqual(full.map((c) => c.kMax));
    // Abutting: each band's upper edge is the next band's lower edge; the union is [0, ∞).
    expect(half[0]!.kMin).toBe(0);
    expect(half[0]!.kMax).toBe(half[1]!.kMin);
    expect(half[1]!.kMax).toBe(Infinity);
    // The finest cascade still resolves its whole band: kMin well under its (halved) Nyquist.
    const fine = half[1]!;
    const nyquist = (Math.PI * fine.N) / fine.size;
    expect(fine.N).toBe(128);
    expect(fine.kMin).toBeLessThan(nyquist / 2);
    // The handoff wave (kMin) is sampled by ≥ 16 texels per wavelength on the fine tile.
    const texel = fine.size / fine.N;
    expect((2 * Math.PI) / fine.kMin / texel).toBeGreaterThanOrEqual(16);
  });
});
