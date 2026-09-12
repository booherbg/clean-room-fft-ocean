/**
 * Seeded pseudo-random numbers for the initial spectrum.
 *
 * Tessendorf (2001, eq. 41) draws the Gaussian pair (ξr, ξi) per wavevector
 * from N(0,1). We need the draw to be *reproducible* so that two runs with the
 * same `seed` give the same sea (and so the CPU oracle and the GPU spectrum
 * pass can agree bit-for-bit on the random input).
 */

/**
 * splitmix32 — a small, fast 32-bit generator with good statistical quality.
 * Returns a closure producing uniform doubles in [0, 1).
 */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

/**
 * Box–Muller transform: two independent uniforms → two independent N(0,1)
 * samples. The first uniform is nudged away from 0 so `log` never sees 0.
 */
export function gaussianPair(rng: () => number): [number, number] {
  const u1 = 1 - rng(); // (0, 1]
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}
