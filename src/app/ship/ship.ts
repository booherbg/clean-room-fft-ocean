/**
 * The boat-mode ship: a `HullPhysics` rigid body driving a `ShipModel`, with
 * the "Buoyancy Probes" overlay alongside. The group's transform mirrors the
 * body every frame; `position` is the body's centre of mass, which sits on
 * the still waterline (`__app.hull()` reports it).
 */
import * as THREE from "three";
import type { HeightSampler, HullSample } from "./hullPhysics";
import type { HullDimensions } from "./hullPhysics";
import { HullPhysics } from "./hullPhysics";
import { ProbesOverlay } from "./probesOverlay";
import { ShipModel } from "./shipModel";

export type ShipModelKind = "gltf" | "procedural";

export class Ship extends THREE.Group {
  /** Top speed, m/s. */
  static readonly CRUISE = HullPhysics.CRUISE;
  physics = new HullPhysics();
  /** The visual: the procedural galleon until a glTF one is swapped in (`setModel`). */
  model: THREE.Object3D;
  modelKind: ShipModelKind = "procedural";
  private disposeModel: () => void;
  /** World-space overlay; add it to the scene beside the ship. */
  readonly probes: ProbesOverlay;

  constructor() {
    super();
    this.name = "Ship";
    const { length, beam, draft } = this.physics.dims;
    const procedural = new ShipModel({ length, beam, draft });
    this.model = procedural;
    this.disposeModel = () => procedural.dispose();
    this.model.position.z = -this.physics.originShiftZ;
    this.add(this.model);
    this.probes = new ProbesOverlay(this.physics);
    this.sync();
  }

  get length(): number {
    return this.physics.dims.length;
  }

  get beam(): number {
    return this.physics.dims.beam;
  }

  /** Radians, 0 = −z. */
  get heading(): number {
    return this.physics.heading;
  }

  /** Signed speed along the heading, m/s. */
  get speed(): number {
    return this.physics.speed;
  }

  get pitch(): number {
    return this.physics.pitch;
  }

  get roll(): number {
    return this.physics.roll;
  }

  get samples(): readonly HullSample[] {
    return this.physics.samples;
  }

  /**
   * Swap the visual for `model` (waterline at y = 0, bow toward −z, centred
   * on the hull) and rebuild the physics for its `dims` so the buoyancy
   * columns match; the pose carries over. The old model is disposed.
   */
  setModel(model: THREE.Object3D, dims: HullDimensions, kind: ShipModelKind, dispose: () => void = () => {}): void {
    const prev = this.physics;
    const p = prev.body.position;
    this.remove(this.model);
    this.disposeModel();
    this.model = model;
    this.modelKind = kind;
    this.disposeModel = dispose;
    this.physics = new HullPhysics(dims);
    this.physics.reset(p.x, p.y, p.z, prev.heading);
    this.probes.setHull(this.physics);
    this.model.position.z = -this.physics.originShiftZ;
    this.add(this.model);
    this.sync();
  }

  /** Rest at (x, y, z) facing `heading`. */
  reset(x: number, y: number, z: number, heading = 0): void {
    this.physics.reset(x, y, z, heading);
    this.sync();
  }

  /** Step the physics with the given controls (−1..1) and mirror the body. */
  update(dt: number, throttle: number, rudder: number, water: HeightSampler): void {
    this.physics.throttle = throttle;
    this.physics.rudder = rudder;
    this.physics.step(dt, water);
    this.sync();
    this.probes.update();
  }

  private sync(): void {
    const b = this.physics.body;
    this.position.set(b.position.x, b.position.y, b.position.z);
    this.quaternion.set(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
  }

  override dispose(): void {
    this.disposeModel();
    this.probes.dispose();
  }
}
