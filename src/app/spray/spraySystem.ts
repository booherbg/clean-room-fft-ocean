/**
 * Spray particles (spec §1.14): drives a `SprayPass` (GPU particle pool) and
 * draws it as `THREE.Points` — one vertex per slot, position read from the
 * pool's state texture by `gl_VertexID`, a soft round sprite drawn
 * procedurally in the fragment shader, premultiplied "additive-ish"
 * blending, depth-tested against the water but writing no depth.
 *
 * Emitters: breaking crests in a disc around the camera (from the foam
 * fields of cascades 0 and 1) and, in boat mode above 2 m/s, the ship's two
 * bow-wave points. The rules live in `sprayField.ts`.
 */
import * as THREE from "three";
import type { OceanParams } from "../../core/params";
import { tierConfig } from "../../core/params";
import { SprayPass, type SprayCounts, type SprayInputs } from "../../gpu/sprayPass";
import type { CascadeTextures } from "../../render/cascadeTextures";
import type { Sky } from "../../render/sky";
import { withCommon } from "../../render/shaders/include";
import type { HullSample } from "../ship/hullPhysics";
import { bowPoints, bowRate, bowSlotProbability, SPRAY_TUNING, type SprayTuning } from "./sprayField";

/** Pool side: 180² = 32 400 slots. */
const POOL = 180;
/** Crest spawn disc radius around the camera, m. */
const SPAWN_RADIUS = 130;
/** Largest sprite, device pixels. */
const MAX_POINT_PX = 26;

const vert = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform ivec2 uDims;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform vec3 uSunDir;
uniform float uSize;
// drawingBufferHeight · P[1][1] / 2: metres → pixels at 1 m.
uniform float uProjScale;
uniform float uMaxPx;
out float vAlpha;
out float vMie;
out float vBow;

