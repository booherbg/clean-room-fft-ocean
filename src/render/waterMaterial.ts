/**
 * Water material: GLSL ES 3.00 raw shader; uniforms from `OceanParams`,
 * textures from up to three `CascadeTextures`, reflections from the sky
 * cubemap. Shading order per spec §1.6 lives in `shaders/water.frag.glsl`.
 */
import * as THREE from "three";
import { tierConfig, type OceanParams } from "../core/params";
import type { CascadeTextures } from "./cascadeTextures";
import { withCommon } from "./shaders/include";
import vert from "./shaders/water.vert.glsl?raw";
import frag from "./shaders/water.frag.glsl?raw";

const MAX_CASCADES = 3;

let blackTexture: THREE.DataTexture | undefined;
/** 1×1 zero texture bound where a cascade has no foam or does not exist. */
export function blackTex(): THREE.DataTexture {
  if (!blackTexture) {
    blackTexture = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    blackTexture.needsUpdate = true;
  }
  return blackTexture;
}

function toLinear(hex: string): THREE.Color {
  return new THREE.Color(hex); // sRGB hex → linear working colour space
}

export class WaterMaterial extends THREE.RawShaderMaterial {
  readonly cascadeCount: number;

  constructor(cascadeCount: number) {
    const count = Math.max(1, Math.min(MAX_CASCADES, cascadeCount));
    super({
      glslVersion: THREE.GLSL3,
      vertexShader: withCommon(vert),
      fragmentShader: withCommon(frag),
      defines: { CASCADES: count },
      uniforms: {
        uOrigin: { value: new THREE.Vector2() },
        uBaseCell: { value: 1 },
        uSizes: { value: new THREE.Vector3(1, 1, 1) },
        uChoppiness: { value: 1 },
        uDisp0: { value: blackTex() },
        uDisp1: { value: blackTex() },
        uDisp2: { value: blackTex() },
        uDeriv0: { value: blackTex() },
        uDeriv1: { value: blackTex() },
        uDeriv2: { value: blackTex() },
        uFoam0: { value: blackTex() },
        uFoam1: { value: blackTex() },
        uFoam2: { value: blackTex() },
        uWakeTex: { value: blackTex() },
        uWakeOrigin: { value: new THREE.Vector2() },
        uWakeSize: { value: 0 },
        uRainField: { value: blackTex() },
        uRainOrigin: { value: new THREE.Vector2() },
        uRainSize: { value: 0 },
        uRainIntensity: { value: 0 },
        uSky: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 1.5 },
        uSunElevation: { value: 1 },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonIntensity: { value: 0 },
        uWaterColor: { value: new THREE.Color() },
        uAbsorption: { value: new THREE.Color() },
        uTransmission: { value: new THREE.Color() },
        uDepth: { value: 30 },
        uSssIntensity: { value: 1 },
        uSssPower: { value: 4 },
        uF0: { value: 0.02 },
        uIor: { value: 1.33 },
        uRefraction: { value: 0.1 },
        uFoamEnabled: { value: 1 },
        uFogColor: { value: new THREE.Color() },
        uFogNear: { value: 500 },
        uFogFar: { value: 1800 },
        uCloudCoverage: { value: 0 },
        uUnderwater: { value: 0 },
        uSceneColor: { value: blackTex() },
        uSceneDepth: { value: blackTex() },
        uSsr: { value: 1 },
        uTime: { value: 0 },
        uTerrainTex: { value: blackTex() },
        uTerrainOrigin: { value: new THREE.Vector2() },
        uTerrainSize: { value: 0 },
      },
      side: THREE.DoubleSide,
    });
    this.cascadeCount = count;
  }

  setParams(p: OceanParams): void {
    const u = this.uniforms;
    (u.uChoppiness as THREE.IUniform).value = p.waves.choppiness;
    (u.uWaterColor as THREE.IUniform).value = toLinear(p.color.waterColor);
    (u.uAbsorption as THREE.IUniform).value = toLinear(p.color.absorptionColor);
    (u.uTransmission as THREE.IUniform).value = toLinear(p.color.transmissionColor);
    (u.uDepth as THREE.IUniform).value = p.color.depth;
    (u.uSssIntensity as THREE.IUniform).value = p.sss.intensity;
    (u.uSssPower as THREE.IUniform).value = p.sss.power;
    const ior = p.fresnel.iorRatio;
    (u.uIor as THREE.IUniform).value = ior;
    (u.uF0 as THREE.IUniform).value = ((ior - 1) / (ior + 1)) ** 2;
    (u.uRefraction as THREE.IUniform).value = p.fresnel.refractionStrength;
    (u.uSsr as THREE.IUniform).value = p.fresnel.ssr && tierConfig(p.quality).ssr ? 1 : 0;
    (u.uFoamEnabled as THREE.IUniform).value = p.foam.enabled ? 1 : 0;
    (u.uFogColor as THREE.IUniform).value = toLinear(p.fog.color);
    (u.uFogNear as THREE.IUniform).value = p.fog.near;
    (u.uFogFar as THREE.IUniform).value = p.fog.far;
    (u.uSunIntensity as THREE.IUniform).value = p.sun.intensity;
    (u.uCloudCoverage as THREE.IUniform).value = p.sky.cloudCoverage;
  }

  /** Bind the cascade textures (call every frame: sims ping-pong targets). */
  setCascades(c: readonly CascadeTextures[]): void {
    const u = this.uniforms;
    const sizes = (u.uSizes as THREE.IUniform).value as THREE.Vector3;
    const sz = [1, 1, 1];
    for (let i = 0; i < MAX_CASCADES; i++) {
      const cas = c[i];
      (u[`uDisp${i}`] as THREE.IUniform).value = cas ? cas.displacement : blackTex();
      (u[`uDeriv${i}`] as THREE.IUniform).value = cas ? cas.derivatives : blackTex();
      (u[`uFoam${i}`] as THREE.IUniform).value = cas?.foam ?? blackTex();
      if (cas) sz[i] = cas.size;
    }
    sizes.set(sz[0] as number, sz[1] as number, sz[2] as number);
  }

  setSky(env: THREE.CubeTexture, sunDir: THREE.Vector3, moonDir: THREE.Vector3, moonIntensity: number): void {
    const u = this.uniforms;
    (u.uSky as THREE.IUniform).value = env;
    ((u.uSunDir as THREE.IUniform).value as THREE.Vector3).copy(sunDir);
    (u.uSunElevation as THREE.IUniform).value = sunDir.y;
    ((u.uMoonDir as THREE.IUniform).value as THREE.Vector3).copy(moonDir);
    (u.uMoonIntensity as THREE.IUniform).value = moonIntensity;
  }

  setOrigin(x: number, z: number, baseCell: number): void {
    ((this.uniforms.uOrigin as THREE.IUniform).value as THREE.Vector2).set(x, z);
    (this.uniforms.uBaseCell as THREE.IUniform).value = baseCell;
  }

  /**
   * Bind the scene pre-pass (`ScenePass`): linear colour (alpha 0 = nothing)
   * and the depth buffer (1 = nothing) of the objects behind / above the water.
   */
  setScene(color: THREE.Texture, depth: THREE.Texture): void {
    (this.uniforms.uSceneColor as THREE.IUniform).value = color;
    (this.uniforms.uSceneDepth as THREE.IUniform).value = depth;
  }

  /**
   * Bind a terrain heightmap (metres in `.r`) covering the square of side
   * `extent` whose min corner is at world (x, z): waves shoal and flatten
   * where the seabed rises. `null` disables it.
   */
  setTerrain(tex: THREE.Texture | null, x = 0, z = 0, extent = 0): void {
    const u = this.uniforms;
    (u.uTerrainTex as THREE.IUniform).value = tex ?? blackTex();
    ((u.uTerrainOrigin as THREE.IUniform).value as THREE.Vector2).set(x, z);
    (u.uTerrainSize as THREE.IUniform).value = tex ? extent : 0;
  }

  /** Simulation clock, seconds (shoreline foam lapping). */
  setTime(t: number): void {
    (this.uniforms.uTime as THREE.IUniform).value = t;
  }

  /** Camera below the surface: shade the underside (TIR / Snell's window) and fog by water (spec §1.10). */
  setUnderwater(below: boolean): void {
    (this.uniforms.uUnderwater as THREE.IUniform).value = below ? 1 : 0;
  }

  /**
   * Bind the boat-wake field `(h, ∂h/∂x, ∂h/∂z, foam)` covering the square
   * of side `size` whose min corner is at world (x, z). `null` disables it.
   */
  setWake(tex: THREE.Texture | null, x = 0, z = 0, size = 0): void {
    const u = this.uniforms;
    (u.uWakeTex as THREE.IUniform).value = tex ?? blackTex();
    ((u.uWakeOrigin as THREE.IUniform).value as THREE.Vector2).set(x, z);
    (u.uWakeSize as THREE.IUniform).value = tex ? size : 0;
  }

  /**
   * Bind the rain ripple field `(∂h/∂x, ∂h/∂z, wetness, splash)` covering
   * the square of side `size` whose min corner is at world (x, z), at rain
   * intensity `intensity` ∈ [0,1] (spec §1.16). Intensity 0 costs the
   * shader nothing — the whole block is branched over.
   */
  setRain(tex: THREE.Texture | null, x = 0, z = 0, size = 0, intensity = 0): void {
    const u = this.uniforms;
    const on = tex !== null && intensity > 0;
    (u.uRainField as THREE.IUniform).value = tex ?? blackTex();
    ((u.uRainOrigin as THREE.IUniform).value as THREE.Vector2).set(x, z);
    (u.uRainSize as THREE.IUniform).value = on ? size : 0;
    (u.uRainIntensity as THREE.IUniform).value = on ? intensity : 0;
  }
}
