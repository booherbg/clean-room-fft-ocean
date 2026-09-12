/**
 * Island dressing (spec §1.15): a palm fringe on the backshore and rocks at
 * the waterline, placed by `vegetationPlacement.ts` on the island's own
 * heightfield so nothing floats or sinks.
 *
 * Palms are one `InstancedMesh` per variant. They start procedural (a bent
 * tapered trunk and eight textured frond cards) so the island is dressed on
 * the first frame, and swap to the Kenney Nature Kit palms
 * (`public/assets/models/palm-*.glb`, CC0) once those load; a load failure
 * simply keeps the procedural set. Both are `MeshStandardMaterial` under
 * the scene's sun and hemisphere lights, with a wind sway injected into the
 * vertex shader (`onBeforeCompile`): the top of each palm swings with the
 * ocean's wind, the trunk base stays put.
 *
 * Rocks are noise-displaced icospheres merged into one mesh. Everything is
 * tagged `castsWaterDepth` so `ScenePass` writes it to the water's scene
 * depth (foam breaks around the rocks, reflections pick up the palms).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fbm } from "../core/terrain";
import { frondPlanes, toTextures, woodPlanes, type PbrTextures } from "../app/assets/proceduralTextures";
import { placePalms, placeRocks, type Placement } from "./vegetationPlacement";

export type PalmModelKind = "gltf" | "procedural";

export const PALM_GLTF_URLS = ["assets/models/palm-tall.glb", "assets/models/palm-short.glb", "assets/models/palm-bend.glb"];

export interface VegetationOptions {
  /** World position of the island centre (the terrain's position). */
  islandPosition: THREE.Vector3;
  palmCount?: number;
  rockCount?: number;
  /** Palm height, metres, for the tallest variant; others scale down. */
  palmHeight?: number;
  /** Provide a loader to fetch the glTF palms; omit to stay procedural. */
  loader?: GLTFLoader;
  palmUrls?: string[];
}

interface SwayUniforms {
  uTime: { value: number };
  uWind: { value: THREE.Vector2 };
}

/** Scale a palm geometry so its base is y = 0 and its top y = 1 (the sway shader reads y as the height fraction). */
function unitHeight(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const h = b.max.y - b.min.y || 1;
  g.translate(0, -b.min.y, 0);
  g.scale(1 / h, 1 / h, 1 / h);
  g.computeBoundingBox();
  return g;
}

/** A bent, tapered palm trunk: `segments` rings along a quadratic lean. */
function trunkGeometry(height: number, lean: number): THREE.BufferGeometry {
  const rings = 10;
  const around = 8;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const y = t * height;
    const bend = lean * t * t * height * 0.35;
    const radius = 0.32 * (1 - 0.55 * t) + (j === 0 ? 0.08 : 0);
    for (let i = 0; i <= around; i++) {
      const a = (i / around) * Math.PI * 2;
      pos.push(Math.cos(a) * radius + bend, y, Math.sin(a) * radius);
      nrm.push(Math.cos(a), 0.1, Math.sin(a));
      uv.push(i / around, t * height * 0.5);
    }
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < around; i++) {
      const a = j * (around + 1) + i;
      const b = a + around + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A frond: a strip reaching out along +x from the crown, arching up then drooping; uv v runs base → tip. */
function frondGeometry(length: number, width: number, droop: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(length, width, 8, 1);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) / length + 0.5; // 0 base → 1 tip
    const w = p.getY(i) * (0.6 + 0.8 * Math.sin(Math.PI * Math.min(1, t * 1.2))); // leaflets widen then taper
    const rise = 0.45 * length * Math.sin(Math.PI * t * 0.8) - droop * 0.55 * length * t * t;
    p.setXYZ(i, t * length, rise, w);
  }
  // Texture: u across the frond, v base → tip.
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, v, u);
  }
  g.computeVertexNormals();
  return g;
}

/** A procedural palm with material groups 0 = trunk, 1 = fronds; y up from the base. */
function proceduralPalm(height: number, lean: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [trunkGeometry(height, lean)];
  const crownX = lean * height * 0.35;
  const fronds = 12;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + fbm(i * 0.7, seed, seed, 2) * 0.6;
    const f = frondGeometry(height * 0.62, height * 0.18, 0.9 + 0.5 * fbm(i * 1.3, seed + 2, seed, 2));
    f.rotateZ(0.25 * (fbm(i * 2.1, seed + 4, seed, 2) - 0.5)); // a little random tilt
    f.rotateY(a);
    f.translate(crownX, height - 0.1, 0);
    parts.push(f);
  }
  const merged = mergeGeometries(parts, true);
  if (!merged) throw new Error("palm merge failed");
  // mergeGeometries makes one group per input; fold the fronds into group 1.
  merged.clearGroups();
  const trunkCount = parts[0]!.index!.count;
  let total = 0;
  for (const p of parts) total += p.index ? p.index.count : p.getAttribute("position").count;
  merged.addGroup(0, trunkCount, 0);
  merged.addGroup(trunkCount, total - trunkCount, 1);
  return merged;
}

