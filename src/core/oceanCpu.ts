/**
 * CPU reference implementation of the ocean pipeline (spec §1.1–1.3):
 * initial spectrum → time evolution → 2-D inverse FFT → unpack / Jacobian.
 *
 * It is the oracle for the GPU passes, so the texel layout and the channel
 * packing are chosen to be reproduced verbatim in GLSL:
 *
 * - Texel (x, y), 0 ≤ x, y < N, holds wavevector k = 2π·(x − N/2, y − N/2) / L.
 * - `initialSpectrum` → N*N*4: h0(k) in .rg, h0(−k) in .ba.
 * - `evolve` → four RGBA arrays, eight interleaved complex spectra:
 *     A = (h.re, h.im, Dx.re, Dx.im)
 *     B = (Dz.re, Dz.im, sx.re, sx.im)
 *     C = (sz.re, sz.im, dxdx.re, dxdx.im)
 *     D = (dzdz.re, dzdz.im, dxdz.re, dxdz.im)
 * - `simulate` runs the unnormalised inverse transform
 *     f(x) = Σ_k F(k) e^{i k·x}
 *   which, with k centred at N/2, is N² · IFFT · (−1)^{x+y}.
 */

import { fft2d } from "./fft";
import { gaussianPair, splitmix32 } from "./random";
import { alphaFor, dispersion, phi } from "./spectrum";
import type { CascadeLayout } from "./cascades";
import type { WaveParams } from "./params";

export interface CascadeFields {
  N: number;
  size: number;
  /** Vertical displacement h (m). */
  height: Float32Array;
  /** Horizontal displacement, already scaled by choppiness λ. */
  dx: Float32Array;
  dz: Float32Array;
  /** ∂h/∂x, ∂h/∂z. */
  slopeX: Float32Array;
  slopeZ: Float32Array;
  /** Raw (unscaled) ∂Dx/∂x, ∂Dz/∂z, ∂Dx/∂z. */
  dxdx: Float32Array;
  dzdz: Float32Array;
  dxdz: Float32Array;
  /** J = (1+λ dxdx)(1+λ dzdz) − (λ dxdz)². */
  jacobian: Float32Array;
}

export interface EvolvedSpectra {
  A: Float32Array;
  B: Float32Array;
  C: Float32Array;
  D: Float32Array;
}

/**
 * PRNG seed for one cascade: the user seed mixed with the tile size so the
 * cascades of one sea are independent draws. Integer so the GPU-side
 * DataTexture upload (which reuses this) is reproducible.
 */
export function cascadeSeed(seed: number, size: number): number {
  return (Math.trunc(seed) + Math.round(size * 64) * 0x9e37) >>> 0;
}

/** Initial amplitudes h0(k) (Tessendorf eq. 41) packed with h0(−k). */
export function initialSpectrum(w: WaveParams, N: number, layout: CascadeLayout): Float32Array {
  const L = layout.size;
  const dk = (2 * Math.PI) / L;
  const rng = splitmix32(cascadeSeed(w.seed, L));
  const out = new Float32Array(N * N * 4);
  const invSqrt2 = Math.SQRT1_2;
  const alpha = alphaFor(w);

  for (let y = 0; y < N; y++) {
    const kz = dk * (y - N / 2);
    for (let x = 0; x < N; x++) {
      const kx = dk * (x - N / 2);
      // Always draw, so the random stream is independent of the band limits.
      const [xr, xi] = gaussianPair(rng);
      const a = Math.sqrt(phi(kx, kz, w, L, layout.kMin, layout.kMax, alpha, layout.kMinWidth, layout.kMaxWidth)) * invSqrt2;
      const o = (y * N + x) * 4;
      out[o] = xr * a;
      out[o + 1] = xi * a;
    }
  }
  for (let y = 0; y < N; y++) {
    const my = (N - y) % N;
    for (let x = 0; x < N; x++) {
      const mx = (N - x) % N;
      const o = (y * N + x) * 4;
      const m = (my * N + mx) * 4;
      out[o + 2] = out[m] as number;
      out[o + 3] = out[m + 1] as number;
    }
  }
  return out;
}

/**
 * Time evolution (spec §1.2):
 *   h̃(k,t) = h0(k) e^{iωt} + conj(h0(−k)) e^{−iωt},  t ← t·animationSpeed
 * plus the derived spectra, packed as documented at the top of the file.
 */
