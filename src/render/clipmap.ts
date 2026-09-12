/**
 * Clipmap mesh (spec §1.8): a dense centre grid plus concentric rings, each
 * ring at half the resolution of the one inside. The whole thing follows the
 * camera in grid-snapped steps; the vertex shader displaces it.
 *
 * Seams: the odd vertices on the outer edge of level r do not exist on level
 * r+1. They carry a `seam` attribute (the tangent step to their two even
 * neighbours) so the vertex shader can average the neighbours' displacement
 * instead of sampling its own — no T-junction cracks, no skirts. The `ring`
 * attribute is the level whose cell the shader uses to drop cascades too
 * fine for the vertex; on the outer edge of level r it is r+1, so every
 * vertex there (and the neighbours a seam vertex averages) sums exactly the
 * cascades the coincident level-r+1 vertex sums.
 */
import * as THREE from "three";

/**
 * @param segments cells per side of each level (multiple of 4)
 * @param rings    number of rings around the centre grid
 * @param baseCell cell size of the centre grid in metres
 *
 * Level r (0 = centre) has cell `baseCell·2^r` and half-extent
 * `segments/2 · baseCell · 2^r`. Attributes: `position` (x, 0, z),
 * `ring` (float level for the cascade cell weight; r+1 on the outer edge of
 * level r < rings), `seam` (vec2, zero for non-seam vertices).
 */
export function clipmapGeometry(segments: number, rings: number, baseCell: number): THREE.BufferGeometry {
  if (segments % 4 !== 0 || segments < 4) throw new Error("clipmap: segments must be a multiple of 4");

  const positions: number[] = [];
  const ringAttr: number[] = [];
  const seams: number[] = [];
  const indices: number[] = [];

  const half = segments / 2;
  const holeLo = segments / 4;
  const holeHi = segments - segments / 4;

  for (let r = 0; r <= rings; r++) {
    const cell = baseCell * 2 ** r;
    const base = positions.length / 3;
    const hasSeam = r < rings;

    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        positions.push((i - half) * cell, 0, (j - half) * cell);

        let sx = 0;
        let sz = 0;
        const onX = i === 0 || i === segments;
        const onZ = j === 0 || j === segments;
        const onEdge = onX || onZ;
        if (hasSeam) {
          if (onX && j % 2 === 1) sz = cell; // vertical edge: neighbours along z
          else if (onZ && i % 2 === 1) sx = cell; // horizontal edge: neighbours along x
        }
        ringAttr.push(hasSeam && onEdge ? r + 1 : r);
        seams.push(sx, sz);
      }
    }

    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        if (r > 0 && i >= holeLo && i < holeHi && j >= holeLo && j < holeHi) continue;
        const a = base + j * (segments + 1) + i;
        const b = a + 1;
        const c = a + segments + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("ring", new THREE.Float32BufferAttribute(ringAttr, 1));
  geo.setAttribute("seam", new THREE.Float32BufferAttribute(seams, 2));
  geo.setIndex(indices);
  // The vertex shader moves everything; make culling a non-issue.
  const extent = half * baseCell * 2 ** rings;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), extent * 2);
  return geo;
}

/** Snap a camera xz to the clipmap lattice so the grid never swims. */
export function snapCamera(x: number, z: number, cell: number): [number, number] {
  return [Math.floor(x / cell) * cell, Math.floor(z / cell) * cell];
}

/** Total half-extent of a clipmap in metres. */
export function clipmapExtent(segments: number, rings: number, baseCell: number): number {
  return (segments / 2) * baseCell * 2 ** rings;
}
