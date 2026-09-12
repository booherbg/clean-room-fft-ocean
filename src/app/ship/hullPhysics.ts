/**
 * Hull physics (spec §1.9): a `RigidBody` driven by a 3×5 grid of hull
 * sample points. Each point is a vertical column of water-plane area `A_i`
 * whose bottom sits `draft_i` below the waterline in body space. Per step the
 * water height at each point's world xz gives its submerged depth `s_i`, and
 * the point pushes up with ρ·g·A_i·s_i (applied at the point, so an uneven
 * sea rolls and pitches the hull) and resists its own vertical velocity with
 * c_i·v_y (wave damping). Mass is chosen so the rest draft is exactly the
 * design draft: m = ρ Σ A_i draft_i, which puts the body origin (the
 * centre of mass) on the still waterline.
 *
 * Stability: with forces applied at depth d below the centre of mass the
 * roll torque is ρ g sinθ (m d / ρ − I_wp cosθ), so the hull rights itself
 * as long as the waterplane inertia I_wp = Σ A_i x_i² exceeds m d / ρ —
 * here BM ≈ 5 m against d ≈ 2 m.
 *
 * Throttle is a thrust along the heading against quadratic body-space drag
 * tuned so full throttle settles at `CRUISE`; rudder is a yaw torque scaled
 * by forward speed against linear yaw damping. Pure TypeScript (no three):
 * the overlay lives in `probesOverlay.ts`.
 */
import { boxInertia, eulerFromQuat, RigidBody, vec3, type Vec3 } from "../../core/rigidbody";
import { halfBeamFraction, keelDepthFraction } from "./hullShape";

export interface HeightSampler {
  heightAt(x: number, z: number): number;
}

export interface HullSample {
  /** Body-space position (x starboard, y up, z aft). */
  readonly local: Vec3;
  /** Water-plane area of the column, m². */
  readonly area: number;
  /** Depth of the column bottom below the waterline at rest, m. */
  readonly draft: number;
  /** Column height (submersion saturates here), m. */
  readonly height: number;
  /** World position this step. */
  readonly world: Vec3;
  /** Water height at the point this step. */
  waterY: number;
  /** Submerged depth this step, m (0 when clear of the water). */
  depth: number;
  /** Net vertical force applied at the point this step, N (buoyancy + damping). */
  force: number;
}

export interface HullDimensions {
  length: number;
  beam: number;
  draft: number;
}

export interface HullPhysicsOptions extends Partial<HullDimensions> {
  /** Water density, kg/m³. */
  rho?: number;
  /** Heave damping ratio. */
  damping?: number;
  /** Cruise speed at full throttle, m/s. */
  cruise?: number;
  /** Full-throttle acceleration from rest, m/s². */
  acceleration?: number;
  /** Steady yaw rate at full rudder and cruise, rad/s. */
  yawRate?: number;
}

const G = 9.81;
const MAX_SUBSTEP = 1 / 60;

/** Body z of each station as a fraction of the hull length (aft positive). */
const STATION_Z = [0.4, 0.2, 0, -0.2, -0.4];
/** Side columns sit at this fraction of the local half-beam, with this draft fraction. */
const SIDE_X = 0.8;
const SIDE_DRAFT = 0.55;

export class HullPhysics {
  static readonly LENGTH = 40;
  static readonly BEAM = 10;
  static readonly DRAFT = 3;
  /** Top speed, m/s (~14 kn: the wake's transverse wavelength 2πU²/g ≈ 31 m). */
  static readonly CRUISE = 7;

  readonly body: RigidBody;
  readonly samples: readonly HullSample[];
  readonly dims: HullDimensions;
  /** Radius (m) of the sample footprint around the body position. */
  readonly footprintRadius: number;
  /**
   * Body z of the geometric hull centre (the loft's midpoint): the origin
   * sits at the rest centre of buoyancy, a little aft of it. The model is
   * translated by −originShiftZ to line up.
   */
  readonly originShiftZ: number;
  /** −1..1 */
  throttle = 0;
  /** −1..1, positive turns to port (heading increases). */
  rudder = 0;
  private readonly rho: number;
  private readonly heaveDamping: number;
  private readonly thrust: number;
  private readonly dragForward: number;
  private readonly dragLateral: number;
  private readonly yawTorque: number;
  private readonly yawDamping: number;
  private readonly rollPitchDamping: number;
  private readonly cruise: number;

