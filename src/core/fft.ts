/**
 * Radix-2 Cooley–Tukey FFT on interleaved complex data
 * `[re0, im0, re1, im1, ...]`.
 *
 * Conventions (shared with the GPU butterfly passes):
 *   forward:  X[k] = Σ_n x[n] · e^{-2πi nk/N}
 *   inverse:  x[n] = (1/N) Σ_k X[k] · e^{+2πi nk/N}
 *
 * Pure TypeScript, no DOM / three imports — this is the oracle.
 */

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function log2Int(n: number): number {
  let s = 0;
  while (1 << s < n) s++;
  return s;
}

/** Bit-reverse `i` over `bits` bits. */
export function bitReverse(i: number, bits: number): number {
  let r = 0;
  for (let b = 0; b < bits; b++) {
    r = (r << 1) | (i & 1);
    i >>= 1;
  }
  return r;
}

/** In-place 1-D FFT. `data.length / 2` must be a power of two. */
export function fft1d(data: Float32Array, inverse: boolean): void {
  fftStrided(data, 0, 1, data.length >> 1, inverse);
}

/**
 * In-place 2-D FFT of an N×N complex image stored row-major
 * (`data[(y*N + x)*2]`): rows first, then columns.
 */
export function fft2d(data: Float32Array, N: number, inverse: boolean): void {
  if (data.length !== N * N * 2) throw new Error(`fft2d: expected ${N * N * 2} floats, got ${data.length}`);
  for (let y = 0; y < N; y++) fftStrided(data, y * N * 2, 1, N, inverse);
  for (let x = 0; x < N; x++) fftStrided(data, x * 2, N, N, inverse);
}

/**
 * Naive O(N²) DFT of an interleaved complex signal. Returns a new array.
 * Same sign / scaling conventions as `fft1d`. Test oracle only.
 */
export function dftNaive(data: Float32Array, inverse: boolean): Float32Array {
  const N = data.length >> 1;
  const out = new Float32Array(N * 2);
  const sign = inverse ? 1 : -1;
  const scale = inverse ? 1 / N : 1;
  for (let k = 0; k < N; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const ang = (sign * 2 * Math.PI * ((n * k) % N)) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const xr = data[2 * n] as number;
      const xi = data[2 * n + 1] as number;
      re += xr * c - xi * s;
      im += xr * s + xi * c;
    }
    out[2 * k] = re * scale;
    out[2 * k + 1] = im * scale;
  }
  return out;
}

/**
 * In-place FFT over `N` complex samples starting at float `offset` with a
 * `stride` measured in complex samples. Lets `fft2d` transform columns
 * without copying.
 */
function fftStrided(data: Float32Array, offset: number, stride: number, N: number, inverse: boolean): void {
  if (!isPowerOfTwo(N)) throw new Error(`fft: length ${N} is not a power of two`);
  const bits = log2Int(N);
  const step = stride * 2;

  // Bit-reversal permutation.
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      const a = offset + i * step;
      const b = offset + j * step;
      const tr = data[a] as number;
      const ti = data[a + 1] as number;
      data[a] = data[b] as number;
      data[a + 1] = data[b + 1] as number;
      data[b] = tr;
      data[b + 1] = ti;
    }
  }

  // Iterative butterflies.
  const sign = inverse ? 1 : -1;
  for (let half = 1; half < N; half <<= 1) {
    const span = half << 1;
    const theta = (sign * Math.PI) / half;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let start = 0; start < N; start += span) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const a = offset + (start + k) * step;
        const b = offset + (start + k + half) * step;
        const br = data[b] as number;
        const bi = data[b + 1] as number;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        const ar = data[a] as number;
        const ai = data[a + 1] as number;
        data[a] = ar + tr;
        data[a + 1] = ai + ti;
        data[b] = ar - tr;
        data[b + 1] = ai - ti;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }

  if (inverse) {
    const inv = 1 / N;
    for (let i = 0; i < N; i++) {
      const a = offset + i * step;
      data[a] = (data[a] as number) * inv;
      data[a + 1] = (data[a + 1] as number) * inv;
    }
  }
}
