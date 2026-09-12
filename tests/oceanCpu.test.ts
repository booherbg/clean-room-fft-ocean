import { describe, expect, it } from "vitest";
import type { CascadeLayout } from "../src/core/cascades";
import { DEFAULT_PARAMS, type WaveParams } from "../src/core/params";
import { cascadeSeed, evolve, initialSpectrum, simulate } from "../src/core/oceanCpu";
import { cascadeLayout } from "../src/core/cascades";
import { significantWaveHeight } from "../src/core/spectrum";

const N = 32;
const LAYOUT: CascadeLayout = { size: 256, N, kMin: 0, kMax: Infinity, kMinWidth: 0, kMaxWidth: 0 };

function waves(over: Partial<WaveParams> = {}): WaveParams {
  return { ...DEFAULT_PARAMS.waves, ...over };
}

function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] ?? 0;
  return s / a.length;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) ** 2;
  return Math.sqrt(s / a.length);
}

function maxAbs(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] ?? 0));
  return m;
}

describe("initialSpectrum", () => {
  it("packs h0(k) in .rg and h0(-k) in .ba", () => {
    const h0 = initialSpectrum(waves(), N, LAYOUT);
    expect(h0.length).toBe(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const mx = (N - x) % N;
        const my = (N - y) % N;
        const i = (y * N + x) * 4;
        const j = (my * N + mx) * 4;
        expect(h0[i + 2]).toBe(h0[j]);
        expect(h0[i + 3]).toBe(h0[j + 1]);
      }
    }
  });

  it("is zero at k=0 and finite everywhere", () => {
    const h0 = initialSpectrum(waves(), N, LAYOUT);
    const c = ((N / 2) * N + N / 2) * 4;
    expect(Math.abs(h0[c] ?? 1)).toBe(0);
    expect(Math.abs(h0[c + 1] ?? 1)).toBe(0);
    for (let i = 0; i < h0.length; i++) expect(Number.isFinite(h0[i])).toBe(true);
    expect(maxAbs(h0)).toBeGreaterThan(0);
  });

  it("is deterministic per seed and differs across seeds and cascades", () => {
    const a = initialSpectrum(waves({ seed: 7 }), N, LAYOUT);
    const b = initialSpectrum(waves({ seed: 7 }), N, LAYOUT);
    const c = initialSpectrum(waves({ seed: 8 }), N, LAYOUT);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(cascadeSeed(7, 256)).not.toBe(cascadeSeed(7, 96));
  });

  it("respects the cascade band", () => {
    const kBand = (2 * Math.PI * 6) / LAYOUT.size;
    const h0 = initialSpectrum(waves(), N, { size: LAYOUT.size, N, kMin: kBand, kMax: Infinity, kMinWidth: 0, kMaxWidth: 0 });
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const kx = ((2 * Math.PI) / LAYOUT.size) * (x - N / 2);
        const kz = ((2 * Math.PI) / LAYOUT.size) * (y - N / 2);
        if (Math.hypot(kx, kz) < kBand) {
          const i = (y * N + x) * 4;
          expect(Math.abs(h0[i] ?? 1)).toBe(0);
          expect(Math.abs(h0[i + 1] ?? 1)).toBe(0);
        }
      }
    }
  });
});

