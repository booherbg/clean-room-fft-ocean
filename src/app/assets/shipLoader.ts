/**
 * Loads the glTF galleon (`public/assets/models/galleon.glb`, see
 * `public/assets/LICENSES.md`) and dresses it with the shared procedural
 * ship materials (spec §1.15). The file's parts are named by
 * `scripts/buildShipAsset.mjs` — `hull`, `spar`, `sail`, `iron` — and the
 * loader maps each name to a material; anything unnamed keeps its own.
 *
 * The result is normalised: scaled so the hull is `targetLength` m long,
 * centred on x and z, and lifted so the keel sits `targetDraft` m below
 * y = 0 (the waterline). The hull's bounds after normalisation are returned
 * as `dims` so the buoyancy columns (`HullPhysics`) match the visual.
 *
 * Decoders: Meshopt is wired (a module import, no decoder path); Draco is
 * not, as it needs a served decoder directory and the shipped file is plain.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { HullDimensions } from "../ship/hullPhysics";
import type { ShipMaterials } from "./shipMaterials";

export type ShipModelKind = "gltf" | "procedural";

export interface LoadedShip {
  /** The dressed model, waterline at y = 0, bow toward −z, centred on the hull. */
  model: THREE.Group;
  /** Hull bounds after normalisation (length z, beam x, draft below y = 0). */
  dims: HullDimensions;
  /** Everything to dispose when the model is discarded. */
  dispose(): void;
}

export interface ShipLoadOptions {
  targetLength?: number;
  targetDraft?: number;
  /** Override the fetch (tests). */
  loader?: GLTFLoader;
}

export const SHIP_GLTF_URL = "assets/models/galleon.glb";

const PART_MATERIALS: Record<string, keyof Pick<ShipMaterials, "hull" | "spar" | "sail" | "iron" | "deck" | "rope">> = {
  hull: "hull",
  spar: "spar",
  sail: "sail",
  iron: "iron",
  deck: "deck",
  rope: "rope",
};

export function makeGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** Fetch, dress and normalise the galleon. Rejects on any load error (the caller falls back). */
export async function loadShipGltf(url: string, mats: ShipMaterials, opts: ShipLoadOptions = {}): Promise<LoadedShip> {
  const targetLength = opts.targetLength ?? 40;
  const targetDraft = opts.targetDraft ?? 3;
  const loader = opts.loader ?? makeGltfLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.name = "ShipGltf";

  const geometries: THREE.BufferGeometry[] = [];
  const own: THREE.Material[] = [];
  const hulls: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    geometries.push(o.geometry);
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = PART_MATERIALS[o.name] ?? PART_MATERIALS[mat?.name ?? ""];
    if (key) {
      if (mat) own.push(mat);
      o.material = mats[key];
    }
    if (o.name === "hull" || mat?.name === "hull") hulls.push(o);
    o.userData.castsWaterDepth = true;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  const hull = hulls[0];
  if (!hull) throw new Error(`ship glTF ${url}: no part named "hull"`);

  // Normalise on the hull's bounds: length along z, waterline at y = 0.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(hull);
  const size = box.getSize(new THREE.Vector3());
  if (!(size.z > 0)) throw new Error(`ship glTF ${url}: degenerate hull bounds`);
  const scale = targetLength / size.z;
  const model = new THREE.Group();
  model.name = "Ship";
  root.scale.setScalar(scale);
  root.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale - targetDraft, -((box.min.z + box.max.z) / 2) * scale);
  model.add(root);
  model.updateMatrixWorld(true);
  const dims: HullDimensions = { length: targetLength, beam: size.x * scale, draft: targetDraft };
  return {
    model,
    dims,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of own) m.dispose();
    },
  };
}

/** `?ship=procedural` (or `gltf`) in the URL; default gltf. */
export function requestedShipModel(search = typeof location !== "undefined" ? location.search : ""): ShipModelKind {
  return new URLSearchParams(search).get("ship") === "procedural" ? "procedural" : "gltf";
}
