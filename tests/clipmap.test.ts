import { describe, expect, it } from "vitest";
import { clipmapExtent, clipmapGeometry, snapCamera } from "../src/render/clipmap";

interface Vertex {
  x: number;
  z: number;
  ring: number;
  seam: [number, number];
}

function vertices(segments: number, rings: number, baseCell: number): Vertex[] {
  const geo = clipmapGeometry(segments, rings, baseCell);
  const pos = geo.getAttribute("position");
  const ring = geo.getAttribute("ring");
  const seam = geo.getAttribute("seam");
  // Only vertices some triangle references (the hole interiors of the rings
  // are laid out but never indexed).
  const used = new Set<number>(Array.from(geo.getIndex()!.array));
  const out: Vertex[] = [];
  for (let i = 0; i < pos.count; i++) {
    if (!used.has(i)) continue;
    out.push({ x: pos.getX(i), z: pos.getZ(i), ring: ring.getX(i), seam: [seam.getX(i), seam.getY(i)] });
  }
  return out;
}

const key = (x: number, z: number) => `${x.toFixed(6)},${z.toFixed(6)}`;

describe("clipmapGeometry", () => {
  it("rejects segment counts that are not a multiple of 4", () => {
    expect(() => clipmapGeometry(6, 1, 1)).toThrow();
  });

  it("levels nest: level r has cell baseCell·2^r and extent segments/2 · cell", () => {
    const vs = vertices(8, 3, 2);
    for (let r = 0; r <= 3; r++) {
      const cell = 2 * 2 ** r;
      const onLevel = vs.filter((v) => Math.abs(v.x) <= 4 * cell + 1e-9 && Math.abs(v.z) <= 4 * cell + 1e-9);
      // Every lattice point of the level outside its hole is present.
      for (let j = -4; j <= 4; j++)
        for (let i = -4; i <= 4; i++) {
          if (r > 0 && Math.abs(i) < 2 && Math.abs(j) < 2) continue;
          expect(onLevel.some((v) => v.x === i * cell && v.z === j * cell)).toBe(true);
        }
    }
    expect(clipmapExtent(8, 3, 2)).toBe(4 * 2 * 8);
  });

  it("seam vertices' neighbours coincide with vertices of the next level", () => {
    const vs = vertices(8, 3, 1);
    const at = new Set(vs.map((v) => key(v.x, v.z)));
    const seams = vs.filter((v) => v.seam[0] !== 0 || v.seam[1] !== 0);
    expect(seams.length).toBeGreaterThan(0);
    for (const v of seams) {
      expect(at.has(key(v.x + v.seam[0], v.z + v.seam[1]))).toBe(true);
      expect(at.has(key(v.x - v.seam[0], v.z - v.seam[1]))).toBe(true);
    }
    // The outermost ring carries no seams (nothing coarser to meet).
    const cellOut = 2 ** 3;
    for (const v of vs) {
      if (Math.abs(v.x) === 4 * cellOut || Math.abs(v.z) === 4 * cellOut) expect(v.seam).toEqual([0, 0]);
    }
  });

  it("coincident vertices of neighbouring levels carry the same cell (ring) value — no weight mismatch at seams", () => {
    // The vertex shader drops cascades by the vertex's cell; two vertices at
    // the same world xz with different cells would sum different cascade
    // sets and open a crack. So a level's outer edge takes the coarser
    // level's cell, as do the seam vertices' neighbours it averages.
    const vs = vertices(8, 3, 1);
    const byPos = new Map<string, number[]>();
    for (const v of vs) {
      const k = key(v.x, v.z);
      byPos.set(k, [...(byPos.get(k) ?? []), v.ring]);
    }
    let shared = 0;
    for (const rings of byPos.values()) {
      if (rings.length > 1) {
        shared++;
        expect(new Set(rings).size).toBe(1);
      }
    }
    expect(shared).toBeGreaterThan(0);
    // And the outer edge of level 0 (cell 1, extent 4) reads as level 1.
    for (const v of vs) {
      const onEdge0 = Math.max(Math.abs(v.x), Math.abs(v.z)) === 4 && Number.isInteger(v.x) && Number.isInteger(v.z);
      if (onEdge0 && v.seam[0] === 0 && v.seam[1] === 0 && v.ring < 2) expect(v.ring).toBe(1);
    }
  });
});

describe("snapCamera", () => {
  it("snaps to the lattice", () => {
    expect(snapCamera(5.3, -2.1, 2)).toEqual([4, -4]);
  });
});
