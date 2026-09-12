/**
 * iWave (Tessendorf 2004, "Interactive Water Surfaces") vertical-derivative
 * kernel. The deep-water surface obeys
 *
 *   ∂²h/∂t² + α ∂h/∂t = −g · D[h],   F[D] = |k|
 *
 * where D is the "vertical derivative" operator. Its convolution kernel,
 * regularised by exp(−σk²) so that a small (2P+1)² stencil captures it, is
 * the 2-D Hankel transform
 *
 *   G(r) = (1/2π) ∫₀^∞ k² exp(−σk²) J₀(kr) dk
 *
 * with r in texels. `iwaveKernel` tabulates it on the stencil in row-major
 * order (y outer, x inner) ready to upload as a GLSL uniform array.
 */

/** Bessel J₀ (Abramowitz & Stegun 9.4.1 / 9.4.3, |error| < 1e-7). */
export function besselJ0(x: number): number {
  const ax = Math.abs(x);
  if (ax < 3) {
    const y = (x / 3) ** 2;
    return (
      1 -
      2.2499997 * y +
      1.2656208 * y ** 2 -
      0.3163866 * y ** 3 +
      0.0444479 * y ** 4 -
      0.0039444 * y ** 5 +
      0.00021 * y ** 6
    );
  }
  const y = 3 / ax;
  const f0 =
    0.79788456 -
    0.00000077 * y -
    0.0055274 * y ** 2 -
    0.00009512 * y ** 3 +
    0.00137237 * y ** 4 -
    0.00072805 * y ** 5 +
    0.00014476 * y ** 6;
  const t0 =
    ax -
    0.78539816 -
    0.04166397 * y -
    0.00003954 * y ** 2 +
    0.00262573 * y ** 3 -
    0.00054125 * y ** 4 -
    0.00029333 * y ** 5 +
    0.00013558 * y ** 6;
  return (f0 * Math.cos(t0)) / Math.sqrt(ax);
}

/** G(r) by midpoint quadrature; the integrand is negligible past k ≈ 6/√σ. */
export function iwaveG(r: number, sigma = 1, dk = 0.002): number {
  const kMax = 8 / Math.sqrt(sigma);
  let sum = 0;
  for (let k = dk / 2; k < kMax; k += dk) {
    sum += k * k * Math.exp(-sigma * k * k) * besselJ0(k * r);
  }
  return (sum * dk) / (2 * Math.PI);
}

/**
 * The (2P+1)² kernel, row-major, centre at index `(P*(2P+1) + P)`.
 * Convolving a height field with it (cell area 1 texel²) approximates
 * `D[h]` in per-texel units; divide by the cell size in metres for physical.
 *
 * Truncating at P drops the kernel's slow −1/(2πr³) tail, which leaves a DC
 * residual of ≈ 1/P: waves longer than ~2πP texels all see the same |k| and
 * so have zero group velocity (and a phase speed that *grows* with
 * wavelength — a moving source then radiates ahead of itself). `zeroMean`
 * removes that residual by subtracting a Gaussian blob (σ = P/2 texels) of
 * the same total, so D[const] = 0 again while the short-wave response is
 * untouched (taking it all from the centre tap would make the response
 * negative at the Nyquist and blow up). The price is a response that falls
 * off faster than |k| below k ≈ 1/P: long waves become slower and nearly
 * non-dispersive. For a boat wake that trades the Kelvin angle for a clean
 * trailing V.
 */
export function iwaveKernel(P = 6, sigma = 1, zeroMean = false): Float32Array {
  const W = 2 * P + 1;
  const out = new Float32Array(W * W);
  const cache = new Map<number, number>();
  for (let j = -P; j <= P; j++) {
    for (let i = -P; i <= P; i++) {
      const r2 = i * i + j * j;
      let g = cache.get(r2);
      if (g === undefined) {
        g = iwaveG(Math.sqrt(r2), sigma);
        cache.set(r2, g);
      }
      out[(j + P) * W + (i + P)] = g;
    }
  }
  if (zeroMean) {
    let sum = 0;
    for (const v of out) sum += v;
    const s2 = (P / 2) ** 2;
    const blob = new Float32Array(W * W);
    let blobSum = 0;
    for (let j = -P; j <= P; j++) {
      for (let i = -P; i <= P; i++) {
        const w = Math.exp(-(i * i + j * j) / (2 * s2));
        blob[(j + P) * W + (i + P)] = w;
        blobSum += w;
      }
    }
    for (let n = 0; n < out.length; n++) out[n] = (out[n] as number) - (sum * (blob[n] as number)) / blobSum;
    // The truncated kernel's response dips a hair below zero at the Nyquist
    // (≈ −0.008 at P=6), a negative stiffness that would slowly grow a
    // checkerboard. A pinch of discrete Laplacian (response 1 − ½(cos kx +
    // cos ky) ≥ 0, zero at DC) lifts it back above zero.
    const c = P * W + P;
    const eps = 0.012;
    out[c] = (out[c] as number) + eps;
    for (const n of [c - 1, c + 1, c - W, c + W]) out[n] = (out[n] as number) - eps * 0.25;
  }
  return out;
}
