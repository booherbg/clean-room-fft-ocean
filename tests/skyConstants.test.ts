import { describe, expect, it } from "vitest";
import { SKY, skyDefines } from "../src/render/skyConstants";
import common from "../src/render/shaders/common.glsl?raw";

describe("sky constants (one table for TS and GLSL)", () => {
  it("emits one #define per table entry, as GLSL floats / vec3s", () => {
    const text = skyDefines();
    expect(text).toContain("#define SKY_SUN_TINT_HIGH vec3(1.0, 0.96, 0.9)");
    expect(text).toContain("#define SKY_SUN_TINT_LOW vec3(1.0, 0.42, 0.12)");
    expect(text).toContain("#define SKY_SUN_WARM_EL 0.35");
    expect(text).toContain("#define SKY_SUN_FADE_EL -0.18");
    expect(text).toContain("#define SKY_DAY_EL_LO -0.3");
    expect(text).toContain("#define SKY_DAY_EL_HI 0.15");
    // The gradient is tuned against the reference; check the shape, not the values.
    const [zr, zg, zb] = SKY.zenithDay;
    expect(text).toContain(`#define SKY_ZENITH_DAY vec3(${zr}, ${zg}, ${zb})`);
    expect(text).toContain("#define SKY_MOON_RISE_EL -0.35");
    // Every float literal carries a decimal point (GLSL ES 3.00 has no int→float promotion).
    for (const line of text.trim().split("\n")) {
      const value = line.split(" ").slice(2).join(" ");
      for (const num of value.match(/(?<![A-Za-z])-?\d+(\.\d+)?/g) ?? []) expect(num, line).toMatch(/\./);
    }
  });

  it("common.glsl uses the defines, not literal copies of the table", () => {
    for (const name of [
      "SKY_SUN_TINT_HIGH",
      "SKY_SUN_TINT_LOW",
      "SKY_SUN_WARM_EL",
      "SKY_SUN_FADE_EL",
      "SKY_DAY_EL_LO",
      "SKY_DAY_EL_HI",
      "SKY_ZENITH_DAY",
      "SKY_HORIZON_DAY",
      "SKY_ZENITH_NIGHT",
      "SKY_HORIZON_NIGHT",
      "SKY_MOON_RISE_EL",
      "SKY_MOON_FULL_EL",
      "SKY_MOON_TINT",
    ]) {
      expect(common, name).toContain(name);
    }
    const [r, g, b] = SKY.sunTintLow;
    expect(common).not.toContain(`vec3(${r.toFixed(1)}, ${g}, ${b})`);
    expect(common).not.toContain(`vec3(${SKY.zenithDay.join(", ")})`);
  });
});
