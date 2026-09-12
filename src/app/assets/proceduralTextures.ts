/**
 * Procedural PBR textures for the ship and the island dressing, generated
 * once at startup (spec §1.15). Each generator is a pure function of its
 * size returning 8-bit RGBA planes (colour, roughness, normal) so it can be
 * unit-tested in Node; `toTextures` wraps them in `THREE.DataTexture`s.
 *
 *  - wood: planked timber — plank rows with staggered end joints, dark
 *    caulking seams, nail heads, per-plank tint and a stretched grain;
 *  - canvas: sailcloth — a fine weave, vertical panel seams with double
 *    stitching, a low-frequency stain, and a torn-edge alpha along the foot;
 *  - frond: one palm frond (alpha-tested plane) — a rib with leaflets;
 *  - rope: a twisted three-strand lay, for the reef lines and rigging.
 *
 * The normal maps come from the height field by central differences
 * (tangent space, +y up, so the maps are `normalScale`-able).
 */
import * as THREE from "three";
import { fbm, valueNoise } from "../../core/terrain";

export interface TexturePlanes {
  size: number;
  /** RGBA sRGB colour. */
  color: Uint8Array;
  /** Roughness in `.g` (three's convention), `.b` = metalness (0). */
  roughness: Uint8Array;
  /** Tangent-space normal, 0–255 encoded. */
  normal: Uint8Array;
}