describe("evolve", () => {
  it("returns four N*N*4 arrays; at t=0 h̃ = h0(k) + conj(h0(-k))", () => {
    const w = waves();
    const h0 = initialSpectrum(w, N, LAYOUT);
    const { A, B, C, D } = evolve(h0, N, LAYOUT.size, 0, w);
    for (const arr of [A, B, C, D]) expect(arr.length).toBe(N * N * 4);
    for (let p = 0; p < N * N; p++) {
      expect(A[p * 4]).toBeCloseTo((h0[p * 4] ?? 0) + (h0[p * 4 + 2] ?? 0), 6);
      expect(A[p * 4 + 1]).toBeCloseTo((h0[p * 4 + 1] ?? 0) - (h0[p * 4 + 3] ?? 0), 6);
    }
  });

  it("derives the packed spectra from h̃ with the spec's k factors", () => {
    const w = waves();
    const h0 = initialSpectrum(w, N, LAYOUT);
    const { A, B, C, D } = evolve(h0, N, LAYOUT.size, 1.7, w);
    const dk = (2 * Math.PI) / LAYOUT.size;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const p = (y * N + x) * 4;
        const kx = dk * (x - N / 2);
        const kz = dk * (y - N / 2);
        const k = Math.hypot(kx, kz);
        const hr = A[p] ?? 0;
        const hi = A[p + 1] ?? 0;
        if (k === 0) {
          expect(hr).toBe(0);
          expect(hi).toBe(0);
          continue;
        }
        // Dx = -i (kx/k) h  → (hi·kx/k, −hr·kx/k)
        expect(A[p + 2]).toBeCloseTo((hi * kx) / k, 5);
        expect(A[p + 3]).toBeCloseTo((-hr * kx) / k, 5);
        // Dz
        expect(B[p]).toBeCloseTo((hi * kz) / k, 5);
        expect(B[p + 1]).toBeCloseTo((-hr * kz) / k, 5);
        // sx = i kx h → (−hi kx, hr kx)
        expect(B[p + 2]).toBeCloseTo(-hi * kx, 5);
        expect(B[p + 3]).toBeCloseTo(hr * kx, 5);
        // sz
        expect(C[p]).toBeCloseTo(-hi * kz, 5);
        expect(C[p + 1]).toBeCloseTo(hr * kz, 5);
        // dxdx = kx²/k h
        expect(C[p + 2]).toBeCloseTo((hr * kx * kx) / k, 5);
        expect(C[p + 3]).toBeCloseTo((hi * kx * kx) / k, 5);
        // dzdz, dxdz
        expect(D[p]).toBeCloseTo((hr * kz * kz) / k, 5);
        expect(D[p + 1]).toBeCloseTo((hi * kz * kz) / k, 5);
        expect(D[p + 2]).toBeCloseTo((hr * kx * kz) / k, 5);
        expect(D[p + 3]).toBeCloseTo((hi * kx * kz) / k, 5);
      }
    }
  });

  it("animationSpeed scales time", () => {
    const w = waves({ animationSpeed: 2 });
    const h0 = initialSpectrum(w, N, LAYOUT);
    const a = evolve(h0, N, LAYOUT.size, 1, w).A;
    const b = evolve(h0, N, LAYOUT.size, 2, waves({ animationSpeed: 1 })).A;
    expect(maxAbs(a)).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i] ?? 0, 5);
  });

  it("the sim owns animationSpeed: simulate(t, speed s) ≡ simulate(s·t, speed 1), so the app must pass wall-clock time", () => {
    // Pins the single owner of the multiply (the evolve step). If the app
    // also scaled its clock the effective speed would be animationSpeed².
    const fast = simulate(waves({ animationSpeed: 3 }), N, LAYOUT, 0.7);
    const slow = simulate(waves({ animationSpeed: 1 }), N, LAYOUT, 2.1);
    const frozen = simulate(waves({ animationSpeed: 0 }), N, LAYOUT, 5);
    const t0 = simulate(waves({ animationSpeed: 1 }), N, LAYOUT, 0);
    expect(rms(fast.height)).toBeGreaterThan(0);
    for (let i = 0; i < fast.height.length; i++) {
      expect(fast.height[i]).toBeCloseTo(slow.height[i] ?? 0, 5);
      expect(frozen.height[i]).toBeCloseTo(t0.height[i] ?? 0, 5);
    }
  });
});

