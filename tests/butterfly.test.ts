import { describe, expect, it } from "vitest";
import { applyButterflyStage, butterflyTable } from "../src/core/butterfly";
import { fft1d, fft2d } from "../src/core/fft";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomImage(N: number, seed: number): Float32Array {
  const rng = lcg(seed);
  const out = new Float32Array(N * N * 2);
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

/** Run every stage, ping-ponging between two buffers; returns the final buffer. */
function runStages(N: number, input: Float32Array, opts: { inverse?: boolean; vertical?: boolean }): Float32Array {
  const table = butterflyTable(N);
  let src = new Float32Array(input);
  let dst = new Float32Array(input.length);
  for (let s = 0; s < table.stages; s++) {
    applyButterflyStage(table, s, src, dst, opts);
    [src, dst] = [dst, src];
  }
  return src;
}

describe("butterflyTable", () => {
  it("has stages = log2(N) and N*stages*4 entries", () => {
    const t = butterflyTable(16);
    expect(t.N).toBe(16);
    expect(t.stages).toBe(4);
    expect(t.data.length).toBe(16 * 4 * 4);
  });

  it("twiddles have unit modulus and sources are in range", () => {
    const t = butterflyTable(64);
    for (let s = 0; s < t.stages; s++) {
      for (let i = 0; i < t.N; i++) {
        const o = (s * t.N + i) * 4;
        const a = t.data[o] ?? -1;
        const b = t.data[o + 1] ?? -1;
        const re = t.data[o + 2] ?? 0;
        const im = t.data[o + 3] ?? 0;
        expect(Number.isInteger(a) && a >= 0 && a < t.N).toBe(true);
        expect(Number.isInteger(b) && b >= 0 && b < t.N).toBe(true);
        expect(Math.hypot(re, im)).toBeCloseTo(1, 6);
      }
    }
  });

  it("stage 0 reads bit-reversed indices", () => {
    const t = butterflyTable(8);
    // index 0 pairs bitrev(0)=0 with bitrev(1)=4; index 2 pairs bitrev(2)=2 with bitrev(3)=6
    expect(t.data[0]).toBe(0);
    expect(t.data[1]).toBe(4);
    expect(t.data[2 * 4]).toBe(2);
    expect(t.data[2 * 4 + 1]).toBe(6);
  });

  it("rejects non-power-of-two N", () => {
    expect(() => butterflyTable(12)).toThrow();
  });
});

describe("applyButterflyStage", () => {
  for (const N of [8, 16, 64]) {
    it(`chained horizontal stages equal fft1d on every row (N=${N})`, () => {
      const img = randomImage(N, N);
      const out = runStages(N, img, {});
      const ref = new Float32Array(img);
      const row = new Float32Array(N * 2);
      for (let y = 0; y < N; y++) {
        row.set(ref.subarray(y * N * 2, (y + 1) * N * 2));
        fft1d(row, false);
        ref.set(row, y * N * 2);
      }
      expect(maxAbsDiff(out, ref)).toBeLessThan(1e-4);
    });
  }

  it("horizontal then vertical stages equal fft2d (forward)", () => {
    const N = 16;
    const img = randomImage(N, 3);
    const h = runStages(N, img, {});
    const out = runStages(N, h, { vertical: true });
    const ref = new Float32Array(img);
    fft2d(ref, N, false);
    expect(maxAbsDiff(out, ref)).toBeLessThan(1e-4);
  });

  it("inverse stages equal fft2d(inverse) once divided by N²", () => {
    const N = 16;
    const img = randomImage(N, 4);
    const h = runStages(N, img, { inverse: true });
    const out = runStages(N, h, { inverse: true, vertical: true });
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / (N * N);
    const ref = new Float32Array(img);
    fft2d(ref, N, true);
    expect(maxAbsDiff(out, ref)).toBeLessThan(1e-4);
  });

  it("rejects an out-of-range stage", () => {
    const t = butterflyTable(8);
    const buf = new Float32Array(8 * 8 * 2);
    expect(() => applyButterflyStage(t, 3, buf, new Float32Array(buf.length))).toThrow();
  });
});
