import { describe, expect, it } from "vitest";
import {
  boxInertia,
  eulerFromQuat,
  quatFromAxisAngle,
  quatRotate,
  RigidBody,
  vec3,
} from "../src/core/rigidbody";

const G = 9.81;

function makeBody(drag = 0): RigidBody {
  return new RigidBody({ mass: 10, inertia: boxInertia(10, 2, 1, 4), linearDrag: drag, angularDrag: drag });
}

describe("RigidBody", () => {
  it("gravity plus a damped spring settles at the static equilibrium", () => {
    const b = makeBody();
    const k = 200; // N/m
    const c = 40; // N·s/m
    const dt = 1 / 120;
    for (let t = 0; t < 10; t += dt) {
      b.applyForce(vec3(0, -b.mass * G, 0));
      b.applyForce(vec3(0, -k * b.position.y - c * b.velocity.y, 0));
      b.integrate(dt);
    }
    expect(b.position.y).toBeCloseTo((-b.mass * G) / k, 3);
    expect(Math.abs(b.velocity.y)).toBeLessThan(1e-3);
    expect(b.position.x).toBe(0);
  });

  it("an off-centre force spins the body about the right axis", () => {
    const b = makeBody();
    // Push +y at a point 1 m along +x: torque r × f = (1,0,0) × (0,1,0) = +z.
    const dt = 1 / 120;
    for (let i = 0; i < 60; i++) {
      b.applyForceAt(vec3(0, 1, 0), vec3(b.position.x + 1, b.position.y, b.position.z));
      b.integrate(dt);
    }
    expect(b.angularVelocity.z).toBeGreaterThan(0);
    expect(Math.abs(b.angularVelocity.x)).toBeLessThan(1e-9);
    expect(Math.abs(b.angularVelocity.y)).toBeLessThan(1e-9);
    // The force also accelerates the centre of mass.
    expect(b.velocity.y).toBeCloseTo(0.5 / b.mass, 6);
    // Orientation follows: the +x axis has rotated toward +y.
    const xAxis = b.localToWorldDir(vec3(1, 0, 0));
    expect(xAxis.y).toBeGreaterThan(0);
    // The quaternion stays unit length.
    const q = b.orientation;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
  });

  it("a pure torque does not move the centre of mass", () => {
    const b = makeBody();
    b.applyTorque(vec3(0, 5, 0));
    b.integrate(0.1);
    expect(b.velocity).toEqual(vec3());
    expect(b.angularVelocity.y).toBeGreaterThan(0);
  });

  it("kinetic energy decays monotonically with drag and is conserved without it", () => {
    const free = makeBody(0);
    const damped = makeBody(0.5);
    for (const b of [free, damped]) {
      b.velocity.x = 3;
      b.angularVelocity.y = 2;
    }
    const e0 = damped.kineticEnergy();
    let last = e0;
    for (let i = 0; i < 240; i++) {
      free.integrate(1 / 60);
      damped.integrate(1 / 60);
      const e = damped.kineticEnergy();
      expect(e).toBeLessThanOrEqual(last + 1e-9);
      last = e;
    }
    expect(last).toBeLessThan(e0 * 0.05);
    expect(free.kineticEnergy()).toBeCloseTo(e0, 6);
  });

  it("body-space inertia is honoured: a torque about the long axis spins faster", () => {
    // Box 2×1×4: the smallest inertia is about z (the long axis).
    const spinZ = makeBody();
    const spinX = makeBody();
    spinZ.applyTorque(vec3(0, 0, 1));
    spinX.applyTorque(vec3(1, 0, 0));
    spinZ.integrate(0.01);
    spinX.integrate(0.01);
    expect(spinZ.angularVelocity.z).toBeGreaterThan(spinX.angularVelocity.x);
  });

  it("velocityAt adds ω × r", () => {
    const b = makeBody();
    b.angularVelocity.y = 1;
    b.velocity.z = 2;
    const v = b.velocityAt(vec3(1, 0, 0));
    // ω × r = (0,1,0) × (1,0,0) = (0,0,−1)
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(1, 12);
  });

  it("eulerFromQuat recovers yaw, pitch and roll with the ship conventions", () => {
    const yawQ = quatFromAxisAngle(vec3(0, 1, 0), 0.7);
    expect(eulerFromQuat(yawQ).yaw).toBeCloseTo(0.7, 9);
    expect(eulerFromQuat(yawQ).pitch).toBeCloseTo(0, 9);
    expect(eulerFromQuat(yawQ).roll).toBeCloseTo(0, 9);
    // Bow up: rotate the −z forward axis toward +y, i.e. about +x by +θ.
    const pitchQ = quatFromAxisAngle(vec3(1, 0, 0), 0.3);
    expect(quatRotate(pitchQ, vec3(0, 0, -1)).y).toBeGreaterThan(0);
    expect(eulerFromQuat(pitchQ).pitch).toBeCloseTo(0.3, 9);
    // Starboard down: rotate about the forward axis so +x dips: about +z by −θ.
    const rollQ = quatFromAxisAngle(vec3(0, 0, 1), -0.2);
    expect(quatRotate(rollQ, vec3(1, 0, 0)).y).toBeLessThan(0);
    expect(eulerFromQuat(rollQ).roll).toBeCloseTo(0.2, 9);
  });

  it("reset zeroes velocities and faces the given yaw", () => {
    const b = makeBody();
    b.velocity.x = 5;
    b.reset(vec3(1, 2, 3), Math.PI / 2);
    expect(b.velocity).toEqual(vec3());
    expect(b.position).toEqual(vec3(1, 2, 3));
    const fwd = b.localToWorldDir(vec3(0, 0, -1));
    expect(fwd.x).toBeCloseTo(-1, 9);
  });
});