describe("simulate", () => {
  it("produces N*N fields whose height is real-valued with mean ≈ 0", () => {
    const f = simulate(waves(), N, LAYOUT, 3.2);
    expect(f.N).toBe(N);
    expect(f.size).toBe(LAYOUT.size);
    expect(f.height.length).toBe(N * N);
    expect(f.jacobian.length).toBe(N * N);
    const r = rms(f.height);
    expect(r).toBeGreaterThan(0);
    expect(Math.abs(mean(f.height))).toBeLessThan(r * 0.05);
  });

  it("height is the Hermitian-symmetric sum: imaginary parts vanish", () => {
    const f = simulate(waves(), N, LAYOUT, 1);
    // rather than exposing the imaginary channel, check the height is the
    // real inverse transform: evaluate one texel by brute force
    const w = waves();
    const h0 = initialSpectrum(w, N, LAYOUT);
    const { A } = evolve(h0, N, LAYOUT.size, 1, w);
    const x = 5;
    const y = 11;
    let re = 0;
    let im = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const ph = (2 * Math.PI * ((n - N / 2) * x + (m - N / 2) * y)) / N;
        const p = (m * N + n) * 4;
        const hr = A[p] ?? 0;
        const hi = A[p + 1] ?? 0;
        re += hr * Math.cos(ph) - hi * Math.sin(ph);
        im += hr * Math.sin(ph) + hi * Math.cos(ph);
      }
    }
    expect(Math.abs(im)).toBeLessThan(1e-3 * Math.max(1, Math.abs(re)));
    expect(f.height[y * N + x]).toBeCloseTo(re, 3);
  });

  it("RMS height scales linearly with amplitude and ∝ U² below the steepness cap", () => {
    // Hs ∝ U² (Pierson–Moskowitz) while far below MAX_STEEPNESS·λp; a long
    // peak keeps both winds on the PM branch.
    const long = { peakWavelength: 400 };
    const calm = simulate(waves({ ...long, windSpeed: 4 }), N, LAYOUT, 2).height;
    const windy = simulate(waves({ ...long, windSpeed: 8 }), N, LAYOUT, 2).height;
    expect(windy).not.toEqual(calm);
    const ratio = rms(windy) / rms(calm);
    // Same seed, same shape: only the JONSWAP tail truncation (wind-independent) differs.
    expect(ratio).toBeGreaterThan(3.6);
    expect(ratio).toBeLessThan(4.4);
    const big = rms(simulate(waves({ amplitude: 2 }), N, LAYOUT, 2).height);
    const one = rms(simulate(waves({ amplitude: 1 }), N, LAYOUT, 2).height);
    expect(big / one).toBeCloseTo(2, 3);
  });

  it("is calibrated: default wind 8 on a 1024 m tile at N=64 gives Hs ≈ 1.37 m (RMS = Hs/4) within 25 %", () => {
    // Target: PM Hs = 0.21·8²/9.81 = 1.37 m → RMS 0.342 m. The 1024 m / N=64
    // grid resolves 32 m ≤ λ ≤ 1024 m; for λp = 70 m the JONSWAP tail above
    // its 1.5·ωp cut-off holds ~10 % of the variance, and one realisation
    // of ~800 populated modes adds a few % of sampling scatter — so expect
    // ≈ 0.90 × target. 25 % covers both with margin.
    const w = waves();
    const full = { size: 1024, N: 64, kMin: 0, kMax: Infinity, kMinWidth: 0, kMaxWidth: 0 };
    const hs = significantWaveHeight(w);
    expect(hs).toBeCloseTo(1.37, 1);
    const measured = rms(simulate(w, 64, full, 2).height);
    expect(measured / (hs / 4)).toBeGreaterThan(0.75);
    expect(measured / (hs / 4)).toBeLessThan(1.25);
  });

  it("calibration is independent of tile size: the high tier's three cascades sum to the same RMS", () => {
    // Cascade variances add (disjoint bands). The 9 m tile at N=64 stops at
    // λ = 0.28 m — well into the tail — so the sum recovers ≈ 0.85–1.0 × Hs/4
    // for the storm as for the default sea.
    for (const over of [{}, { windSpeed: 17, peakWavelength: 60 }]) {
      const w = waves(over);
      let sum = 0;
      for (const layout of cascadeLayout(1024, "high")) sum += rms(simulate(w, 64, layout, 2).height) ** 2;
      const ratio = Math.sqrt(sum) / (significantWaveHeight(w) / 4);
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.25);
    }
  });

  it("same seed ⇒ identical arrays; different seed ⇒ different", () => {
    const a = simulate(waves({ seed: 42 }), N, LAYOUT, 0.5);
    const b = simulate(waves({ seed: 42 }), N, LAYOUT, 0.5);
    const c = simulate(waves({ seed: 43 }), N, LAYOUT, 0.5);
    expect(a.height).toEqual(b.height);
    expect(a.jacobian).toEqual(b.jacobian);
    expect(a.height).not.toEqual(c.height);
  });

  it("jacobian is exactly 1 for choppiness 0 and ≈ 1 on average otherwise", () => {
    const flat = simulate(waves({ choppiness: 0 }), N, LAYOUT, 1);
    for (let i = 0; i < flat.jacobian.length; i++) expect(flat.jacobian[i]).toBe(1);
    expect(maxAbs(flat.dx)).toBe(0);
    expect(maxAbs(flat.dz)).toBe(0);

    const chop = simulate(waves({ choppiness: 1 }), N, LAYOUT, 1);
    expect(Math.abs(mean(chop.jacobian) - 1)).toBeLessThan(0.1);
    expect(maxAbs(chop.dx)).toBeGreaterThan(0);
  });

  it("jacobian matches (1+λ∂Dx/∂x)(1+λ∂Dz/∂z) − (λ∂Dx/∂z)² from the derivative fields", () => {
    const λ = 1.5;
    const f = simulate(waves({ choppiness: λ }), N, LAYOUT, 0.25);
    for (let i = 0; i < f.jacobian.length; i++) {
      const j = (1 + λ * (f.dxdx[i] ?? 0)) * (1 + λ * (f.dzdz[i] ?? 0)) - (λ * (f.dxdz[i] ?? 0)) ** 2;
      expect(f.jacobian[i]).toBeCloseTo(j, 5);
    }
  });

  it("slopeX is the analytic ∂h/∂x: brute-force Σ i·kx·h̃·e^{ik·x} at a texel", () => {
    const w = waves();
    const f = simulate(w, N, LAYOUT, 0.8);
    const h0 = initialSpectrum(w, N, LAYOUT);
    const { A } = evolve(h0, N, LAYOUT.size, 0.8, w);
    const dk = (2 * Math.PI) / LAYOUT.size;
    const x = 9;
    const y = 3;
    let re = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = dk * (n - N / 2);
        const ph = (2 * Math.PI * ((n - N / 2) * x + (m - N / 2) * y)) / N;
        const p = (m * N + n) * 4;
        // i·kx·h = (−hi·kx, hr·kx)
        const sr = -(A[p + 1] ?? 0) * kx;
        const si = (A[p] ?? 0) * kx;
        re += sr * Math.cos(ph) - si * Math.sin(ph);
      }
    }
    expect(f.slopeX[y * N + x]).toBeCloseTo(re, 3);
  });
});