export function evolve(h0: Float32Array, N: number, size: number, t: number, w: WaveParams): EvolvedSpectra {
  if (h0.length !== N * N * 4) throw new Error(`evolve: expected ${N * N * 4} floats, got ${h0.length}`);
  const A = new Float32Array(N * N * 4);
  const B = new Float32Array(N * N * 4);
  const C = new Float32Array(N * N * 4);
  const D = new Float32Array(N * N * 4);
  const dk = (2 * Math.PI) / size;
  const tt = t * w.animationSpeed;

  for (let y = 0; y < N; y++) {
    const kz = dk * (y - N / 2);
    for (let x = 0; x < N; x++) {
      const kx = dk * (x - N / 2);
      const k = Math.hypot(kx, kz);
      const o = (y * N + x) * 4;
      if (k === 0) continue; // all spectra zero at DC

      const omega = dispersion(k, w.gravity);
      const c = Math.cos(omega * tt);
      const s = Math.sin(omega * tt);
      const pr = h0[o] as number;
      const pi = h0[o + 1] as number;
      const mr = h0[o + 2] as number;
      const mi = h0[o + 3] as number;
      // h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}
      const hr = pr * c - pi * s + (mr * c - mi * s);
      const hi = pr * s + pi * c - (mr * s + mi * c);

      const nx = kx / k;
      const nz = kz / k;
      // Dx = −i·nx·h  = (hi·nx, −hr·nx)
      A[o] = hr;
      A[o + 1] = hi;
      A[o + 2] = hi * nx;
      A[o + 3] = -hr * nx;
      // Dz, sx = i·kx·h = (−hi·kx, hr·kx)
      B[o] = hi * nz;
      B[o + 1] = -hr * nz;
      B[o + 2] = -hi * kx;
      B[o + 3] = hr * kx;
      // sz, dxdx = kx·nx·h
      C[o] = -hi * kz;
      C[o + 1] = hr * kz;
      C[o + 2] = hr * kx * nx;
      C[o + 3] = hi * kx * nx;
      // dzdz = kz·nz·h, dxdz = kx·nz·h
      D[o] = hr * kz * nz;
      D[o + 1] = hi * kz * nz;
      D[o + 2] = hr * kx * nz;
      D[o + 3] = hi * kx * nz;
    }
  }
  return { A, B, C, D };
}

/**
 * Inverse-transform one complex channel (`lo` = 0 or 2 within the RGBA
 * texel) to a real spatial field: N²·IFFT·(−1)^{x+y}, real part only.
 */
function channelToField(spec: Float32Array, N: number, lo: number): Float32Array {
  const work = new Float32Array(N * N * 2);
  for (let p = 0; p < N * N; p++) {
    work[p * 2] = spec[p * 4 + lo] as number;
    work[p * 2 + 1] = spec[p * 4 + lo + 1] as number;
  }
  fft2d(work, N, true);
  const out = new Float32Array(N * N);
  const scale = N * N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sign = (x + y) & 1 ? -scale : scale;
      out[y * N + x] = (work[(y * N + x) * 2] as number) * sign;
    }
  }
  return out;
}

/** Full CPU pipeline for one cascade at time `t`. */
export function simulate(w: WaveParams, N: number, layout: CascadeLayout, t: number): CascadeFields {
  const h0 = initialSpectrum(w, N, layout);
  const { A, B, C, D } = evolve(h0, N, layout.size, t, w);
  const λ = w.choppiness;

  const height = channelToField(A, N, 0);
  const dx = channelToField(A, N, 2);
  const dz = channelToField(B, N, 0);
  const slopeX = channelToField(B, N, 2);
  const slopeZ = channelToField(C, N, 0);
  const dxdx = channelToField(C, N, 2);
  const dzdz = channelToField(D, N, 0);
  const dxdz = channelToField(D, N, 2);

  const jacobian = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    dx[i] = (dx[i] as number) * λ;
    dz[i] = (dz[i] as number) * λ;
    const jxx = 1 + λ * (dxdx[i] as number);
    const jzz = 1 + λ * (dzdz[i] as number);
    const jxz = λ * (dxdz[i] as number);
    jacobian[i] = jxx * jzz - jxz * jxz;
  }

  return { N, size: layout.size, height, dx, dz, slopeX, slopeZ, dxdx, dzdz, dxdz, jacobian };
}
