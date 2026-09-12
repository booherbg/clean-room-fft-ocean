import { describe, expect, it } from "vitest";
import {
  G,
  bandWeight,
  MAX_STEEPNESS,
  alphaFor,
  dispersion,
  dispersionDerivative,
  hasselmannSpread,
  jonswap,
  phi,
  piersonMoskowitzHs,
  significantWaveHeight,
  spectrumMoment0,
} from "../src/core/spectrum";
import { DEFAULT_PARAMS, type WaveParams } from "../src/core/params";

const TWO_PI = 2 * Math.PI;

describe("dispersion", () => {
  it("ω(1) = sqrt(g)", () => {
    expect(dispersion(1)).toBeCloseTo(3.132, 3);
    expect(dispersion(4, 1)).toBeCloseTo(2, 10);
  });

  it("derivative matches finite difference", () => {
    for (const k of [0.01, 0.5, 2, 30]) {
      const h = k * 1e-4;
      const fd = (dispersion(k + h) - dispersion(k - h)) / (2 * h);
      expect(dispersionDerivative(k)).toBeCloseTo(fd, 5);
    }
  });
});

describe("jonswap", () => {
  const p = { omegaPeak: 1.2, gamma: 3.3, sharpness: 1, alpha: 0.0081, g: G };

  it("peaks within 2 % of omegaPeak", () => {
    let best = 0;
    let bestOmega = 0;
    for (let omega = 0.1; omega <= 5; omega += 0.001) {
      const s = jonswap(omega, p);
      if (s > best) {
        best = s;
        bestOmega = omega;
      }
    }
    expect(Math.abs(bestOmega - p.omegaPeak) / p.omegaPeak).toBeLessThan(0.02);
  });

  it("is 0 at ω = 0 and finite everywhere", () => {
    expect(jonswap(0, p)).toBe(0);
    expect(Number.isFinite(jonswap(1e-6, p))).toBe(true);
    expect(jonswap(-1, p)).toBe(0);
  });

  it("gamma > 1 sharpens the peak", () => {
    const flat = jonswap(p.omegaPeak, { ...p, gamma: 1 });
    expect(jonswap(p.omegaPeak, p)).toBeGreaterThan(flat);
  });
});

