import { describe, expect, it } from "vitest";
import { HullPhysics, type HeightSampler } from "../src/app/ship/hullPhysics";

const flat: HeightSampler = { heightAt: () => 0 };

function run(h: HullPhysics, seconds: number, water: HeightSampler, dt = 1 / 60, each?: (t: number) => void): void {
  for (let t = 0; t < seconds; t += dt) {
    h.step(dt, water);
    each?.(t);
  }
}

describe("HullPhysics", () => {
  it("has 15 sample points inside the hull footprint and a plausible displacement", () => {
    const h = new HullPhysics();
    expect(h.samples.length).toBe(15);
    for (const s of h.samples) {
      expect(Math.abs(s.local.x)).toBeLessThanOrEqual(HullPhysics.BEAM / 2);
      expect(Math.abs(s.local.z)).toBeLessThanOrEqual(HullPhysics.LENGTH / 2);
      expect(s.local.y).toBeLessThan(0);
      expect(s.local.y).toBeGreaterThanOrEqual(-HullPhysics.DRAFT);
    }
    // A 40 m galleon displaces a few hundred tonnes.
    expect(h.mass).toBeGreaterThan(2e5);
    expect(h.mass).toBeLessThan(1.5e6);
  });

  it("dropped from 2 m onto flat water it settles on the waterline within 5 s", () => {
    const h = new HullPhysics();
    h.reset(0, 2, 0);
    let maxRoll = 0;
    run(h, 5, flat, 1 / 60, () => (maxRoll = Math.max(maxRoll, Math.abs(h.roll))));
    expect(Math.abs(h.body.position.y)).toBeLessThan(0.15);
    expect(Math.abs(h.body.velocity.y)).toBeLessThan(0.1);
    expect(maxRoll).toBeLessThan(0.01);
    expect(Math.abs(h.pitch)).toBeLessThan(0.02);
    expect(Math.abs(h.heading)).toBeLessThan(1e-6);
  });

  it("survives a coarse 0.1 s frame step", () => {
    const h = new HullPhysics();
    h.reset(0, 2, 0);
    run(h, 6, flat, 0.1);
    expect(Math.abs(h.body.position.y)).toBeLessThan(0.15);
  });

  it("full throttle exceeds 3 m/s in 3 s and cruises near CRUISE", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0);
    h.throttle = 1;
    run(h, 3, flat);
    expect(h.speed).toBeGreaterThan(3);
    run(h, 40, flat);
    expect(h.speed).toBeGreaterThan(HullPhysics.CRUISE * 0.9);
    expect(h.speed).toBeLessThan(HullPhysics.CRUISE * 1.05);
    // Heading 0 = −z: the hull travelled toward −z.
    expect(h.body.position.z).toBeLessThan(-100);
    expect(Math.abs(h.body.position.x)).toBeLessThan(1);
    // Still upright and on the water.
    expect(Math.abs(h.body.position.y)).toBeLessThan(0.3);
    expect(Math.abs(h.roll)).toBeLessThan(0.02);
  });

  it("rudder turns the hull (to port for positive rudder) only when it has way on", () => {
    const still = new HullPhysics();
    still.reset(0, 0, 0);
    still.rudder = 1;
    run(still, 3, flat);
    expect(Math.abs(still.heading)).toBeLessThan(0.02);

    const h = new HullPhysics();
    h.reset(0, 0, 0);
    h.throttle = 1;
    run(h, 4, flat);
    h.rudder = 1;
    run(h, 4, flat);
    expect(h.heading).toBeGreaterThan(0.3);
    expect(h.heading).toBeLessThan(2.5);
    // Turning to port: the hull has moved toward −x.
    expect(h.body.position.x).toBeLessThan(-1);
  });

  it("rolls toward the low side of a sloped sea and rights itself when it flattens", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0);
    // Water higher to starboard (+x): the hull rolls to port (negative roll).
    const sloped: HeightSampler = { heightAt: (x) => 0.12 * x };
    run(h, 6, sloped);
    expect(h.roll).toBeLessThan(-0.05);
    run(h, 8, flat);
    expect(Math.abs(h.roll)).toBeLessThan(0.02);
  });

  it("pitches bow-up on a sea that rises toward the bow", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0);
    // Bow is at −z: water higher there.
    const sloped: HeightSampler = { heightAt: (_x, z) => -0.05 * z };
    run(h, 6, sloped);
    expect(h.pitch).toBeGreaterThan(0.02);
  });

  it("rides 2 m swell beam-on without capsizing and heaves with it", () => {
    const h = new HullPhysics();
    h.reset(0, 0, 0);
    let t = 0;
    const L = 60;
    const c = Math.sqrt((9.81 * L) / (2 * Math.PI));
    const swell: HeightSampler = { heightAt: (x) => 1.0 * Math.sin(((x - c * t) * 2 * Math.PI) / L) };
    let maxRoll = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (; t < 30; t += 1 / 60) {
      h.step(1 / 60, swell);
      maxRoll = Math.max(maxRoll, Math.abs(h.roll));
      if (t > 10) {
        minY = Math.min(minY, h.body.position.y);
        maxY = Math.max(maxY, h.body.position.y);
      }
    }
    expect(maxRoll).toBeLessThan(0.6);
    expect(maxRoll).toBeGreaterThan(0.03);
    expect(maxY - minY).toBeGreaterThan(0.8);
    expect(Math.abs(h.pitch)).toBeLessThan(0.3);
  });
});
