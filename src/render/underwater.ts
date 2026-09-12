/**
 * Underwater volume (spec §1.10). When the camera is below the surface the
 * skybox is swapped for this: a camera-locked box at the far plane whose
 * fragment shader paints the water body (darker with depth, lit from above)
 * and, looking down, a virtual floor at `color.depth` metres carrying an
 * animated procedural caustics web, all fogged by the same extinction the
 * water surface uses for its underside so the two meet without a seam.
 *
 * Caustics are not user params yet (the demo docs' defaults: intensity
 * 0.61, scale 65 m); tune them through `Underwater.caustics`.
 */
import * as THREE from "three";
import type { OceanParams } from "../core/params";
import type { Sky } from "./sky";
import { withCommon } from "./shaders/include";

const vert = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
}
`;

const frag = /* glsl */ `
precision highp float;
precision highp samplerCube;

//#include common

in vec3 vDir;
uniform samplerCube uSky;
uniform vec3 uSunDir;
uniform float uSunIntensity;
uniform vec3 uCamPos;
uniform vec3 uWaterColor;
uniform vec3 uAbsorption;
uniform float uDepth;
uniform float uCausticIntensity;
uniform float uCausticScale;
uniform float uTime;
out vec4 fragColor;

void main() {
  vec3 dir = normalize(vDir);
  vec3 l = normalize(uSunDir);
  vec3 sunCol = sunTint(l.y) * uSunIntensity;
  vec3 skyUp = texture(uSky, vec3(0.0, 1.0, 0.0)).rgb;
  vec3 light = underwaterLight(skyUp, sunCol, l.y);
  vec3 colour = underwaterRadiance(dir, uWaterColor, light, l, sunCol);

  // Virtual floor at y = -depth: a pale bed lit by the caustics web, seen
  // through its distance of water.
  float floorY = -uDepth;
  if (dir.y < -0.01 && uCamPos.y > floorY) {
    float t = (floorY - uCamPos.y) / dir.y;
    vec3 p = uCamPos + dir * t;
    // Sunlight through a rippling surface: the web drifts down-sun.
    vec2 uv = (p.xz + l.xz * uTime * 0.6) / uCausticScale * 8.0;
    float c = caustics(uv, uTime);
    // Light reaching the floor is what the surface let through, absorbed on
    // the way down; the web is that light focused.
    vec3 down = underwaterExtinction(uAbsorption, uDepth);
    vec3 bed = vec3(0.6, 0.55, 0.45) * light * down * (0.4 + c * uCausticIntensity * 3.0);
    vec3 ext = underwaterExtinction(uAbsorption, t);
    colour = mix(colour, bed, ext);
  }

  fragColor = vec4(finish(colour), 1.0);
}
`;

export interface CausticsOptions {
  intensity: number;
  /** Pattern repeat in metres. */
  scale: number;
}

export class Underwater {
  readonly mesh: THREE.Mesh;
  readonly caustics: CausticsOptions = { intensity: 0.61, scale: 65 };
  private readonly material: THREE.RawShaderMaterial;

  constructor() {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: withCommon(frag),
      uniforms: {
        uSky: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 1.5 },
        uCamPos: { value: new THREE.Vector3() },
        uWaterColor: { value: new THREE.Color() },
        uAbsorption: { value: new THREE.Color() },
        uDepth: { value: 30 },
        uCausticIntensity: { value: 0.61 },
        uCausticScale: { value: 65 },
        uTime: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.name = "Underwater";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.visible = false;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  update(camera: THREE.Camera, params: OceanParams, sky: Sky, time: number): void {
    const u = this.material.uniforms;
    (u.uSky as THREE.IUniform).value = sky.cubemap;
    ((u.uSunDir as THREE.IUniform).value as THREE.Vector3).copy(sky.sunDirection);
    (u.uSunIntensity as THREE.IUniform).value = params.sun.intensity;
    ((u.uCamPos as THREE.IUniform).value as THREE.Vector3).copy(camera.position);
    ((u.uWaterColor as THREE.IUniform).value as THREE.Color).set(params.color.waterColor);
    ((u.uAbsorption as THREE.IUniform).value as THREE.Color).set(params.color.absorptionColor);
    (u.uDepth as THREE.IUniform).value = params.color.depth;
    (u.uCausticIntensity as THREE.IUniform).value = this.caustics.intensity;
    (u.uCausticScale as THREE.IUniform).value = this.caustics.scale;
    (u.uTime as THREE.IUniform).value = time;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
