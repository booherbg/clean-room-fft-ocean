/**
 * Procedural island heightfield (spec §1.11). Pure TS, deterministic per
 * seed: `islandHeight(x, z, seed)` gives the terrain height in metres at a
 * point in island-local coordinates (the island is centred on the origin;
 * `src/render/terrain.ts` places it in the world).
 *
 * Shape, from the sea in:
 *  - a sandy shelf sloping out from the beach (1:8 to −6 m) to −10 m over ~150 m
 *    (the turquoise shallows), then dropping to −50 m by ~420 m out (below
 *    the water's virtual floor, so the seabed term in the water shader fades
 *    out continuously at the mesh edge);
 *  - a beach ring at sea level (foreshore 1:8, backshore 1:12, smooth: no
 *    noise so the shoreline foam band reads as one clean line);
 *  - fBm hills rising to a rocky peak of ~60 m near the centre;
 *  - two sea stacks off the coast.
 * The coastline itself is warped by low-frequency noise so it is not a circle.
 */

/** Nominal island radius (metres) at sea level, before the coastline warp. */
export const ISLAND_RADIUS = 175;
/** Peak height, metres. */
export const PEAK_HEIGHT = 60;

/** Sea stacks: island-local (x, z), radius and height in metres. */
export const SEA_STACKS: readonly { x: number; z: number; r: number; h: number }[] = [
  { x: 235, z: -70, r: 14, h: 20 },
  { x: -215, z: 120, r: 11, h: 15 },
];

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1] on the integer lattice, seeded. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** Fractional Brownian motion of `valueNoise`, normalised to [0, 1]. */
export function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, z, seed + o * 101) * amp;
    norm += amp;
    x = x * 2.03 + 17.1;
    z = z * 1.97 + 9.7;
    amp *= 0.5;
  }
  return sum / norm;
}

function smoothstep(a: number, b: number, x: number): number {
  return smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));
}

/**
 * Height (metres, sea level = 0) at island-local (x, z). Negative values are
 * seabed. Deterministic for a given seed.
 */
export function islandHeight(x: number, z: number, seed: number): number {
  const r = Math.hypot(x, z);
  // Coastline warp: push the shore in and out by up to ±45 m.
  const warp = (fbm(x * 0.006, z * 0.006, seed + 7, 3) - 0.5) * 90;
  const rw = r + warp;
  // Signed distance-ish to the nominal shoreline: negative inland.
  const out = rw - ISLAND_RADIUS;
  const inland = -out; // metres inside the shoreline

  // Shelf: the beach's 1:8 foreshore continues under water to ~5 m, then a
  // wide sandy shelf at −9 m (the turquoise shallows) out to ~280 m, then the
  // drop-off to −50 m by ~420 m out.
  let h: number;
  if (out > 0) {
    h = -Math.min(out / 8, 6) - 4 * smoothstep(0, 150, out) - 40 * smoothstep(280, 420, out);
  } else {
    const t = inland / ISLAND_RADIUS; // 0 at the shore, 1 at the centre
    // Foreshore 1:8 to 2.5 m, then the backshore eases to 1:12.
    const beach = Math.min(inland / 8, 2.5) + Math.max(inland - 20, 0) / 12;
    // Hills: fBm, fading in past the beach so the shore stays smooth.
    const n = fbm(x * 0.02, z * 0.02, seed, 5);
    const hills = 26 * (n - 0.35) * smoothstep(0.08, 0.35, t);
    // Peak: a broad dome to ~60 m with a rougher, steeper, craggy top.
    const crag = fbm(x * 0.05, z * 0.05, seed + 3, 4);
    const ridge = 1 - Math.abs(fbm(x * 0.03, z * 0.03, seed + 5, 3) * 2 - 1);
    const dome = PEAK_HEIGHT * Math.pow(Math.max(t, 0), 2.0) * (0.55 + 0.6 * crag + 0.35 * ridge);
    h = Math.min(beach, 6) + Math.max(beach - 6, 0) * 0.3 + hills + dome;
    // Land floor: the hills term is signed (n < 0.35 digs), so where the
    // beach is still low a hollow could cut under the sea and leave an
    // inland pool. Never below the first metre of foreshore.
    h = Math.max(h, Math.min(inland / 8, 1));
  }

  // Sea stacks: steep-sided noisy bumps.
  for (const s of SEA_STACKS) {
    const d = Math.hypot(x - s.x, z - s.z) / s.r;
    if (d < 2.5) {
      const rough = 0.8 + 0.4 * fbm(x * 0.15, z * 0.15, seed + 11, 3);
      const bump = s.h * rough * Math.exp(-d * d * d);
      h += bump;
    }
  }
  return h;
}

/**
 * Sample `islandHeight` on an N×N grid covering `extent` metres per side,
 * centred on the island; row-major, x fastest, z increasing with the row.
 */
export function sampleHeightmap(N: number, extent: number, seed: number): Float32Array {
  const out = new Float32Array(N * N);
  const step = extent / (N - 1);
  for (let j = 0; j < N; j++) {
    const z = -extent / 2 + j * step;
    for (let i = 0; i < N; i++) {
      const x = -extent / 2 + i * step;
      out[j * N + i] = islandHeight(x, z, seed);
    }
  }
  return out;
}
