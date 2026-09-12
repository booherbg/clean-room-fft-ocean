/**
 * CPU height sampler for the hull. Each frame reads back a block of every
 * cascade's displacement texture around the probe and sums the bilinear
 * samples the way the vertex shader does (all cascades at full weight — the
 * hull is always near the camera on the finest ring).
 *
 * The readback is asynchronous with one frame of latency (`HeightReadback.
 * issueDisplacementBlock` / `consumeDisplacementBlock`, a PBO and a fence
 * per block): `update` first consumes the blocks it requested on the
 * previous frame, then issues this frame's. `heightAt` therefore answers
 * from a surface one frame old — a hull moves well under a texel in that
 * time — and the CPU never waits for the GPU to drain the previous frame.
 *
 * The block is 4×4 texels for a point probe; `update(x, z, radius)` grows it
 * per cascade to cover a footprint (the ship's hull samples, spec §1.9). A
 * cascade whose tile is far smaller than the footprint (the cm-ripple tile
 * under a 40 m ship) is skipped rather than read whole — its waves are
 * below what a hull answers to. Blocks straddling the tile edge are read in
 * up to four pieces so the tile's periodic wrap is honoured.
 *
 * The mesh is displaced horizontally too, so `heightAt(x, z)` inverts the
 * displacement with two fixed-point iterations: p ← (x,z) − D(p).xz.
 *
 * `heightAt` outside the block clamps to its edge texels and answers with
 * the wrong height; `covers(x, z)` says whether a point is inside. A second
 * probe (the camera while the hull owns this one) is a second `Buoyancy`
 * with its own `slotBase` so the two never share readback slots.
 */
import type { CascadeProvider, HeightReadback } from "../render/cascadeTextures";

/** What a `Buoyancy` needs from the sim. */
export type BuoyancySource = Pick<CascadeProvider, "cascades"> &
  Pick<HeightReadback, "issueDisplacementBlock" | "consumeDisplacementBlock">;

const BLOCK = 4;
/** Largest block side we are willing to read back per cascade per frame. */
const MAX_BLOCK = 96;

/** Readback slots per cascade: one per wrap piece (≤ 2 × 2). */
const SLOTS_PER_CASCADE = 4;

interface Block {
  /** Unwrapped texel origin (may be negative or beyond N; wrap on read). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Float32Array;
  N: number;
  size: number;
}

/** A block requested last frame: its geometry and the slots its pieces went to. */
interface Request {
  x0: number;
  y0: number;
  w: number;
  h: number;
  N: number;
  size: number;
  pieces: { slot: number; sx: Span; sy: Span }[];
}

export interface SurfaceSample {
  height: number;
  /** Horizontal displacement at the (undisplaced) sample point. */
  dx: number;
  dz: number;
}

export class Buoyancy {
  private blocks: Block[] = [];
  private requests: Request[] = [];
  /** Stitch buffers for multi-piece blocks, reused across frames (one per cascade). */
  private readonly stitch: Float32Array[] = [];
  private lastFrameX = NaN;
  private lastFrameZ = NaN;
  private readonly scratch: SurfaceSample = { height: 0, dx: 0, dz: 0 };
  private readonly slotBase: number;

  constructor(
    private readonly sim: BuoyancySource,
    options: { slotBase?: number } = {},
  ) {
    this.slotBase = options.slotBase ?? 0;
  }

  /**
   * Consume the blocks requested on the previous frame, then request the
   * blocks around (x, z) for the next one. Call once per frame before
   * `heightAt`. `radius` (m) widens the blocks to cover a footprint.
   */
  update(x: number, z: number, radius = 0): void {
    this.lastFrameX = x;
    this.lastFrameZ = z;
    this.blocks.length = 0;
    for (const r of this.requests) {
      const data = this.assemble(r);
      if (data) this.blocks.push({ x0: r.x0, y0: r.y0, w: r.w, h: r.h, data, N: r.N, size: r.size });
    }
    this.requests.length = 0;
    this.sim.cascades.forEach((c, i) => {
      const { N, size } = c;
      const texelSize = size / N;
      let side = BLOCK;
      if (radius > 0) {
        side = Math.ceil((2 * radius) / texelSize) + BLOCK;
        if (side > MAX_BLOCK) return;
        side = Math.min(side, N);
      }
      const [tx, ty] = texel(x, z, N, size);
      const x0 = Math.floor(tx) - (side >> 1) + 1;
      const y0 = Math.floor(ty) - (side >> 1) + 1;
      const xs = spans(x0, side, N);
      const ys = spans(y0, side, N);
      const pieces: Request["pieces"] = [];
      let slot = this.slotBase + i * SLOTS_PER_CASCADE;
      for (const sy of ys) {
        for (const sx of xs) {
          this.sim.issueDisplacementBlock(slot, i, sx.start, sy.start, sx.len, sy.len);
          pieces.push({ slot: slot++, sx, sy });
        }
      }
      this.requests.push({ x0, y0, w: side, h: side, N, size, pieces });
    });
  }