void main() {
  int id = gl_VertexID;
  ivec2 t = ivec2(id % uDims.x, id / uDims.x);
  vec4 A = texelFetch(uPos, t, 0);
  vec4 B = texelFetch(uVel, t, 0);
  float life = abs(B.w);
  if (life <= 0.0 || A.w >= life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vMie = 0.0;
    vBow = 0.0;
    return;
  }
  float u = A.w / life;
  float fade = min(1.0, u * 12.0) * (1.0 - u);
  vBow = B.w < 0.0 ? 1.0 : 0.0;
  // Per-slot size jitter (a fixed hash of the id): a mix of fine mist and
  // the odd larger blob reads as spray; one size reads as confetti.
  float h = fract(sin(float(id) * 12.9898) * 43758.5453);
  float jitter = 0.6 + 0.7 * h * h;
  vec4 view = viewMatrix * vec4(A.xyz, 1.0);
  float dist = max(1.0, -view.z);
  // A droplet cluster grows and thins as it flies.
  float metres = uSize * jitter * (0.13 + 0.3 * u) * (1.0 + 1.4 * vBow);
  float px = metres * uProjScale / dist;
  gl_PointSize = clamp(px, 1.0, uMaxPx);
  // Below a pixel: keep the point, dim it by its coverage so far spray is a
  // fine haze rather than popping pixels.
  float cover = clamp(px, 0.0, 1.0);
  // Far spray thins into the haze rather than stippling the horizon.
  float far = 1.0 - smoothstep(70.0, 170.0, dist);
  vAlpha = fade * cover * cover * far;
  vec3 vd = normalize(A.xyz - cameraPosition);
  vMie = pow(max(0.0, dot(vd, uSunDir)), 6.0);
  gl_Position = projectionMatrix * view;
}`;

const frag = /* glsl */ `
precision highp float;
//#include common
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform float uOpacity;
in float vAlpha;
in float vMie;
in float vBow;
out vec4 fragColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  float soft = 1.0 - d2;
  soft *= soft;
  float a = soft * vAlpha * uOpacity;
  // Airborne water: lit by the sky all round, by the sun on top, and it
  // glows when the sun is behind it (forward scatter).
  vec3 col = uSkyColor * 2.2 + uSunColor * (0.55 + 1.8 * vMie);
  col = finish(col);
  // Premultiplied; the alpha written is smaller than the colour weight so
  // the droplets brighten the water more than they cover it.
  fragColor = vec4(col * a, a * 0.6);
}`;

export interface SprayBowSource {
  samples: readonly HullSample[];
  /** Radians, 0 = −z (the ship's heading). */
  heading: number;
  /** Signed speed along the heading, m/s. */
  speed: number;
}

export interface SprayFrame {
  dt: number;
  params: OceanParams;
  cascades: readonly CascadeTextures[];
  camera: THREE.PerspectiveCamera;
  sky: Sky;
  /** Ship state in boat mode, else null. */
  bow: SprayBowSource | null;
  /** Skip drawing (camera under the surface). */
  hidden?: boolean;
  /** Drawing-buffer height in device pixels. */
  bufferHeight: number;
}

export class SpraySystem {
  readonly pass: SprayPass;
  readonly points: THREE.Points;
  private readonly material: THREE.RawShaderMaterial;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpColor2 = new THREE.Color();
  private readonly tmpAmbient = { sky: new THREE.Color(), ground: new THREE.Color() };
  private active = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly tuning: SprayTuning = SPRAY_TUNING,
  ) {
    this.pass = new SprayPass(POOL, POOL);
    const geo = new THREE.BufferGeometry();
    // Never read: the vertex shader fetches positions from the pool by id.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pass.slots * 3), 3));
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: withCommon(frag),
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uDims: { value: new THREE.Vector2(POOL, POOL) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSize: { value: 1 },
        uProjScale: { value: 1 },
        uMaxPx: { value: MAX_POINT_PX },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.3, 0.4, 0.6) },
        uOpacity: { value: 0.55 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.points.name = "Spray";
    this.points.visible = false;
  }

  /** Slots in the pool. */
  get capacity(): number {
    return this.pass.slots;
  }

  /** Empty the pool (mode change, quality rebuild). */
  reset(): void {
    this.pass.reset();
  }

  /** Live / crest / bow particle counts (synchronous readback; for tests and the HUD). */
  count(): SprayCounts {
    if (!this.active) return { alive: 0, crest: 0, bow: 0 };
    return this.pass.count(this.renderer);
  }

  /** Step the pool and bind this frame's state to the points. */
  update(f: SprayFrame): void {
    const { params } = f;
    const tier = tierConfig(params.quality);
    const c0 = f.cascades[0];
    const on = params.spray.enabled && tier.spray && params.foam.enabled && Boolean(c0?.foam);
    if (!on || !c0 || !c0.foam) {
      if (this.active) this.pass.reset();
      this.active = false;
      this.points.visible = false;
      return;
    }
    this.active = true;
    const t = this.tuning;
    const dt = Math.min(f.dt, 0.05);
    const density = params.spray.density;
    const cam = f.camera;
    cam.getWorldDirection(this.tmpDir);
    const fx = this.tmpDir.x;
    const fz = this.tmpDir.z;
    const flat = Math.hypot(fx, fz) || 1;
    const centre: [number, number] = [
      cam.position.x + (fx / flat) * SPAWN_RADIUS * 0.45,
      cam.position.z + (fz / flat) * SPAWN_RADIUS * 0.45,
    ];
    const c1 = f.cascades[1];
    const wd = params.waves.windDirection;

    let bow: SprayInputs["bow"] = null;
    if (f.bow) {
      const rate = bowRate(f.bow.speed, density, t);
      const pts = bowPoints(f.bow.samples);
      if (rate > 0 && pts.length === 2) {
        const port = pts.find((p) => p.side < 0) ?? pts[0]!;
        const stb = pts.find((p) => p.side > 0) ?? pts[1]!;
        const at = (p: (typeof pts)[number]): [number, number, number] => [
          p.world.x,
          Math.max(p.world.y, p.waterY ?? p.world.y),
          p.world.z,
        ];
        bow = {
          p: bowSlotProbability(rate, dt, this.pass.slots),
          a: at(port),
          b: at(stb),
          forward: [-Math.sin(f.bow.heading), -Math.cos(f.bow.heading)],
          speed: f.bow.speed,
          life: t.bowLife,
        };
      }
    }

    const prevTarget = this.renderer.getRenderTarget();
    this.pass.render(this.renderer, {
      dt,
      cascade0: { displacement: c0.displacement, foam: c0.foam, jacobian: c0.jacobian, size: c0.size },
      cascade1:
        c1 && c1.foam ? { displacement: c1.displacement, foam: c1.foam, jacobian: c1.jacobian, size: c1.size } : null,
      gravity: t.gravity,
      dragRate: t.dragRate,
      windDir: [Math.cos(wd), Math.sin(wd)],
      windSpeed: params.waves.windSpeed,
      windCarry: t.windCarry,
      foamThreshold: t.foamThreshold,
      jacThreshold: params.foam.threshold,
      crestP: t.crestGain * density * dt,
      crestLife: t.crestLife,
      centre,
      radius: SPAWN_RADIUS,
      bow,
    });
    this.renderer.setRenderTarget(prevTarget);

    const u = this.material.uniforms;
    u.uPos!.value = this.pass.positions;
    u.uVel!.value = this.pass.velocities;
    u.uSize!.value = params.spray.size;
    u.uProjScale!.value = (f.bufferHeight * cam.projectionMatrix.elements[5]!) / 2;
    (u.uSunDir!.value as THREE.Vector3).copy(f.sky.sunDirection);
    // Sun through the cloud deck; sky ambient a touch brighter than the
    // hemisphere light since spray sits in the open.
    const cloud = params.sky.cloudCoverage;
    f.sky.sunColor(this.tmpColor).multiplyScalar(params.sun.intensity * (1 - 0.75 * cloud));
    (u.uSunColor!.value as THREE.Color).copy(this.tmpColor);
    const amb = f.sky.ambient(this.tmpAmbient);
    this.tmpColor2.copy(amb.sky).lerp(this.tmpColor.setRGB(0.5, 0.5, 0.5), 0.35 * cloud);
    (u.uSkyColor!.value as THREE.Color).copy(this.tmpColor2);
    this.points.visible = !f.hidden;
  }

  dispose(): void {
    this.pass.dispose();
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
