#!/usr/bin/env node
/**
 * Build `public/assets/models/galleon.glb` from Daniel Quevedo's CC0
 * "Pirate Ship" (OpenGameArt, GalleonOGA.obj). The OBJ is one untextured
 * mesh; this splits it into connected components and classifies each as
 * hull / spar / sail / iron (cannon) by shape so the app can dress the parts
 * with its procedural wood, canvas and rope materials. Box-projected UVs
 * are generated per part (the OBJ's smart-projected UVs seam badly).
 *
 *   node scripts/buildShipAsset.mjs <GalleonOGA.obj> [--stats]
 *
 * Output axes: x starboard, y up, z aft (the ship sails toward −z), 1 unit
 * = 1 m, ~40 m on deck, the waterline at y = 0.
 */
import fs from "node:fs";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { dedup, prune, weld } from "@gltf-transform/functions";

const [, , objPath, ...flags] = process.argv;
if (!objPath) {
  console.error("usage: node scripts/buildShipAsset.mjs <GalleonOGA.obj> [--stats]");
  process.exit(2);
}
const stats = flags.includes("--stats");
const out = path.resolve("public/assets/models/galleon.glb");

// ------------------------------------------------------------------ parse

const V = [];
const VN = [];
const tris = []; // [ [vi, ni], [vi, ni], [vi, ni] ]
for (const line of fs.readFileSync(objPath, "utf8").split("\n")) {
  const p = line.trim().split(/\s+/);
  if (p[0] === "v") V.push([+p[1], +p[2], +p[3]]);
  else if (p[0] === "vn") VN.push([+p[1], +p[2], +p[3]]);
  else if (p[0] === "f") {
    const corners = p.slice(1).map((c) => {
      const [v, , n] = c.split("/");
      return [+v - 1, n ? +n - 1 : -1];
    });
    for (let i = 1; i + 1 < corners.length; i++) tris.push([corners[0], corners[i], corners[i + 1]]);
  }
}

// ---------------------------------------------------- connected components

const parent = V.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
const union = (a, b) => (parent[find(a)] = find(b));
for (const t of tris) {
  union(t[0][0], t[1][0]);
  union(t[0][0], t[2][0]);
}
const comps = new Map();
for (const t of tris) {
  const r = find(t[0][0]);
  if (!comps.has(r)) comps.set(r, []);
  comps.get(r).push(t);
}

// ---------------------------------------------------------------- classify

function bbox(faces) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const t of faces)
    for (const [vi] of t)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], V[vi][k]);
        mx[k] = Math.max(mx[k], V[vi][k]);
      }
  return { mn, mx, size: mx.map((m, k) => m - mn[k]) };
}