  /** Gather a request's pieces into one w×h block (null if any piece is missing). */
  private assemble(r: Request): Float32Array | null {
    if (r.pieces.length === 1) return this.sim.consumeDisplacementBlock(r.pieces[0]!.slot);
    const cascade = Math.floor(r.pieces[0]!.slot / SLOTS_PER_CASCADE);
    const need = r.w * r.h * 4;
    let out = this.stitch[cascade];
    if (!out || out.length !== need) {
      out = new Float32Array(need);
      this.stitch[cascade] = out;
    }
    for (const p of r.pieces) {
      const part = this.sim.consumeDisplacementBlock(p.slot);
      if (!part) return null;
      const { sx, sy } = p;
      for (let row = 0; row < sy.len; row++) {
        const src = row * sx.len * 4;
        const dst = ((sy.offset + row) * r.w + sx.offset) * 4;
        out.set(part.subarray(src, src + sx.len * 4), dst);
      }
    }
    return out;
  }

  /**
   * True when every block read this frame contains the texels bilinear
   * sampling at (x, z) needs (the undisplaced point; horizontal
   * displacement moves it by well under a block). False before the first
   * readback lands.
   */
  covers(x: number, z: number): boolean {
    if (this.blocks.length === 0) return false;
    for (const b of this.blocks) {
      const fx = (x / b.size - Math.floor(x / b.size)) * b.N - 0.5;
      const fy = (z / b.size - Math.floor(z / b.size)) * b.N - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const bx = (((ix - b.x0) % b.N) + b.N) % b.N;
      const by = (((iy - b.y0) % b.N) + b.N) % b.N;
      if (bx + 1 > b.w - 1 || by + 1 > b.h - 1) return false;
    }
    return true;
  }

  /** Water height at world (x, z), inverting horizontal displacement. */
  heightAt(x: number, z: number): number {
    if (this.blocks.length === 0) return 0;
    let px = x;
    let pz = z;
    const s = this.scratch;
    for (let i = 0; i < 2; i++) {
      this.sampleAt(px, pz, s);
      px = x - s.dx;
      pz = z - s.dz;
    }
    return this.sampleAt(px, pz, s).height;
  }

  /** Raw displacement sum at the undisplaced point (px, pz), written into `out` (a fresh object by default). */
  sampleAt(px: number, pz: number, out: SurfaceSample = { height: 0, dx: 0, dz: 0 }): SurfaceSample {
    let h = 0;
    let dx = 0;
    let dz = 0;
    for (const b of this.blocks) {
      // Continuous texel coordinates on the tile, minus the half-texel centre offset.
      const fx = (px / b.size - Math.floor(px / b.size)) * b.N - 0.5;
      const fy = (pz / b.size - Math.floor(pz / b.size)) * b.N - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const wx = fx - ix;
      const wy = fy - iy;
      const i00 = index(b, ix, iy);
      const i10 = index(b, ix + 1, iy);
      const i01 = index(b, ix, iy + 1);
      const i11 = index(b, ix + 1, iy + 1);
      const d = b.data;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;
      dx += d[i00]! * w00 + d[i10]! * w10 + d[i01]! * w01 + d[i11]! * w11;
      h += d[i00 + 1]! * w00 + d[i10 + 1]! * w10 + d[i01 + 1]! * w01 + d[i11 + 1]! * w11;
      dz += d[i00 + 2]! * w00 + d[i10 + 2]! * w10 + d[i01 + 2]! * w01 + d[i11 + 2]! * w11;
    }
    out.height = h;
    out.dx = dx;
    out.dz = dz;
    return out;
  }

  /** Last probe position handed to `update`. */
  get probe(): [number, number] {
    return [this.lastFrameX, this.lastFrameZ];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Span {
  /** Texel start inside the tile. */
  start: number;
  len: number;
  /** Offset inside the output block. */
  offset: number;
}

/** Split the unwrapped texel range [a, a+len) into in-tile spans. */
function spans(a: number, len: number, N: number): Span[] {
  const start = ((a % N) + N) % N;
  if (start + len <= N) return [{ start, len, offset: 0 }];
  const first = N - start;
  return [
    { start, len: first, offset: 0 },
    { start: 0, len: len - first, offset: first },
  ];
}

/** Continuous texel coordinates of world (x, z) on an N-texel tile of `size` m. */
function texel(x: number, z: number, N: number, size: number): [number, number] {
  const u = x / size - Math.floor(x / size);
  const v = z / size - Math.floor(z / size);
  return [u * N, v * N];
}

/** Float index of texel (ix, iy)'s RGBA in the block, wrapping the tile and clamping to the block. */
function index(b: Block, ix: number, iy: number): number {
  const x = clamp((((ix - b.x0) % b.N) + b.N) % b.N, 0, b.w - 1);
  const y = clamp((((iy - b.y0) % b.N) + b.N) % b.N, 0, b.h - 1);
  return (y * b.w + x) * 4;
}
