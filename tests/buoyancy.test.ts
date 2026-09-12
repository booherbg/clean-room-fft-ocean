import { describe, expect, it } from "vitest";
import { Buoyancy, type BuoyancySource } from "../src/app/buoyancy";
import type { CascadeProvider } from "../src/render/cascadeTextures";

/**
 * A fake sim: one cascade whose displacement texture holds height
 * h(x, z) = x + 100·z at texel centres and no horizontal displacement.
 * `issue` records the request; `consume` serves it a frame later.
 */
function fakeSim(N = 64, size = 64): BuoyancySource & { issued: number[] } {
  const pending = new Map<number, Float32Array>();
  const issued: number[] = [];
  return {
    issued,
    cascades: [{ N, size }] as unknown as CascadeProvider["cascades"],
    issueDisplacementBlock(slot, _cascade, x, y, w, h) {
      issued.push(slot);
      const out = new Float32Array(w * h * 4);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const wx = ((x + i + 0.5) * size) / N;
          const wz = ((y + j + 0.5) * size) / N;
          out[(j * w + i) * 4 + 1] = wx + 100 * wz;
        }
      }
      pending.set(slot, out);
    },
    consumeDisplacementBlock(slot) {
      const d = pending.get(slot) ?? null;
      pending.delete(slot);
      return d;
    },
  };
}

describe("Buoyancy", () => {
  it("answers the surface height inside its block, one frame late", () => {
    const b = new Buoyancy(fakeSim());
    b.update(10, 20);
    expect(b.heightAt(10, 20)).toBe(0); // nothing consumed yet
    b.update(10, 20);
    expect(b.heightAt(10, 20)).toBeCloseTo(10 + 2000, 6);
    expect(b.heightAt(10.7, 20.4)).toBeCloseTo(10.7 + 2040, 6);
  });

  it("covers() is false outside the block, where heightAt would clamp to the edge", () => {
    const b = new Buoyancy(fakeSim());
    b.update(10, 20);
    b.update(10, 20);
    expect(b.covers(10, 20)).toBe(true);
    expect(b.covers(11, 21)).toBe(true);
    expect(b.covers(40, 20)).toBe(false);
    expect(b.covers(10, 60)).toBe(false);
    // The clamp: 30 m away it still reports a number, but the wrong one.
    expect(b.heightAt(40, 20)).not.toBeCloseTo(40 + 2000, 0);
  });

  it("two samplers on one sim use disjoint readback slots", () => {
    const sim = fakeSim();
    const hull = new Buoyancy(sim);
    const cam = new Buoyancy(sim, { slotBase: 100 });
    hull.update(10, 10);
    cam.update(30, 30);
    hull.update(10, 10);
    cam.update(30, 30);
    expect(new Set(sim.issued).size).toBe(2);
    expect(hull.heightAt(10, 10)).toBeCloseTo(10 + 1000, 6);
    expect(cam.heightAt(30, 30)).toBeCloseTo(30 + 3000, 6);
    expect(hull.covers(30, 30)).toBe(false);
    expect(cam.covers(30, 30)).toBe(true);
  });
});
