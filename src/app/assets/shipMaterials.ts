/**
 * The ship's materials, built once from the procedural textures and shared
 * by the procedural galleon (`ship/shipModel.ts`) and the glTF one
 * (`assets/shipLoader.ts`), so both read as the same wooden ship. Everything
 * is `MeshStandardMaterial` so the scene's sun / hemisphere lights and the
 * shadow map apply.
 */
import * as THREE from "three";
import { canvasPlanes, ropePlanes, toTextures, woodPlanes, type PbrTextures } from "./proceduralTextures";

export class ShipMaterials {
  readonly hull: THREE.MeshStandardMaterial;
  readonly hullBelow: THREE.MeshStandardMaterial;
  readonly deck: THREE.MeshStandardMaterial;
  readonly spar: THREE.MeshStandardMaterial;
  readonly wale: THREE.MeshStandardMaterial;
  readonly sail: THREE.MeshStandardMaterial;
  readonly iron: THREE.MeshStandardMaterial;
  readonly gilt: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  readonly rope: THREE.MeshStandardMaterial;
  readonly ropeLine: THREE.LineBasicMaterial;
  readonly flag: THREE.MeshStandardMaterial;
  private readonly textures: PbrTextures[] = [];

  constructor(size = 512) {
    const wood = this.keep(toTextures(woodPlanes(size, { metres: 4, plankWidth: 0.3, plankLength: 2.2, seed: 3, tint: [0.66, 0.46, 0.27] })));
    const deckWood = this.keep(toTextures(woodPlanes(size, { metres: 4, plankWidth: 0.22, plankLength: 3, seed: 8, tint: [0.72, 0.58, 0.4] })));
    const sparWood = this.keep(toTextures(woodPlanes(256, { metres: 2, plankWidth: 2, plankLength: 2, seed: 4, tint: [0.36, 0.25, 0.15] })));
    const canvas = this.keep(toTextures(canvasPlanes(size, { metres: 10, panel: 0.6 })));
    const rope = this.keep(toTextures(ropePlanes(64)));

    const pbr = (t: PbrTextures, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({
        map: t.map,
        roughnessMap: t.roughnessMap,
        normalMap: t.normalMap,
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughness: 1,
        metalness: 0,
        ...extra,
      });

    this.hull = pbr(wood, { name: "ship-hull" });
    // Below the waterline: tarred, greener and darker.
    this.hullBelow = pbr(wood, { name: "ship-hull-below", color: 0x5a5340, roughness: 0.95 });
    this.deck = pbr(deckWood, { name: "ship-deck" });
    this.spar = pbr(sparWood, { name: "ship-spar", roughness: 0.75 });
    this.wale = new THREE.MeshStandardMaterial({ name: "ship-wale", color: 0x201810, roughness: 0.8, metalness: 0 });
    this.sail = pbr(canvas, {
      name: "ship-sail",
      side: THREE.DoubleSide,
      alphaTest: 0.5,
      // Sun through canvas: a little emissive so the shaded face still glows.
      color: 0xe4d9c2,
      emissive: new THREE.Color(0xe8e0cc),
      emissiveIntensity: 0.1,
      normalScale: new THREE.Vector2(0.35, 0.35),
    });
    this.iron = new THREE.MeshStandardMaterial({ name: "ship-iron", color: 0x1c1d20, roughness: 0.55, metalness: 0.8 });
    this.gilt = new THREE.MeshStandardMaterial({ name: "ship-gilt", color: 0xd9b24a, roughness: 0.4, metalness: 0.7 });
    this.glass = new THREE.MeshStandardMaterial({
      name: "ship-glass",
      color: 0xb8cad4,
      roughness: 0.2,
      metalness: 0.3,
      emissive: 0x3a4a5a,
      emissiveIntensity: 0.6,
    });
    this.rope = pbr(rope, { name: "ship-rope", roughness: 0.9 });
    this.ropeLine = new THREE.LineBasicMaterial({ name: "ship-rope-line", color: 0x1a1410 });
    this.flag = new THREE.MeshStandardMaterial({ name: "ship-flag", color: 0xb3141e, roughness: 0.9, side: THREE.DoubleSide });
  }

  private keep(t: PbrTextures): PbrTextures {
    this.textures.push(t);
    return t;
  }

  /** Every material, for compile / dispose. */
  all(): THREE.Material[] {
    return [this.hull, this.hullBelow, this.deck, this.spar, this.wale, this.sail, this.iron, this.gilt, this.glass, this.rope, this.ropeLine, this.flag];
  }

  dispose(): void {
    for (const m of this.all()) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

let shared: ShipMaterials | null = null;

/** The app-wide instance (the textures cost a few MB; build them once). */
export function sharedShipMaterials(): ShipMaterials {
  shared ??= new ShipMaterials();
  return shared;
}
