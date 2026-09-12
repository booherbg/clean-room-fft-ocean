import { describe, expect, it } from "vitest";
import { dftNaive, fft1d, fft2d } from "../src/core/fft";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomComplex(n: number, seed: number): Float32Array {
  const rng = lcg(seed);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

describe("fft1d", () => {
  for (const N of [8, 16, 64]) {
    it(`matches dftNaive for N=${N} (forward and inverse)`, () => {
      const data = randomComplex(N, N * 7 + 1);
      const fwdRef = dftNaive(data, false);
      const fwd = new Float32Array(data);
      fft1d(fwd, false);
      expect(maxAbsDiff(fwd, fwdRef)).toBeLessThan(1e-4);

      const invRef = dftNaive(data, true);
      const inv = new Float32Array(data);
      fft1d(inv, true);
      expect(maxAbsDiff(inv, invRef)).toBeLessThan(1e-4);
    });
  }

  it("inverse ∘ forward is the identity", () => {
    const data = randomComplex(32, 99);
    const work = new Float32Array(data);
    fft1d(work, false);
    fft1d(work, true);
    expect(maxAbsDiff(work, data)).toBeLessThan(1e-5);
  });

  it("rejects non-power-of-two lengths", () => {
    expect(() => fft1d(new Float32Array(6), false)).toThrow();
  });

  it("uses e^{-i} for forward: a pure tone lands in one bin", () => {
    const N = 16;
    const f = 3;
    const data = new Float32Array(N * 2);
    for (let n = 0; n < N; n++) {
      data[2 * n] = Math.cos((2 * Math.PI * f * n) / N);
      data[2 * n + 1] = Math.sin((2 * Math.PI * f * n) / N);
    }
    fft1d(data, false);
    expect(data[2 * f]).toBeCloseTo(N, 4);
    expect(data[2 * f + 1]).toBeCloseTo(0, 4);
    for (let k = 0; k < N; k++) {
      if (k === f) continue;
      expect(Math.abs(data[2 * k] ?? 0)).toBeLessThan(1e-4);
      expect(Math.abs(data[2 * k + 1] ?? 0)).toBeLessThan(1e-4);
    }
  });
});

describe("fft2d", () => {
  it("impulse at the origin transforms to a flat field", () => {
    const N = 8;
    const data = new Float32Array(N * N * 2);
    data[0] = 1;
    fft2d(data, N, false);
    for (let i = 0; i < N * N; i++) {
      expect(data[2 * i]).toBeCloseTo(1, 5);
      expect(data[2 * i + 1]).toBeCloseTo(0, 5);
    }
  });

  it("a single frequency bin inverse-transforms to a plane wave", () => {
    const N = 16;
    const kx = 2;
    const ky = 5;
    const data = new Float32Array(N * N * 2);
    data[(ky * N + kx) * 2] = N * N; // inverse divides by N² → unit amplitude
    fft2d(data, N, true);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const ph = (2 * Math.PI * (kx * x + ky * y)) / N;
        expect(data[(y * N + x) * 2]).toBeCloseTo(Math.cos(ph), 4);
        expect(data[(y * N + x) * 2 + 1]).toBeCloseTo(Math.sin(ph), 4);
      }
    }
  });

  it("inverse ∘ forward is the identity", () => {
    const N = 16;
    const data = randomComplex(N * N, 5);
    const work = new Float32Array(data);
    fft2d(work, N, false);
    fft2d(work, N, true);
    expect(maxAbsDiff(work, data)).toBeLessThan(1e-5);
  });

  it("matches separable dftNaive on rows then columns", () => {
    const N = 8;
    const data = randomComplex(N * N, 11);
    const fast = new Float32Array(data);
    fft2d(fast, N, false);

    const ref = new Float32Array(data);
    const row = new Float32Array(N * 2);
    for (let y = 0; y < N; y++) {
      row.set(ref.subarray(y * N * 2, (y + 1) * N * 2));
      ref.set(dftNaive(row, false), y * N * 2);
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        row[2 * y] = ref[(y * N + x) * 2] ?? 0;
        row[2 * y + 1] = ref[(y * N + x) * 2 + 1] ?? 0;
      }
      const col = dftNaive(row, false);
      for (let y = 0; y < N; y++) {
        ref[(y * N + x) * 2] = col[2 * y] ?? 0;
        ref[(y * N + x) * 2 + 1] = col[2 * y + 1] ?? 0;
      }
    }
    expect(maxAbsDiff(fast, ref)).toBeLessThan(1e-4);
  });
});
