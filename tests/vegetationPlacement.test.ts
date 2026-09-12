import { describe, expect, it } from "vitest";
import { islandHeight } from "../src/core/terrain";
import { PALM_HEIGHT_RANGE, placePalms, placeRocks, ROCK_HEIGHT_RANGE, terrainSlope } from "../src/render/vegetationPlacement";

describe("vegetation placement (spec §1.15)", () => {
  it("puts every palm on the backshore band, on gentle ground, spaced apart", () => {
    const palms = placePalms(1337, 40);
    expect(palms.length).toBe(40);
    for (const p of palms) {
      expect(p.y).toBeCloseTo(islandHeight(p.x, p.z, 1337), 9);
      expect(p.y).toBeGreaterThanOrEqual(PALM_HEIGHT_RANGE[0]);
      expect(p.y).toBeLessThanOrEqual(PALM_HEIGHT_RANGE[1]);
      expect(terrainSlope(p.x, p.z, 1337)).toBeLessThanOrEqual(0.35);
    }
    for (let i = 0; i < palms.length; i++)
      for (let j = i + 1; j < palms.length; j++) expect(Math.hypot(palms[i]!.x - palms[j]!.x, palms[i]!.z - palms[j]!.z)).toBeGreaterThanOrEqual(7);
  });

  it("puts rocks at the waterline", () => {
    const rocks = placeRocks(1337, 15);
    expect(rocks.length).toBe(15);
    for (const r of rocks) {
      expect(r.y).toBeGreaterThanOrEqual(ROCK_HEIGHT_RANGE[0]);
      expect(r.y).toBeLessThanOrEqual(ROCK_HEIGHT_RANGE[1]);
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(placePalms(7, 10)).toEqual(placePalms(7, 10));
    expect(placePalms(7, 10)).not.toEqual(placePalms(8, 10));
  });

  it("fills the count on every seed in a range (the beach ring is never too small)", () => {
    for (let seed = 0; seed < 12; seed++) expect(placePalms(seed, 40).length).toBe(40);
  });
});
