/**
 * Island terrain mesh (spec §1.11): a heightfield grid from
 * `core/terrain.islandHeight`, shaded by `shaders/terrain.frag.glsl` with
 * the same sky cubemap, sun and fog as the water. Tagged
 * `userData.castsWaterDepth` so `ScenePass` writes it into the scene
 * colour + depth target the water reads for shoreline foam, shallow-water
 * colour and reflections.
 */
import * as THREE from "three";
import type { OceanParams } from "../core/params";
import { sampleHeightmap } from "../core/terrain";
import type { Sky } from "./sky";
import { withCommon } from "./shaders/include";
import vert from "./shaders/terrain.vert.glsl?raw";
import frag from "./shaders/terrain.frag.glsl?raw";

export interface TerrainOptions {
  /** Grid resolution per side (default 256). */
  resolution?: number;
  /** Side of the covered square, metres (default 1200: the shelf must reach below the water's virtual floor at the edge). */
  extent?: number;
  /** World position of the island centre (default (−70, 0, −450): in front of the default camera). */
  position?: THREE.Vector3;
}

export const DEFAULT_ISLAND_POSITION = new THREE.Vector3(-70, 0, -450);

export class Terrain extends THREE.Mesh {
  readonly seed: number;
  readonly extent: number;
  readonly resolution: number;
  /**
   * The heightmap as a half-float texture (metres, `.r`), covering the
   * square of side `extent` centred on `position`; the water samples it to
   * shoal its waves and to know the seabed under each vertex.
   */
  readonly heightTexture: THREE.DataTexture;
  declare material: THREE.RawShaderMaterial;

  constructor(seed: number, opts: TerrainOptions = {}) {
    const N = opts.resolution ?? 256;
    const extent = opts.extent ?? 1200;
    const heights = sampleHeightmap(N, extent, seed);
    const geo = new THREE.PlaneGeometry(extent, extent, N - 1, N - 1);
    // PlaneGeometry lies in xy; lay it flat with +y up. Its rows run from
    // +y (top) downward, which after the rotation is −z → +z: matches the
    // heightmap's row order (z increasing with the row).
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < N * N; i++) pos.setY(i, heights[i] as number);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: withCommon(frag),
      uniforms: {
        uSky: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 1.5 },
        uSunElevation: { value: 1 },
        uFogColor: { value: new THREE.Color() },
        uFogNear: { value: 500 },
        uFogFar: { value: 1800 },
        uTime: { value: 0 },
        uUnderwater: { value: 0 },
        uWaterColor: { value: new THREE.Color() },
        uAbsorption: { value: new THREE.Color() },
        uLinearOut: { value: 0 },
      },
    });
    super(geo, material);
    this.seed = seed;
    this.extent = extent;
    this.resolution = N;
    this.name = "Terrain";
    this.userData.castsWaterDepth = true;
    this.position.copy(opts.position ?? DEFAULT_ISLAND_POSITION);

    const half = new Uint16Array(N * N);
    for (let i = 0; i < N * N; i++) half[i] = THREE.DataUtils.toHalfFloat(heights[i] as number);
    this.heightTexture = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTexture.generateMipmaps = false;
    this.heightTexture.needsUpdate = true;
  }

  /** Bind this terrain's heightmap to the water (wave shoaling, seabed depth). */
  attachTo(water: { setTerrain(tex: THREE.Texture | null, x: number, z: number, extent: number): void }): void {
    water.setTerrain(this.heightTexture, this.position.x - this.extent / 2, this.position.z - this.extent / 2, this.extent);
  }

  setParams(p: OceanParams): void {
    const u = this.material.uniforms;
    ((u.uFogColor as THREE.IUniform).value as THREE.Color).set(p.fog.color);
    (u.uFogNear as THREE.IUniform).value = p.fog.near;
    (u.uFogFar as THREE.IUniform).value = p.fog.far;
    (u.uSunIntensity as THREE.IUniform).value = p.sun.intensity;
    ((u.uWaterColor as THREE.IUniform).value as THREE.Color).set(p.color.waterColor);
    ((u.uAbsorption as THREE.IUniform).value as THREE.Color).set(p.color.absorptionColor);
  }

  /** Per frame: sky, clock, and whether the camera is under the water. */
  update(sky: Sky, time: number, underwater: boolean): void {
    const u = this.material.uniforms;
    (u.uSky as THREE.IUniform).value = sky.cubemap;
    ((u.uSunDir as THREE.IUniform).value as THREE.Vector3).copy(sky.sunDirection);
    (u.uSunElevation as THREE.IUniform).value = sky.sunDirection.y;
    (u.uTime as THREE.IUniform).value = time;
    (u.uUnderwater as THREE.IUniform).value = underwater ? 1 : 0;
  }

  /** Terrain height (metres) at world (x, z): the nearest grid sample. */
  heightAt(x: number, z: number): number {
    const N = this.resolution;
    const lx = x - this.position.x;
    const lz = z - this.position.z;
    const step = this.extent / (N - 1);
    const i = Math.round((lx + this.extent / 2) / step);
    const j = Math.round((lz + this.extent / 2) / step);
    if (i < 0 || j < 0 || i >= N || j >= N) return -Infinity;
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    return pos.getY(j * N + i) + this.position.y;
  }

  override dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.heightTexture.dispose();
  }
}
