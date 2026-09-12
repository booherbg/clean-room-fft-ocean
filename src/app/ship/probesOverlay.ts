/**
 * "Buoyancy Probes" overlay for the ship: a green disc on the water at each
 * hull sample point and a yellow arrow for the net vertical force it
 * applied this frame (length ∝ force, capped), like the reference demo.
 */
import * as THREE from "three";
import type { HullPhysics } from "./hullPhysics";

const ARROW_SCALE_M_PER_MN = 10; // metres of arrow per meganewton
const ARROW_MAX = 8;

export class ProbesOverlay extends THREE.Group {
  private readonly discs: THREE.Mesh[] = [];
  private readonly arrows: THREE.ArrowHelper[] = [];
  private readonly discGeo = new THREE.CircleGeometry(0.7, 16);
  private readonly discMat = new THREE.MeshBasicMaterial({
    color: 0x35e06a,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    side: THREE.DoubleSide,
  });

  private hull: HullPhysics;

  constructor(hull: HullPhysics) {
    super();
    this.hull = hull;
    this.name = "BuoyancyProbes";
    this.visible = false;
    for (let i = 0; i < hull.samples.length; i++) {
      const d = new THREE.Mesh(this.discGeo, this.discMat);
      d.rotation.x = -Math.PI / 2;
      d.renderOrder = 11;
      this.discs.push(d);
      const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0xffd23f, 0.6, 0.4);
      a.renderOrder = 12;
      (a.line.material as THREE.Material).depthTest = false;
      (a.cone.material as THREE.Material).depthTest = false;
      this.arrows.push(a);
      this.add(d, a);
    }
  }

  /** Follow a replacement body (same sample layout: 3×5 columns). */
  setHull(hull: HullPhysics): void {
    if (hull.samples.length !== this.discs.length) throw new Error("ProbesOverlay.setHull: sample count changed");
    this.hull = hull;
  }

  /** Place the discs on the water at the sample points and size the arrows. */
  update(): void {
    if (!this.visible) return;
    this.hull.samples.forEach((s, i) => {
      const d = this.discs[i]!;
      d.position.set(s.world.x, s.waterY + 0.05, s.world.z);
      const a = this.arrows[i]!;
      a.position.set(s.world.x, s.world.y, s.world.z);
      const len = Math.min(ARROW_MAX, (Math.abs(s.force) / 1e6) * ARROW_SCALE_M_PER_MN);
      a.setDirection(new THREE.Vector3(0, s.force >= 0 ? 1 : -1, 0));
      a.setLength(Math.max(0.05, len), 0.6, 0.4);
      a.visible = len > 0.05;
    });
  }

  override dispose(): void {
    this.discGeo.dispose();
    this.discMat.dispose();
    for (const a of this.arrows) a.dispose();
  }
}