function hash(i: number, j: number, seed: number): number {
  return valueNoise(i * 7.31 + 0.5, j * 3.17 + 0.5, seed);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function normalFromHeight(height: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const l = height[j * size + ((i - 1 + size) % size)]!;
      const r = height[j * size + ((i + 1) % size)]!;
      const d = height[((j - 1 + size) % size) * size + i]!;
      const u = height[((j + 1) % size) * size + i]!;
      let nx = -(r - l) * strength;
      let ny = -(u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (j * size + i) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

function planes(size: number, color: Uint8Array, rough: Float32Array, height: Float32Array, normalStrength: number): TexturePlanes {
  const roughness = new Uint8Array(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    roughness[p * 4] = 255;
    roughness[p * 4 + 1] = Math.round(clamp01(rough[p]!) * 255);
    roughness[p * 4 + 2] = 0;
    roughness[p * 4 + 3] = 255;
  }
  return { size, color, roughness, normal: normalFromHeight(height, size, normalStrength) };
}

/**
 * Planked wood. The tile spans `metres` m; planks are `plankWidth` m wide,
 * `plankLength` m long with a half-stagger between rows. Rows run along u.
 */
export function woodPlanes(size = 512, opts: { metres?: number; plankWidth?: number; plankLength?: number; seed?: number; tint?: [number, number, number] } = {}): TexturePlanes {
  const metres = opts.metres ?? 4;
  const pw = opts.plankWidth ?? 0.32;
  const pl = opts.plankLength ?? 2;
  const seed = opts.seed ?? 3;
  const [tr, tg, tb] = opts.tint ?? [0.56, 0.38, 0.22];
  const rows = Math.max(1, Math.round(metres / pw));
  const cols = Math.max(1, Math.round(metres / pl));
  const color = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const pxM = metres / size; // metres per texel
  const seamW = Math.max(1.5 * pxM, 0.012); // caulking half-width, m
  for (let j = 0; j < size; j++) {
    const y = (j / size) * metres;
    const row = Math.floor((y / metres) * rows);
    const ry = y - (row * metres) / rows;
    const rowH = metres / rows;
    const stagger = (row % 2) * 0.5 + hash(row, 0, seed + 9) * 0.25;
    for (let i = 0; i < size; i++) {
      const x = (i / size) * metres;
      const xs = x + stagger * pl;
      const col = Math.floor(xs / pl);
      const cx = xs - col * pl;
      const plankId = hash(col, row, seed);
      // Grain: fBm stretched along the plank, plus fine streaks.
      const grain = fbm(x * 12 + plankId * 50, y * 1.6 + plankId * 20, seed + 1, 4);
      const streak = valueNoise(x * 60 + plankId * 90, y * 4, seed + 2);
      // Seams: distance to the row edge and the end joint.
      const dEdge = Math.min(ry, rowH - ry);
      const dEnd = Math.min(cx, pl - cx);
      const seam = Math.max(1 - dEdge / seamW, 1 - dEnd / seamW, 0);
      // Nail heads: two near each plank end, 6 cm in.
      let nail = 0;
      for (const ex of [0.06, pl - 0.06]) {
        for (const ey of [rowH * 0.28, rowH * 0.72]) {
          const dn = Math.hypot(cx - ex, ry - ey);
          nail = Math.max(nail, 1 - clamp01(dn / 0.014));
        }
      }
      const tint = 0.82 + 0.36 * plankId;
      const g = 0.82 + 0.28 * grain - 0.1 * streak;
      let r = tr * tint * g;
      let gg = tg * tint * g * (0.96 + 0.08 * grain);
      let b = tb * tint * g * (0.9 + 0.1 * grain);
      // Caulking is near-black tar; nails a dark grey.
      r = r * (1 - seam) + 0.05 * seam;
      gg = gg * (1 - seam) + 0.04 * seam;
      b = b * (1 - seam) + 0.03 * seam;
      r = r * (1 - nail) + 0.16 * nail;
      gg = gg * (1 - nail) + 0.15 * nail;
      b = b * (1 - nail) + 0.14 * nail;
      const o = (j * size + i) * 4;
      color[o] = Math.round(clamp01(r) * 255);
      color[o + 1] = Math.round(clamp01(gg) * 255);
      color[o + 2] = Math.round(clamp01(b) * 255);
      color[o + 3] = 255;
      rough[j * size + i] = 0.62 + 0.25 * grain + 0.3 * seam - 0.25 * nail;
      height[j * size + i] = 0.4 * plankId + 0.12 * grain - 0.8 * seam + 0.5 * nail;
    }
  }
  return planes(size, color, rough, height, 6);
}

/**
 * Sailcloth. The tile spans `metres` m; panels are `panel` m wide with a
 * double-stitched seam. Alpha is 1 except a ragged band along the bottom
 * `tearFraction` of the tile — sails whose UVs clamp there get a torn foot.
 */
export function canvasPlanes(size = 512, opts: { metres?: number; panel?: number; seed?: number; tearFraction?: number } = {}): TexturePlanes {
  const metres = opts.metres ?? 10;
  const panel = opts.panel ?? 0.6;
  const seed = opts.seed ?? 5;
  const tear = opts.tearFraction ?? 0;
  const color = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const panels = Math.max(1, Math.round(metres / panel));
  const pxM = metres / size;
  for (let j = 0; j < size; j++) {
    const y = (j / size) * metres;
    for (let i = 0; i < size; i++) {
      const x = (i / size) * metres;
      // Weave: warp × weft at ~2 mm; sampled at the texel it aliases into a
      // fine even grain, which is what canvas looks like from ten metres.
      const weave = 0.5 + 0.25 * Math.sin(x * 1900) * Math.sin(y * 1900) + 0.25 * valueNoise(i * 0.9, j * 0.9, seed);
      const stain = fbm(x * 0.35, y * 0.35, seed + 1, 4);
      const px = x - Math.floor(x / (metres / panels)) * (metres / panels);
      const pw = metres / panels;
      const dSeam = Math.min(px, pw - px);
      const seam = dSeam < 2.2 * pxM ? 1 : 0;
      const stitch = dSeam > 2.2 * pxM && dSeam < 4.5 * pxM ? 1 : 0;
      let r = 0.9 - 0.16 * stain + 0.05 * weave;
      let g = 0.87 - 0.2 * stain + 0.05 * weave;
      let b = 0.78 - 0.24 * stain + 0.05 * weave;
      const dark = 0.16 * seam + 0.07 * stitch;
      r -= dark;
      g -= dark;
      b -= dark;
      // Torn foot: a ragged alpha edge inside the bottom `tear` of the tile.
      let alpha = 1;
      if (tear > 0) {
        const edge = tear * (0.4 + 0.6 * fbm(x * 0.8, 0, seed + 7, 3)) * metres;
        alpha = y > metres - edge ? 0 : 1;
      }
      const o = (j * size + i) * 4;
      color[o] = Math.round(clamp01(r) * 255);
      color[o + 1] = Math.round(clamp01(g) * 255);
      color[o + 2] = Math.round(clamp01(b) * 255);
      color[o + 3] = Math.round(alpha * 255);
      rough[j * size + i] = 0.88 + 0.08 * weave;
      height[j * size + i] = 0.5 * weave + 0.8 * stitch - 0.3 * seam;
    }
  }
  return planes(size, color, rough, height, 2.5);
}

/** A three-strand rope lay along u; the tile is one lay period. */
export function ropePlanes(size = 64): TexturePlanes {
  const color = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const v = j / size;
      const strand = 0.5 + 0.5 * Math.cos((u * 3 - v) * Math.PI * 2);
      const fibre = valueNoise(i * 1.7, j * 0.4, 21);
      const shade = 0.55 + 0.45 * strand;
      const o = (j * size + i) * 4;
      color[o] = Math.round(clamp01((0.36 - 0.06 * fibre) * shade) * 255);
      color[o + 1] = Math.round(clamp01((0.28 - 0.05 * fibre) * shade) * 255);
      color[o + 2] = Math.round(clamp01((0.18 - 0.04 * fibre) * shade) * 255);
      color[o + 3] = 255;
      rough[j * size + i] = 0.9;
      height[j * size + i] = strand;
    }
  }
  return planes(size, color, rough, height, 4);
}

/**
 * One palm frond in a square: the rib runs from the bottom centre to the
 * top; leaflets fan out either side, thinning toward the tip. Alpha is the
 * leaf mask (alpha-test it); colour darkens along the rib.
 */
export function frondPlanes(size = 256, seed = 11): TexturePlanes {
  const color = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const leaflets = 22;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * 2 - 1; // −1..1 across
      const v = j / size; // 0 base → 1 tip
      const halfWidth = 0.9 * Math.sin(Math.PI * Math.min(1, v * 1.15 + 0.05)) * (1 - 0.35 * v);
      const rib = Math.abs(u) < 0.022 * (1 - 0.7 * v) + 0.004 && v < 0.98 ? 1 : 0;
      // Leaflets: sawtooth along v, angled toward the tip; gaps between them.
      const k = leaflets * v + Math.abs(u) * 3.2;
      const phase = k - Math.floor(k);
      const gap = phase < 0.22 ? 0 : 1;
      const within = Math.abs(u) < halfWidth ? 1 : 0;
      const droopTip = Math.abs(u) > halfWidth * (0.75 + 0.25 * valueNoise(k * 3, 0, seed)) ? 0 : 1;
      const leaf = within * gap * droopTip;
      const alpha = Math.max(rib, leaf);
      const shade = 0.55 + 0.45 * phase;
      const yellow = fbm(i * 0.05, j * 0.05, seed + 1, 3);
      const o = (j * size + i) * 4;
      color[o] = Math.round(clamp01((0.18 + 0.32 * yellow) * shade + 0.25 * rib) * 255);
      color[o + 1] = Math.round(clamp01((0.42 + 0.22 * yellow) * shade + 0.15 * rib) * 255);
      color[o + 2] = Math.round(clamp01((0.1 + 0.05 * yellow) * shade + 0.05 * rib) * 255);
      color[o + 3] = Math.round(alpha * 255);
      rough[j * size + i] = 0.55;
      height[j * size + i] = 0.6 * phase + 0.8 * rib;
    }
  }
  return planes(size, color, rough, height, 3);
}

export interface PbrTextures {
  map: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  dispose(): void;
}

/** Wrap planes in repeating, mipmapped `DataTexture`s (colour in sRGB). */
export function toTextures(p: TexturePlanes, opts: { repeat?: boolean; anisotropy?: number } = {}): PbrTextures {
  const make = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, p.size, p.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = opts.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = opts.anisotropy ?? 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const map = make(p.color, true);
  const roughnessMap = make(p.roughness, false);
  const normalMap = make(p.normal, false);
  return {
    map,
    roughnessMap,
    normalMap,
    dispose() {
      map.dispose();
      roughnessMap.dispose();
      normalMap.dispose();
    },
  };
}