describe("hasselmannSpread", () => {
  const base = { omegaPeak: 1.0, windSpeed: 8, windDirection: 0.7, standingWaveRatio: 0, g: G };

  function integrate(omega: number, p: typeof base, n = 4096): number {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += hasselmannSpread((i / n) * TWO_PI, omega, p);
    return (sum * TWO_PI) / n;
  }

  it("integrates to 1 over θ for ω = 0.5ωp and 2ωp", () => {
    for (const omega of [0.5, 2]) {
      expect(Math.abs(integrate(omega, base) - 1)).toBeLessThan(0.02);
      expect(Math.abs(integrate(omega, { ...base, standingWaveRatio: 0.5 }) - 1)).toBeLessThan(0.02);
    }
  });

  it("peaks at the wind direction", () => {
    const atWind = hasselmannSpread(base.windDirection, 1, base);
    for (const d of [0.3, 1, 2, 3]) {
      expect(atWind).toBeGreaterThan(hasselmannSpread(base.windDirection + d, 1, base));
      expect(atWind).toBeGreaterThan(hasselmannSpread(base.windDirection - d, 1, base));
    }
  });

  it("is symmetric about θ+π when standingWaveRatio = 1", () => {
    const p = { ...base, standingWaveRatio: 1 };
    for (const theta of [0, 0.4, 1.3, 2.9]) {
      expect(hasselmannSpread(theta, 1.5, p)).toBeCloseTo(hasselmannSpread(theta + Math.PI, 1.5, p), 6);
    }
  });

  it("is non-negative and finite even for extreme ω", () => {
    for (const omega of [1e-3, 1e3]) {
      const v = hasselmannSpread(0, omega, base);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("bandWeight", () => {
  it("is a hard [kMin, kMax) mask when the widths are 0", () => {
    const b = { kMin: 0.05, kMax: 1, kMinWidth: 0, kMaxWidth: 0 };
    expect(bandWeight(0.01, b)).toBe(0);
    expect(bandWeight(0.05, b)).toBe(1);
    expect(bandWeight(0.5, b)).toBe(1);
    expect(bandWeight(1, b)).toBe(0);
    expect(bandWeight(2, b)).toBe(0);
  });

  it("cross-fades linearly in energy over the width centred on each edge, complementary across a seam", () => {
    const coarse = { kMin: 0, kMax: 1, kMinWidth: 0, kMaxWidth: 0.2 };
    const fine = { kMin: 1, kMax: Infinity, kMinWidth: 0.2, kMaxWidth: 0 };
    expect(bandWeight(0.9, coarse)).toBe(1);
    expect(bandWeight(0.9, fine)).toBe(0);
    expect(bandWeight(1, coarse)).toBeCloseTo(0.5, 12);
    expect(bandWeight(1, fine)).toBeCloseTo(0.5, 12);
    expect(bandWeight(1.05, fine)).toBeCloseTo(0.75, 12);
    expect(bandWeight(1.1, coarse)).toBe(0);
    expect(bandWeight(1.1, fine)).toBe(1);
    for (const k of [0.85, 0.93, 1, 1.02, 1.09, 1.3]) expect(bandWeight(k, coarse) + bandWeight(k, fine)).toBeCloseTo(1, 12);
  });
});

describe("phi", () => {
  const w: WaveParams = { ...DEFAULT_PARAMS.waves };
  const L = 1024;
  const kMin = 0.05;
  const kMax = 1;

  it("is 0 at k = 0", () => {
    expect(phi(0, 0, w, L, 0, Infinity)).toBe(0);
    expect(phi(0, 0, w, L, 0, Infinity, undefined, 0.2, 0)).toBe(0);
  });

  it("is 0 outside the band and positive inside", () => {
    expect(phi(0.01, 0, w, L, kMin, kMax)).toBe(0);
    expect(phi(2, 0, w, L, kMin, kMax)).toBe(0);
    expect(phi(kMax, 0, w, L, kMin, kMax)).toBe(0); // half-open [kMin, kMax)
    expect(phi(0.1, 0, w, L, kMin, kMax)).toBeGreaterThan(0);
    expect(phi(0, kMin, w, L, kMin, kMax)).toBeGreaterThan(0);
  });

  it("applies the seam cross-fade to the energy", () => {
    const full = phi(0.1, 0, w, L, 0, Infinity);
    expect(phi(0.1, 0, w, L, 0.1, Infinity, undefined, 0.04, 0)).toBeCloseTo(full * 0.5, 9);
    expect(phi(0.1, 0, w, L, 0, 0.1, undefined, 0, 0.04)).toBeCloseTo(full * 0.5, 9);
    expect(phi(0.1, 0, w, L, 0, 0.11, undefined, 0, 0.04)).toBeCloseTo(full * 0.75, 9);
  });

  it("scales with amplitude²", () => {
    const a = phi(0.1, 0.05, w, L, 0, Infinity);
    const b = phi(0.1, 0.05, { ...w, amplitude: 3 }, L, 0, Infinity);
    expect(b / a).toBeCloseTo(9, 6);
  });

  it("favours the wind direction", () => {
    const k = 0.1;
    const down = phi(k, 0, w, L, 0, Infinity);
    const cross = phi(0, k, w, L, 0, Infinity);
    expect(down).toBeGreaterThan(cross);
  });
});

describe("wave-height calibration", () => {
  const w: WaveParams = { ...DEFAULT_PARAMS.waves };

  it("Pierson–Moskowitz Hs ≈ 0.21 U²/g: 2.5 m at 10 m/s, ~13 m at 25 m/s", () => {
    expect(piersonMoskowitzHs(10)).toBeCloseTo(2.14, 1);
    expect(piersonMoskowitzHs(25)).toBeCloseTo(13.4, 0);
  });

  it("significantWaveHeight follows PM well below the steepness cap and is ∝ amplitude", () => {
    const long = { ...w, peakWavelength: 400 }; // cap = 24 m, far above PM at these winds
    expect(significantWaveHeight({ ...long, windSpeed: 8 })).toBeCloseTo(piersonMoskowitzHs(8), 1);
    const h4 = significantWaveHeight({ ...long, windSpeed: 4 });
    const h8 = significantWaveHeight({ ...long, windSpeed: 8 });
    expect(h8 / h4).toBeGreaterThan(3.8);
    expect(h8 / h4).toBeLessThan(4.05);
    expect(significantWaveHeight({ ...long, amplitude: 2.5 }) / significantWaveHeight(long)).toBeCloseTo(2.5, 8);
  });

  it("soft-caps Hs at MAX_STEEPNESS · λp so the storm (17 m/s, 60 m) and slider max (25 m/s) stay usable", () => {
    const storm = significantWaveHeight({ ...w, windSpeed: 17, peakWavelength: 60 });
    expect(storm).toBeLessThan(MAX_STEEPNESS * 60);
    expect(storm).toBeGreaterThan(MAX_STEEPNESS * 60 * 0.8);
    const gale = significantWaveHeight({ ...w, windSpeed: 25, peakWavelength: 70 });
    expect(gale).toBeLessThan(MAX_STEEPNESS * 70);
    expect(gale).toBeGreaterThan(storm);
    // Monotonic across the whole slider.
    let prev = 0;
    for (let u = 0.5; u <= 25; u += 0.5) {
      const h = significantWaveHeight({ ...w, windSpeed: u });
      expect(h).toBeGreaterThan(prev);
      prev = h;
    }
  });

  it("spectrumMoment0 matches the closed form α g² / (5 ωp⁴) for γ = 1", () => {
    for (const omegaPeak of [0.5, 0.94, 2]) {
      const p = { omegaPeak, gamma: 1, sharpness: 1, alpha: 0.0081, g: G };
      const exact = (p.alpha * G * G) / (5 * omegaPeak ** 4);
      expect(spectrumMoment0(p) / exact).toBeCloseTo(1, 3);
    }
  });

  it("alphaFor normalises the spectrum's variance to (Hs/4)² / 2 (Hermitian doubling)", () => {
    for (const windSpeed of [3, 8, 17, 25]) {
      const ww = { ...w, windSpeed };
      const omegaPeak = dispersion(TWO_PI / ww.peakWavelength, ww.gravity);
      const m0 = spectrumMoment0({ omegaPeak, gamma: ww.jonswapGamma, sharpness: ww.spectralSharpness, alpha: alphaFor(ww), g: ww.gravity });
      const rms = significantWaveHeight(ww) / 4;
      expect(m0 / ((rms * rms) / 2)).toBeCloseTo(1, 6);
    }
    expect(alphaFor({ ...w, windSpeed: 0 })).toBe(0);
  });
});
