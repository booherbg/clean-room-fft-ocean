/**
 * Where the island's dressing goes (spec §1.15): palms on the beach ring,
 * rocks at the waterline. Pure and deterministic per seed so the placement
 * can be unit-tested and the scene is the same on every load. Coordinates
 * are island-local (the island centred on the origin); `render/vegetation.ts`
 * offsets them by the terrain's world position.
 *
 * Palms: rejection-sampled inside the coastline where the terrain is
 * `PALM_HEIGHT_RANGE` above sea level (the backshore behind the beach) and
 * the slope is gentle, with a minimum spacing so they read as a fringe
 * rather than a clump. Rocks: the same, on the foreshore around sea level,
 * where the water shader's shoreline foam will break around them.
 */
import { ISLAND_RADIUS, islandHeight } from "../core/terrain";

export interface Placement {
  x: number;
  z: number;
  /** Terrain height at (x, z), metres. */
  y: number;
  /** Rotation about y, radians. */
  yaw: number;
  /** Uniform scale factor around 1. */
  scale: number;
  /** Lean direction (radians) and amount (0..1), for palms bending seaward. */
  lean: number;
  leanAmount: number;
}

export interface PlacementOptions {
  count: number;
  /** Accepted terrain-height band, metres. */
  heightRange: [number, number];
  /** Maximum |gradient| (rise over run). */
  maxSlope: number;
  /** Minimum distance between placements, metres. */
  spacing: number;
  scaleRange: [number, number];
  /** Sampling radius around the island centre, metres. */
  radius?: number;
  /** Give up after this many candidates (keeps the loop bounded on odd seeds). */
  maxTries?: number;
}

export const PALM_HEIGHT_RANGE: [number, number] = [1.5, 8];
export const ROCK_HEIGHT_RANGE: [number, number] = [-0.6, 1.2];

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** |∇h| at (x, z) by central differences over 1 m. */
export function terrainSlope(x: number, z: number, seed: number): number {
  const dx = islandHeight(x + 1, z, seed) - islandHeight(x - 1, z, seed);
  const dz = islandHeight(x, z + 1, seed) - islandHeight(x, z - 1, seed);
  return Math.hypot(dx, dz) / 2;
}

/** Sample placements meeting the option's terrain criteria. */
export function placeOnTerrain(seed: number, opts: PlacementOptions): Placement[] {
  const random = rng(seed * 7919 + 13);
  const radius = opts.radius ?? ISLAND_RADIUS + 60;
  const maxTries = opts.maxTries ?? opts.count * 400;
  const out: Placement[] = [];
  const [hMin, hMax] = opts.heightRange;
  for (let tries = 0; tries < maxTries && out.length < opts.count; tries++) {
    const r = radius * Math.sqrt(random());
    const a = random() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = islandHeight(x, z, seed);
    if (y < hMin || y > hMax) continue;
    if (terrainSlope(x, z, seed) > opts.maxSlope) continue;
    let crowded = false;
    for (const p of out) {
      if (Math.hypot(p.x - x, p.z - z) < opts.spacing) {
        crowded = true;
        break;
      }
    }
    if (crowded) continue;
    // Lean seaward (down the gradient), the amount random.
    const gx = islandHeight(x + 1, z, seed) - islandHeight(x - 1, z, seed);
    const gz = islandHeight(x, z + 1, seed) - islandHeight(x, z - 1, seed);
    out.push({
      x,
      z,
      y,
      yaw: random() * Math.PI * 2,
      scale: opts.scaleRange[0] + (opts.scaleRange[1] - opts.scaleRange[0]) * random(),
      lean: Math.atan2(-gz, -gx),
      leanAmount: 0.3 + 0.7 * random(),
    });
  }
  return out;
}

export function placePalms(seed: number, count = 40): Placement[] {
  return placeOnTerrain(seed, { count, heightRange: PALM_HEIGHT_RANGE, maxSlope: 0.35, spacing: 7, scaleRange: [0.8, 1.25] });
}

export function placeRocks(seed: number, count = 15): Placement[] {
  return placeOnTerrain(seed, { count, heightRange: ROCK_HEIGHT_RANGE, maxSlope: 1, spacing: 12, scaleRange: [0.6, 1.6] });
}
