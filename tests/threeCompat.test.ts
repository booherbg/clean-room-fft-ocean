import { describe, expect, it } from "vitest";
import src from "three/src/renderers/webgl/WebGLPrograms.js?raw";

/**
 * `render/sunShafts.ts` flags its frame target `isXRRenderTarget` so three
 * applies the renderer's tone mapping and sRGB output to built-in
 * materials rendered into it, as it does for the canvas. r186 has no public
 * switch for that; this sentinel fails loudly if an upgrade drops the hook
 * so the frame does not silently go linear / un-tonemapped.
 */
describe("three.js compatibility", () => {
  it("WebGLPrograms still keys tone mapping and output colour space on isXRRenderTarget", () => {
    expect(src).toContain("currentRenderTarget.isXRRenderTarget === true");
    expect(src).toMatch(/toneMapping[\s\S]{0,400}isXRRenderTarget/);
    expect(src).toMatch(/outputColorSpace[^\n]*isXRRenderTarget[^\n]*texture\.colorSpace/);
  });
});