/** Sum of |normal| per axis, area-weighted: which way a part mostly faces. */
function facing(faces) {
  const acc = [0, 0, 0];
  for (const t of faces) {
    const a = V[t[0][0]];
    const b = V[t[1][0]];
    const c = V[t[2][0]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (let k = 0; k < 3; k++) acc[k] += Math.abs(n[k]) * 0.5;
  }
  const s = acc[0] + acc[1] + acc[2] || 1;
  return acc.map((a) => a / s);
}

const parts = [];
let hullRoot = null;
let hullTris = 0;
for (const [root, faces] of comps) {
  if (faces.length > hullTris) {
    hullTris = faces.length;
    hullRoot = root;
  }
}
for (const [root, faces] of comps) {
  const b = bbox(faces);
  const f = facing(faces);
  const [sx, sy, sz] = b.size;
  const sorted = [sx, sy, sz].slice().sort((p, q) => q - p);
  void sx;
  void sz;
  let kind;
  if (root === hullRoot) kind = "hull";
  else if (faces.length >= 200 && f[2] > 0.5) kind = "sail"; // bellied square sails
  else if (faces.length <= 24) kind = "iron"; // cannon barrels and carriages
  else if (b.mn[1] < 1) kind = "hull"; // rudder
  else if (sorted[0] >= 20 && faces.length < 100) kind = "spar"; // yards, bowsprit
  else if (sy >= 25) kind = "spar"; // masts
  else if (b.mn[1] > 10) kind = "spar"; // tops
  else kind = "hull";
  parts.push({ root, faces, kind, bbox: b, facing: f });
}

if (stats) {
  for (const p of parts.sort((a, b) => b.faces.length - a.faces.length)) {
    const s = p.bbox.size.map((v) => v.toFixed(1)).join("×");
    const f = p.facing.map((v) => v.toFixed(2)).join(",");
    console.log(`${p.kind.padEnd(5)} tris=${String(p.faces.length).padStart(5)} size=${s} min=${p.bbox.mn.map((v) => v.toFixed(1)).join(",")} facing=${f}`);
  }
}

// --------------------------------------------------------------- transform

// Fit: ~40 m on deck. The OBJ's z range includes the bowsprit; take the hull
// component's z extent as the deck length. Its lowest point is the keel.
const hull = parts.find((p) => p.kind === "hull" && p.root === hullRoot);
const hb = hull.bbox;
const hullLen = hb.size[2];
const SCALE = 40 / hullLen;
// The waterline: the hull's keel sits DRAFT below y = 0.
const DRAFT = 3;
const keelY = hb.mn[1];
const cz = (hb.mn[2] + hb.mx[2]) / 2;
const cx = (hb.mn[0] + hb.mx[0]) / 2;
// The OBJ's bow points toward −z? The bowsprit (longest thin spar) tells us.
const sprit = parts.filter((p) => p.kind === "spar").sort((a, b) => b.bbox.size[2] - a.bbox.size[2])[0];
const bowNeg = sprit ? (sprit.bbox.mn[2] + sprit.bbox.mx[2]) / 2 < cz : true;
const zSign = bowNeg ? 1 : -1;

function xform([x, y, z]) {
  return [(x - cx) * SCALE * zSign, (y - keelY) * SCALE - DRAFT, (z - cz) * SCALE * zSign];
}

// ------------------------------------------------------------------- write

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene("Galleon");
const rootNode = doc.createNode("Galleon");
scene.addChild(rootNode);

const KINDS = ["hull", "spar", "sail", "iron"];
const materials = Object.fromEntries(
  KINDS.map((k) => [
    k,
    doc
      .createMaterial(k)
      .setBaseColorFactor(k === "sail" ? [0.92, 0.9, 0.82, 1] : k === "iron" ? [0.12, 0.12, 0.13, 1] : k === "spar" ? [0.35, 0.24, 0.14, 1] : [0.6, 0.42, 0.24, 1])
      .setRoughnessFactor(0.85)
      .setMetallicFactor(0)
      .setDoubleSided(k === "sail"),
  ]),
);

for (const kind of KINDS) {
  const faces = parts.filter((p) => p.kind === kind).flatMap((p) => p.faces);
  if (!faces.length) continue;
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  for (const t of faces) {
    for (const [vi, ni] of t) {
      const p = xform(V[vi]);
      pos.push(...p);
      const n = ni >= 0 ? VN[ni] : [0, 1, 0];
      nrm.push(n[0] * zSign, n[1], n[2] * zSign);
      // Box-projected UVs, one tile per TILE metres, so the planking
      // repeats at a real scale: side faces use (z, y), decks (x, z), ends (x, y).
      const TILE = kind === "sail" ? 10 : 4;
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      if (kind === "sail" || (az >= ax && az >= ay)) uv.push(p[0] / TILE, p[1] / TILE);
      else if (ax >= ay) uv.push(p[2] / TILE, p[1] / TILE);
      else uv.push(p[0] / TILE, p[2] / TILE);
      idx.push(idx.length);
    }
  }
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nrm)).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(idx)).setBuffer(buffer))
    .setMaterial(materials[kind]);
  const mesh = doc.createMesh(kind).addPrimitive(prim);
  rootNode.addChild(doc.createNode(kind).setMesh(mesh));
}

await doc.transform(weld(), dedup(), prune({ keepAttributes: true }));
fs.mkdirSync(path.dirname(out), { recursive: true });
const io = new NodeIO();
await io.write(out, doc);
const bytes = fs.statSync(out).size;
console.log(`wrote ${out} (${(bytes / 1024).toFixed(0)} KB, ${tris.length} tris, ${parts.length} parts, scale ${SCALE.toFixed(3)}, bow ${bowNeg ? "-z" : "+z"} → -z)`);
