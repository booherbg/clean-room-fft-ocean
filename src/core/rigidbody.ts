/**
 * Minimal 6-DOF rigid body (spec §1.9, ship). Pure TypeScript, no three
 * imports — unit tested in `tests/rigidbody.test.ts`.
 *
 * State: position (world), orientation (unit quaternion, body → world),
 * linear velocity (world), angular velocity (world). Inertia is a diagonal
 * body-space tensor (box approximation). Forces and torques accumulate
 * between `integrate` calls; integration is semi-implicit Euler (velocity
 * first, then position) with exponential linear/angular drag and the
 * quaternion renormalised each step. The gyroscopic term ω × (Iω) is
 * omitted: hulls do not spin fast enough for it to matter and dropping it
 * keeps the explicit step unconditionally stable in rotation.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

/** Quaternion for a rotation of `angle` radians about the unit `axis`. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Rotate `v` by the unit quaternion `q`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Rotate `v` by the inverse of the unit quaternion `q`. */
export function quatRotateInverse(q: Quat, v: Vec3): Vec3 {
  return quatRotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

/**
 * Yaw / pitch / roll (radians) of a body → world quaternion for a body whose
 * forward axis is −z, up +y, starboard +x: yaw about y (0 = facing −z),
 * pitch positive bow-up, roll positive starboard-down.
 */
export function eulerFromQuat(q: Quat): { yaw: number; pitch: number; roll: number } {
  const fwd = quatRotate(q, vec3(0, 0, -1));
  const right = quatRotate(q, vec3(1, 0, 0));
  const yaw = Math.atan2(-fwd.x, -fwd.z);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  // Roll: the starboard axis' tilt below the horizontal, measured in the
  // plane perpendicular to the forward direction.
  const horizRight = vec3(Math.cos(yaw), 0, -Math.sin(yaw));
  const upish = cross(horizRight, fwd);
  const roll = Math.atan2(-dot(right, upish), dot(right, horizRight));
  return { yaw, pitch, roll };
}

/** Diagonal inertia of a solid box (`sx`, `sy`, `sz` full side lengths). */
export function boxInertia(mass: number, sx: number, sy: number, sz: number): Vec3 {
  const k = mass / 12;
  return { x: k * (sy * sy + sz * sz), y: k * (sx * sx + sz * sz), z: k * (sx * sx + sy * sy) };
}

export interface RigidBodyOptions {
  mass: number;
  /** Diagonal body-space inertia tensor. */
  inertia: Vec3;
  /** Exponential linear drag rate, 1/s (v ← v·e^{−k dt}). */
  linearDrag?: number;
  /** Exponential angular drag rate, 1/s. */
  angularDrag?: number;
}

export class RigidBody {
  readonly mass: number;
  readonly inertia: Vec3;
  linearDrag: number;
  angularDrag: number;
  readonly position = vec3();
  readonly orientation = quatIdentity();
  readonly velocity = vec3();
  /** World-space angular velocity, rad/s. */
  readonly angularVelocity = vec3();
  private readonly force = vec3();
  private readonly torque = vec3();

  constructor(opts: RigidBodyOptions) {
    if (!(opts.mass > 0)) throw new RangeError("RigidBody: mass must be positive");
    this.mass = opts.mass;
    this.inertia = { ...opts.inertia };
    this.linearDrag = opts.linearDrag ?? 0;
    this.angularDrag = opts.angularDrag ?? 0;
  }

  /** World-space force through the centre of mass. */
  applyForce(f: Vec3): void {
    this.force.x += f.x;
    this.force.y += f.y;
    this.force.z += f.z;
  }

  /** World-space torque. */
  applyTorque(t: Vec3): void {
    this.torque.x += t.x;
    this.torque.y += t.y;
    this.torque.z += t.z;
  }

  /** World-space force at a world point: force plus the torque r × f. */
  applyForceAt(f: Vec3, worldPoint: Vec3): void {
    this.applyForce(f);
    const r = vec3(worldPoint.x - this.position.x, worldPoint.y - this.position.y, worldPoint.z - this.position.z);
    this.applyTorque(cross(r, f));
  }

  /** Body point → world. */
  localToWorld(p: Vec3): Vec3 {
    const r = quatRotate(this.orientation, p);
    return vec3(r.x + this.position.x, r.y + this.position.y, r.z + this.position.z);
  }

  /** World point → body. */
  worldToLocal(p: Vec3): Vec3 {
    return quatRotateInverse(
      this.orientation,
      vec3(p.x - this.position.x, p.y - this.position.y, p.z - this.position.z),
    );
  }

  /** Body direction → world direction. */
  localToWorldDir(d: Vec3): Vec3 {
    return quatRotate(this.orientation, d);
  }

  /** World direction → body direction. */
  worldToLocalDir(d: Vec3): Vec3 {
    return quatRotateInverse(this.orientation, d);
  }

  /** Velocity of the body material at a world point: v + ω × r. */
  velocityAt(worldPoint: Vec3): Vec3 {
    const r = vec3(worldPoint.x - this.position.x, worldPoint.y - this.position.y, worldPoint.z - this.position.z);
    const w = cross(this.angularVelocity, r);
    return vec3(this.velocity.x + w.x, this.velocity.y + w.y, this.velocity.z + w.z);
  }

  /** Kinetic energy, J (translational + rotational). */
  kineticEnergy(): number {
    const v = this.velocity;
    const wb = quatRotateInverse(this.orientation, this.angularVelocity);
    const I = this.inertia;
    return 0.5 * this.mass * dot(v, v) + 0.5 * (I.x * wb.x * wb.x + I.y * wb.y * wb.y + I.z * wb.z * wb.z);
  }

  /** Semi-implicit Euler step; clears the accumulators. */
  integrate(dt: number): void {
    if (!(dt > 0)) {
      this.clear();
      return;
    }
    const v = this.velocity;
    const inv = 1 / this.mass;
    v.x += this.force.x * inv * dt;
    v.y += this.force.y * inv * dt;
    v.z += this.force.z * inv * dt;

    // Angular: solve in body space with the diagonal tensor.
    const q = this.orientation;
    const tb = quatRotateInverse(q, this.torque);
    const I = this.inertia;
    const dwb = vec3(tb.x / I.x, tb.y / I.y, tb.z / I.z);
    const dw = quatRotate(q, dwb);
    const w = this.angularVelocity;
    w.x += dw.x * dt;
    w.y += dw.y * dt;
    w.z += dw.z * dt;

    if (this.linearDrag > 0) {
      const k = Math.exp(-this.linearDrag * dt);
      v.x *= k;
      v.y *= k;
      v.z *= k;
    }
    if (this.angularDrag > 0) {
      const k = Math.exp(-this.angularDrag * dt);
      w.x *= k;
      w.y *= k;
      w.z *= k;
    }

    const p = this.position;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // q ← q + ½ (ω q) dt, then renormalise.
    const wq = quatMul({ x: w.x, y: w.y, z: w.z, w: 0 }, q);
    q.x += 0.5 * wq.x * dt;
    q.y += 0.5 * wq.y * dt;
    q.z += 0.5 * wq.z * dt;
    q.w += 0.5 * wq.w * dt;
    const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    q.x /= n;
    q.y /= n;
    q.z /= n;
    q.w /= n;

    this.clear();
  }

  /** Drop pending forces and torques. */
  clear(): void {
    this.force.x = this.force.y = this.force.z = 0;
    this.torque.x = this.torque.y = this.torque.z = 0;
  }

  /** Reset to rest at `position` facing `yaw` (radians about y, 0 = −z). */
  reset(position: Vec3, yaw = 0): void {
    this.position.x = position.x;
    this.position.y = position.y;
    this.position.z = position.z;
    const q = quatFromAxisAngle(vec3(0, 1, 0), yaw);
    this.orientation.x = q.x;
    this.orientation.y = q.y;
    this.orientation.z = q.z;
    this.orientation.w = q.w;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.angularVelocity.x = this.angularVelocity.y = this.angularVelocity.z = 0;
    this.clear();
  }
}