  constructor(opts: HullPhysicsOptions = {}) {
    const length = opts.length ?? HullPhysics.LENGTH;
    const beam = opts.beam ?? HullPhysics.BEAM;
    const draft = opts.draft ?? HullPhysics.DRAFT;
    this.dims = { length, beam, draft };
    this.rho = opts.rho ?? 1000;
    this.cruise = opts.cruise ?? HullPhysics.CRUISE;

    // Waterplane ≈ 0.7·L·B shared over the columns in proportion to the local beam.
    const waterplane = 0.7 * length * beam;
    const raw: { local: Vec3; weight: number; draft: number }[] = [];
    for (let s = 0; s < 5; s++) {
      const z = STATION_Z[s]! * length;
      const t = 0.5 - STATION_Z[s]!;
      const bf = halfBeamFraction(t);
      const keelDraft = draft * keelDepthFraction(t);
      raw.push({ local: vec3(0, -keelDraft, z), weight: bf, draft: keelDraft });
      for (const side of [-1, 1]) {
        raw.push({
          local: vec3(side * SIDE_X * bf * (beam / 2), -keelDraft * SIDE_DRAFT, z),
          weight: bf * 0.85,
          draft: keelDraft * SIDE_DRAFT,
        });
      }
    }
    const wsum = raw.reduce((a, r) => a + r.weight, 0);
    // Put the origin (centre of mass) at the rest centre of buoyancy so the
    // hull floats level: the bow's narrower stations carry less volume.
    const volume = raw.reduce((a, r) => a + r.weight * r.draft, 0);
    this.originShiftZ = raw.reduce((a, r) => a + r.weight * r.draft * r.local.z, 0) / volume;
    for (const r of raw) r.local.z -= this.originShiftZ;
    this.samples = raw.map((r) => ({
      local: r.local,
      area: (waterplane * r.weight) / wsum,
      draft: r.draft,
      height: draft * 2.5,
      world: vec3(),
      waterY: 0,
      depth: 0,
      force: 0,
    }));
    this.footprintRadius = Math.hypot(0.4 * length, beam / 2) + 1;

    const mass = this.rho * this.samples.reduce((a, s) => a + s.area * s.draft, 0);
    // Box inertia over the hull envelope; a little extra depth for the masts.
    const inertia = boxInertia(mass, beam, draft * 2.5, length * 0.9);
    this.body = new RigidBody({ mass, inertia, linearDrag: 0.02, angularDrag: 0 });

    const stiffness = this.rho * G * waterplane;
    const omegaHeave = Math.sqrt(stiffness / mass);
    this.heaveDamping = 2 * (opts.damping ?? 0.7) * mass * omegaHeave;

    const accel = opts.acceleration ?? 1.6;
    this.thrust = mass * accel;
    this.dragForward = this.thrust / (this.cruise * this.cruise);
    this.dragLateral = this.dragForward * 25;

    const yawRate = opts.yawRate ?? 0.4;
    this.yawDamping = inertia.y * 1.2;
    this.yawTorque = this.yawDamping * yawRate;
    this.rollPitchDamping = 0.25;
  }

  get mass(): number {
    return this.body.mass;
  }

  /** Heading in radians (0 = −z, increasing toward −x, i.e. to port). */
  get heading(): number {
    return eulerFromQuat(this.body.orientation).yaw;
  }

  /** Bow-up pitch, radians. */
  get pitch(): number {
    return eulerFromQuat(this.body.orientation).pitch;
  }

  /** Starboard-down roll, radians. */
  get roll(): number {
    return eulerFromQuat(this.body.orientation).roll;
  }

  /** Signed speed along the heading, m/s. */
  get speed(): number {
    const fwd = this.body.localToWorldDir(vec3(0, 0, -1));
    const v = this.body.velocity;
    return fwd.x * v.x + fwd.y * v.y + fwd.z * v.z;
  }

  /** Put the hull at rest at `(x, y, z)` facing `heading`. */
  reset(x: number, y: number, z: number, heading = 0): void {
    this.body.reset(vec3(x, y, z), heading);
    this.throttle = 0;
    this.rudder = 0;
    this.refreshSamples();
  }

  /** Update the samples' world positions from the body pose. */
  refreshSamples(): void {
    for (const s of this.samples) {
      const w = this.body.localToWorld(s.local);
      s.world.x = w.x;
      s.world.y = w.y;
      s.world.z = w.z;
    }
  }

  /**
   * Advance by `dt` seconds. Water heights are sampled once at the start
   * (they only change per frame anyway); the body is sub-stepped.
   */
  step(dt: number, water: HeightSampler): void {
    if (!(dt > 0)) return;
    this.refreshSamples();
    for (const s of this.samples) s.waterY = water.heightAt(s.world.x, s.world.z);
    const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h);
  }

  private substep(dt: number): void {
    const body = this.body;
    const rho = this.rho;
    body.applyForce(vec3(0, -body.mass * G, 0));

    // Buoyancy + wave damping at each column.
    const totalArea = this.samples.reduce((a, s) => a + s.area, 0);
    for (const s of this.samples) {
      const w = body.localToWorld(s.local);
      s.world.x = w.x;
      s.world.y = w.y;
      s.world.z = w.z;
      const depth = Math.min(s.height, Math.max(0, s.waterY - w.y));
      s.depth = depth;
      let f = rho * G * s.area * depth;
      if (depth > 0) {
        const vy = body.velocityAt(w).y;
        const c = (this.heaveDamping * s.area) / totalArea;
        // Ease the damping in over the first half metre so a point touching
        // down does not kick.
        f -= c * vy * Math.min(1, depth / 0.5);
      }
      s.force = f;
      if (f !== 0) body.applyForceAt(vec3(0, f, 0), w);
    }

    // Hydrodynamic drag in body space (quadratic), thrust and rudder.
    const vb = body.worldToLocalDir(body.velocity);
    const fwdSpeed = -vb.z;
    const throttle = clamp(this.throttle, -1, 1);
    const thrust = throttle >= 0 ? throttle * this.thrust : throttle * this.thrust * 0.4;
    const fz = -(thrust - this.dragForward * fwdSpeed * Math.abs(fwdSpeed));
    const fx = -this.dragLateral * vb.x * Math.abs(vb.x);
    body.applyForce(body.localToWorldDir(vec3(fx, 0, fz)));

    const wb = body.worldToLocalDir(body.angularVelocity);
    const I = body.inertia;
    const rudder = clamp(this.rudder, -1, 1);
    const ty = rudder * this.yawTorque * clamp(fwdSpeed / this.cruise, -1, 1) - this.yawDamping * wb.y;
    const tx = -this.rollPitchDamping * I.x * wb.x;
    const tz = -this.rollPitchDamping * I.z * wb.z;
    body.applyTorque(body.localToWorldDir(vec3(tx, ty, tz)));

    body.integrate(dt);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