/** A rock: icosphere displaced by fBm, flattened a little. */
function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = fbm(x * 1.5 + seed, z * 1.5 + y * 0.9, seed, 4);
    const r = 0.7 + 0.6 * n;
    p.setXYZ(i, x * r, y * r * 0.7, z * r);
  }
  g.computeVertexNormals();
  return g;
}

export class Vegetation extends THREE.Group {
  readonly islandPosition: THREE.Vector3;
  readonly palms: Placement[];
  readonly rocks: Placement[];
  palmModel: PalmModelKind = "procedural";
  /** Resolves when the glTF palms are in (or the fallback is final). */
  readonly ready: Promise<void>;
  private palmMeshes: THREE.InstancedMesh[] = [];
  private readonly rockMesh: THREE.Mesh;
  private readonly trunkMat: THREE.MeshStandardMaterial;
  private readonly frondMat: THREE.MeshStandardMaterial;
  private readonly gltfTrunkMat: THREE.MeshStandardMaterial;
  private readonly gltfFrondMat: THREE.MeshStandardMaterial;
  private readonly rockMat: THREE.MeshStandardMaterial;
  private readonly textures: PbrTextures[] = [];
  private readonly sway: SwayUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2() } };
  private readonly palmHeight: number;
  private disposed = false;

  constructor(seed: number, opts: VegetationOptions) {
    super();
    this.name = "Vegetation";
    this.islandPosition = opts.islandPosition.clone();
    this.position.copy(this.islandPosition);
    this.palmHeight = opts.palmHeight ?? 10;
    this.palms = placePalms(seed, opts.palmCount ?? 40);
    this.rocks = placeRocks(seed, opts.rockCount ?? 15);

    const bark = this.keep(toTextures(woodPlanes(256, { metres: 2, plankWidth: 0.12, plankLength: 0.5, seed: 21, tint: [0.5, 0.38, 0.26] })));
    const frond = this.keep(toTextures(frondPlanes(256), { repeat: false }));
    this.trunkMat = this.swayed(new THREE.MeshStandardMaterial({ name: "palm-trunk", map: bark.map, roughnessMap: bark.roughnessMap, normalMap: bark.normalMap, roughness: 1 }));
    this.frondMat = this.swayed(
      new THREE.MeshStandardMaterial({
        name: "palm-frond",
        map: frond.map,
        roughnessMap: frond.roughnessMap,
        normalMap: frond.normalMap,
        normalScale: new THREE.Vector2(0.5, 0.5),
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    );
    // The Kenney palms are flat-coloured (unlit in the file); give them lit
    // greens and bark that sit with the terrain's palette.
    this.gltfTrunkMat = this.swayed(new THREE.MeshStandardMaterial({ name: "palm-gltf-trunk", color: 0x9a7048, roughness: 1 }));
    this.gltfFrondMat = this.swayed(new THREE.MeshStandardMaterial({ name: "palm-gltf-frond", color: 0x4a8a34, roughness: 0.75, side: THREE.DoubleSide }));
    // Warm sandstone, as on a coral cay; flat-shaded so the facets catch the sun.
    this.rockMat = new THREE.MeshStandardMaterial({ name: "rock", color: 0x9c7d5a, roughness: 0.95, metalness: 0, flatShading: true });

    this.buildProceduralPalms(seed);
    this.rockMesh = this.buildRocks(seed);
    this.add(this.rockMesh);

    this.ready = opts.loader ? this.loadGltfPalms(opts.loader, opts.palmUrls ?? PALM_GLTF_URLS) : Promise.resolve();
  }

  /** Total palm instances in the scene. */
  get palmCount(): number {
    let n = 0;
    for (const m of this.palmMeshes) n += m.count;
    return n;
  }

  get rockCount(): number {
    return this.rocks.length;
  }

  /** Per-frame: the wind sway phase and strength (wind in radians / m·s⁻¹ as in `OceanParams.waves`). */
  update(time: number, windDirection: number, windSpeed: number): void {
    this.sway.uTime.value = time;
    const s = Math.min(windSpeed / 25, 1) * 1.4;
    this.sway.uWind.value.set(Math.cos(windDirection) * s, Math.sin(windDirection) * s);
  }

  private keep(t: PbrTextures): PbrTextures {
    this.textures.push(t);
    return t;
  }

  /** Add the wind sway to a standard material's vertex shader. */
  private swayed(m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const sway = this.sway;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sway.uTime;
      shader.uniforms.uWind = sway.uWind;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform vec2 uWind;")
        .replace(
          "#include <project_vertex>",
          `float hf = clamp( transformed.y, 0.0, 1.0 );
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
{
  float ph = uTime * 1.1 + dot( mvPosition.xz, vec2( 0.05, 0.07 ) );
  vec2 gust = uWind * ( 0.55 + 0.45 * sin( ph ) ) + 0.12 * vec2( sin( ph * 2.3 ), cos( ph * 1.7 ) );
  mvPosition.xz += gust * hf * hf;
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,
        );
    };
    m.customProgramCacheKey = () => `sway-${m.name}`;
    return m;
  }

  private setPalmMeshes(meshes: THREE.InstancedMesh[]): void {
    for (const m of this.palmMeshes) {
      this.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.palmMeshes = meshes;
    for (const m of meshes) {
      m.userData.castsWaterDepth = true;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.add(m);
    }
  }

  /** Spread the placements over the variants (round-robin). Geometries are unit-height; `ratios` size each variant relative to `palmHeight`. */
  private instance(geometries: THREE.BufferGeometry[], materials: THREE.Material[], ratios: number[]): THREE.InstancedMesh[] {
    const perVariant = geometries.map(() => [] as Placement[]);
    this.palms.forEach((p, i) => perVariant[i % geometries.length]!.push(p));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const t = new THREE.Vector3();
    return geometries.map((geo, v) => {
      const list = perVariant[v]!;
      const mesh = new THREE.InstancedMesh(geo, materials, Math.max(list.length, 1));
      mesh.name = `Palms${v}`;
      mesh.count = list.length;
      const k = this.palmHeight * ratios[v]!;
      list.forEach((p, i) => {
        e.set(p.leanAmount * 0.12 * Math.sin(p.lean), p.yaw, p.leanAmount * 0.12 * Math.cos(p.lean), "YXZ");
        q.setFromEuler(e);
        s.setScalar(k * p.scale);
        t.set(p.x, p.y - 0.2, p.z);
        m.compose(t, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      return mesh;
    });
  }

  private buildProceduralPalms(seed: number): void {
    const geos = [proceduralPalm(10, 0.35, seed), proceduralPalm(10, 0.8, seed + 1), proceduralPalm(8, 0.15, seed + 2)].map(unitHeight);
    this.setPalmMeshes(this.instance(geos, [this.trunkMat, this.frondMat], [1, 1, 0.8]));
    this.palmModel = "procedural";
  }

  private async loadGltfPalms(loader: GLTFLoader, urls: string[]): Promise<void> {
    try {
      const scenes = await Promise.all(urls.map((u) => loader.loadAsync(u)));
      if (this.disposed) return;
      const geos: THREE.BufferGeometry[] = [];
      const heights: number[] = [];
      for (const gltf of scenes) {
        gltf.scene.updateMatrixWorld(true);
        const trunk: THREE.BufferGeometry[] = [];
        const fronds: THREE.BufferGeometry[] = [];
        gltf.scene.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
          const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
          for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
          (/leaf|frond/i.test(mat.name) ? fronds : trunk).push(g);
          mat.dispose();
          o.geometry.dispose();
        });
        // Group 0 trunk, 1 fronds (either may be empty on a variant).
        const parts = [...trunk, ...fronds];
        const merged = mergeGeometries(parts, true);
        if (!merged) throw new Error("palm glTF merge failed");
        merged.clearGroups();
        const count = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute("position").count);
        const trunkCount = trunk.reduce((n, g) => n + count(g), 0);
        const total = parts.reduce((n, g) => n + count(g), 0);
        merged.addGroup(0, trunkCount, 0);
        merged.addGroup(trunkCount, total - trunkCount, 1);
        merged.computeBoundingBox();
        for (const g of parts) g.dispose();
        heights.push(merged.boundingBox!.max.y - merged.boundingBox!.min.y);
        geos.push(unitHeight(merged));
      }
      // The tallest variant is palmHeight; the others keep their relative sizes.
      const ref = Math.max(...heights);
      this.setPalmMeshes(this.instance(geos, [this.gltfTrunkMat, this.gltfFrondMat], heights.map((h) => h / ref)));
      this.palmModel = "gltf";
    } catch (err) {
      console.warn(`palm glTF unavailable, keeping the procedural palms: ${String(err)}`);
    }
  }

  /** Each placement is an outcrop: a main boulder and two smaller ones tumbled beside it. */
  private buildRocks(seed: number): THREE.Mesh {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const parts: THREE.BufferGeometry[] = [];
    this.rocks.forEach((p, i) => {
      const size = 2.5 + 3.5 * p.scale;
      for (let k = 0; k < 3; k++) {
        const g = rockGeometry(seed + i * 17 + k * 5);
        const f = k === 0 ? 1 : 0.45 + 0.2 * k;
        const a = p.yaw + k * 2.1;
        const off = k === 0 ? 0 : size * (0.9 + 0.3 * k);
        const x = p.x + Math.cos(a) * off;
        const z = p.z + Math.sin(a) * off;
        q.setFromEuler(new THREE.Euler(0.3 * (p.leanAmount - 0.5), p.yaw + k, 0.2 * k));
        m.compose(new THREE.Vector3(x, p.y - 0.4 * size * f, z), q, new THREE.Vector3(size * f * 1.3, size * f * 0.8, size * f));
        parts.push(g.applyMatrix4(m));
      }
    });
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error("rock merge failed");
    for (const g of parts) g.dispose();
    const mesh = new THREE.Mesh(merged, this.rockMat);
    mesh.name = "Rocks";
    mesh.userData.castsWaterDepth = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  override dispose(): void {
    this.disposed = true;
    this.setPalmMeshes([]);
    this.rockMesh.geometry.dispose();
    for (const m of [this.trunkMat, this.frondMat, this.gltfTrunkMat, this.gltfFrondMat, this.rockMat]) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
