/**
 * Precomputed butterfly table for a GPU radix-2 FFT run as log2(N)
 * fragment-shader passes (Flügge 2013 / Tessendorf "GPU FFT" style).
 *
 * Layout: `data[(stage*N + index)*4 + {0,1,2,3}]` = `[srcA, srcB, twiddleRe, twiddleIm]`.
 * Each output element at `index` of a given stage is
 *
 *     out[index] = in[srcA] + twiddle · in[srcB]
 *
 * for **every** index — the sign of the lower butterfly leg is folded into
 * the stored twiddle, so the shader / CPU emulation has no branch. Stage 0
 * reads bit-reversed source indices; later stages read natural positions.
 * Twiddles are stored for the forward transform (e^{-i…}); the inverse uses
 * the conjugate. The 1/N normalisation is *not* applied by the stages.
 */

import { bitReverse, isPowerOfTwo, log2Int } from "./fft";

export interface ButterflyTable {
  N: number;
  stages: number;
  /** stages*N*4 floats: [srcA, srcB, twiddleRe, twiddleIm] per (stage, index). */
  data: Float32Array;
}

export function butterflyTable(N: number): ButterflyTable {
  if (!isPowerOfTwo(N)) throw new Error(`butterflyTable: N=${N} is not a power of two`);
  const stages = log2Int(N);
  const data = new Float32Array(stages * N * 4);
  for (let s = 0; s < stages; s++) {
    const half = 1 << s;
    const span = half << 1;
    for (let i = 0; i < N; i++) {
      const k = i % span;
      const top = k < half;
      const j = top ? k : k - half;
      let a = top ? i : i - half;
      let b = top ? i + half : i;
      if (s === 0) {
        a = bitReverse(a, stages);
        b = bitReverse(b, stages);
      }
      const ang = (-2 * Math.PI * j) / span;
      const sign = top ? 1 : -1;
      const o = (s * N + i) * 4;
      data[o] = a;
      data[o + 1] = b;
      data[o + 2] = sign * Math.cos(ang);
      data[o + 3] = sign * Math.sin(ang);
    }
  }
  return { N, stages, data };
}

export interface ButterflyStageOptions {
  /** Conjugate the twiddles (inverse transform, unnormalised). */
  inverse?: boolean;
  /** Transform columns instead of rows. */
  vertical?: boolean;
}

/**
 * CPU emulation of one GPU butterfly pass over an N×N interleaved-complex
 * image (`input[(y*N + x)*2]`). Horizontal passes transform each row;
 * vertical passes transform each column. `output` must be a distinct buffer.
 */
export function applyButterflyStage(
  table: ButterflyTable,
  stage: number,
  input: Float32Array,
  output: Float32Array,
  opts: ButterflyStageOptions = {},
): void {
  const { N, stages, data } = table;
  if (stage < 0 || stage >= stages) throw new Error(`applyButterflyStage: stage ${stage} out of range [0, ${stages})`);
  if (input.length !== N * N * 2 || output.length !== N * N * 2) {
    throw new Error(`applyButterflyStage: buffers must hold ${N * N * 2} floats`);
  }
  if (input === output) throw new Error("applyButterflyStage: input and output must differ");
  const conj = opts.inverse ? -1 : 1;
  const vertical = opts.vertical === true;
  const base = stage * N * 4;

  for (let line = 0; line < N; line++) {
    for (let i = 0; i < N; i++) {
      const o = base + i * 4;
      const a = data[o] as number;
      const b = data[o + 1] as number;
      const wr = data[o + 2] as number;
      const wi = conj * (data[o + 3] as number);
      const ia = vertical ? (a * N + line) * 2 : (line * N + a) * 2;
      const ib = vertical ? (b * N + line) * 2 : (line * N + b) * 2;
      const io = vertical ? (i * N + line) * 2 : (line * N + i) * 2;
      const br = input[ib] as number;
      const bi = input[ib + 1] as number;
      output[io] = (input[ia] as number) + br * wr - bi * wi;
      output[io + 1] = (input[ia + 1] as number) + br * wi + bi * wr;
    }
  }
}
