/**
 * Rain (spec §1.16): falling streaks + the ripple field on the water.
 *
 * Streaks are a camera-locked volume of instanced quads whose world
 * positions are a *pure function of a static seed buffer and the clock* —
 * the vertex shader evaluates `core/rainField.ts streakPosition` (a mod()
 * over the volume), so there is no per-frame CPU work and no state texture:
 * a drop falls under gravity + wind drift, leaves the box, re-enters on the
 * opposite face. Each quad is stretched along the fall direction (a motion
 * streak), faces the camera, and is kept ~a pixel wide at any distance.
 *
 * Drops that hit the sea live in a `RainDropletPool`; a `RainPass` stamps
 * them into the rain field the water shader reads (dimples + matte +
 * splash sparkle). The splash reuses the field's `.a` channel rather than
 * the spray pool: the water shader lights it *on the displaced surface*,
 * so the sparkle always sits exactly on the wave that was hit.
 */
import * as THREE from "three";
import { tierConfig, type OceanParams } from "../../core/params";
import { splitmix32 } from "../../core/random";
import { RAIN_TUNING, RainDropletPool, rainVelocity, streakCount, streakHalfLength, type RainTuning } from "../../core/rainField";
import { RainPass } from "../../gpu/rainPass";
import { floatLinearSupported } from "../../gpu/targets";
import type { Sky } from "../../render/sky";
import { withCommon } from "../../render/shaders/include";

/** Streak instances in the volume (drawn count scales with the rain slider). */
const STREAKS = 8000;

const vert = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec4 aSeed;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec3 uVolume;
uniform vec3 uBoxMin;
uniform vec3 uVelBase;
uniform float uFallJitter;
uniform float uHalfLen;
uniform float uProjScale;
uniform float uIntensity;
out vec2 vUv;
out float vAlpha;

void main() {
  // core/rainField.ts rainVelocity: per-seed fall-speed jitter, shared drift.
  float jit = 1.0 + uFallJitter * (aSeed.w * 2.0 - 1.0);
  vec3 vel = vec3(uVelBase.x, uVelBase.y * jit, uVelBase.z);
  // A touch of per-drop sideways wander so the curtain is not laminar.
  vel.xz += (vec2(fract(aSeed.x * 97.13), fract(aSeed.z * 57.29)) - 0.5) * 0.9;
  // core/rainField.ts streakPosition: world-space wrap over the volume.
  vec3 p = mod(aSeed.xyz * uVolume + vel * uTime - uBoxMin, uVolume) + uBoxMin;

  vec3 toEye = p - cameraPosition;
  float dist = max(length(toEye), 0.4);
  vec3 view = toEye / dist;
  vec3 axis = normalize(vel);
  vec3 side = cross(axis, view);
  float sideLen = length(side);
  side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);

  // Streak: an exposure's travel, slightly longer far away so distant rain
  // still reads as lines rather than dissolving into noise.
  float len = uHalfLen * (0.7 + 0.6 * aSeed.w) * (1.0 + dist * 0.006);
  // A hair over a device pixel wide whatever the distance: any thinner and
  // the streaks alias to a stipple, any wider and they read as a curtain.
  float halfWidth = 0.6 * dist / uProjScale;
  vec3 world = p + axis * (position.y * len) + side * (position.x * halfWidth);

  vUv = position.xy;
  // Fade at the volume's far side (where a wrap would pop) and very close
  // to the eye; thin the whole curtain with the slider.
  float far = 1.0 - smoothstep(0.5, 0.95, dist / (0.5 * uVolume.x + 0.5 * uVolume.z));
  float near = smoothstep(0.6, 2.0, dist);
  vAlpha = far * near * (0.45 + 0.55 * uIntensity);
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
}`;

const frag = /* glsl */ `
precision highp float;
//#include common
uniform vec3 uColor;
uniform float uOpacity;
in vec2 vUv;
in float vAlpha;
out vec4 fragColor;

void main() {
  // Soft across the width, tapered along the streak.
  float across = 1.0 - vUv.x * vUv.x;
  // Full down the length with soft ends: a squared taper reads as a dash.
  float along = sqrt(max(1.0 - vUv.y * vUv.y, 0.0));
  float a = across * across * along * vAlpha * uOpacity;
  // A drop is a lens: it shows a demagnified image of the *whole* sky, so
  // its radiance is the bright part of the deck wherever it happens to be.
  // Composited (premultiplied over), that reads grey on the cloud deck and
  // bright against the dark sea — the reference's look — rather than the
  // white curtain a purely additive streak gives. The 0.88 leaves a sliver
  // of additive so a streak crossing the horizon band still glows.
  vec3 col = finish(uColor);
  fragColor = vec4(col * a, a * 0.88);
}`;

export interface RainFrame {
  dt: number;
  /** Sim clock, seconds (streak positions are a function of it). */
  t: number;
  params: OceanParams;
  camera: THREE.PerspectiveCamera;
  sky: Sky;
  /** Skip drawing the curtain (camera under the surface). */
  hidden?: boolean;
  /** Drawing-buffer height in device pixels (pixel-width streaks). */
  bufferHeight: number;
}

export class RainSystem {
  /** The streak curtain; add to the scene. */
  readonly mesh: THREE.Mesh;
  /** The ripple field stamped under the drops (bind to the water material). */
  readonly ripple: RainPass;
  readonly pool: RainDropletPool;
  /** Rain intensity in force this frame (0 when off or below Medium). */
  intensity = 0;

  private readonly material: THREE.RawShaderMaterial;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpColor2 = new THREE.Color();
  private readonly tmpAmbient = { sky: new THREE.Color(), ground: new THREE.Color() };
  private readonly tmpDir = new THREE.Vector3();
  private readonly halfVolume: THREE.Vector3;
  private active = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly tuning: RainTuning = RAIN_TUNING,
  ) {
    this.pool = new RainDropletPool(tuning.poolCapacity, 20260912, tuning);
    this.ripple = new RainPass(512, tuning.poolCapacity, floatLinearSupported(renderer), tuning);
    this.halfVolume = new THREE.Vector3(...tuning.volume).multiplyScalar(0.5);

    const base = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    const seeds = new Float32Array(STREAKS * 4);
    const rng = splitmix32(0xa11ce);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: withCommon(frag),
      uniforms: {
        uTime: { value: 0 },
        uVolume: { value: new THREE.Vector3(...tuning.volume) },
        uBoxMin: { value: new THREE.Vector3() },
        uVelBase: { value: new THREE.Vector3(0, -tuning.fallSpeed, 0) },
        uFallJitter: { value: tuning.fallJitter },
        uHalfLen: { value: 0.3 },
        uProjScale: { value: 1 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
        uOpacity: { value: 0.5 },
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
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21; // over the water and the spray
    this.mesh.name = "Rain";
    this.mesh.visible = false;
  }

  /** Streaks drawn last frame (tests / HUD). */
  get streaks(): number {
    return (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount * (this.mesh.visible ? 1 : 0);
  }

  /** Live ripples stamped last frame. */
  get ripples(): number {
    return this.ripple.liveCount;
  }

  /** Side of the ripple field square, metres. */
  get fieldSize(): number {
    return this.ripple.size;
  }

  /** World (x, z) of the ripple field's min corner this frame. */
  get fieldOrigin(): readonly [number, number] {
    return this.ripple.origin;
  }

  /** Forget the ripples (preset change, teleport). */
  reset(): void {
    this.pool.reset();
  }

  /** Step the pool, stamp the field, aim the curtain. Call once per tick. */
  update(f: RainFrame): void {
    const w = f.params.weather;
    const rain = Math.min(1, Math.max(0, w.rain));
    const on = w.rainEnabled && tierConfig(f.params.quality).rain && rain > 0;
    if (!on) {
      if (this.active) {
        this.pool.reset();
        this.ripple.clear(this.renderer);
      }
      this.active = false;
      this.intensity = 0;
      this.mesh.visible = false;
      return;
    }
    this.active = true;
    this.intensity = rain;
    const t = this.tuning;
    const cam = f.camera;
    // A long pause (a driven test, a tab in the background) would otherwise
    // dump thousands of impacts into the pool in one step.
    const dt = Math.min(Math.max(f.dt, 0), 0.05);

    // Ripples: spawn around the camera, stamp the field.
    this.pool.step(f.t, dt, rain, cam.position.x, cam.position.z);
    this.ripple.update(this.renderer, this.pool, f.t, cam.position.x, cam.position.z);

    // Streaks.
    this.mesh.visible = !f.hidden;
    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    geo.instanceCount = streakCount(STREAKS, rain);
    const u = this.material.uniforms;
    u.uTime!.value = f.t;
    const wd = f.params.waves.windDirection;
    const vel = rainVelocity([Math.cos(wd), Math.sin(wd)], f.params.waves.windSpeed, 0.5, t);
    (u.uVelBase!.value as THREE.Vector3).set(vel[0], vel[1], vel[2]);
    u.uHalfLen!.value = streakHalfLength(vel, t);
    u.uIntensity!.value = rain;
    // The volume sits a quarter ahead of the camera so most of it is on
    // screen; the wrap is world-space, so panning never drags the drops.
    cam.getWorldDirection(this.tmpDir);
    const boxMin = u.uBoxMin!.value as THREE.Vector3;
    boxMin.copy(cam.position).addScaledVector(this.tmpDir, 0.25 * (t.volume[2] as number)).sub(this.halfVolume);
    u.uProjScale!.value = (f.bufferHeight * cam.projectionMatrix.elements[5]!) / 2;

    // Lit by the sky: the drop is a lens onto the brightest part of the
    // deck, so this is the *bright* sky, not its average — grey under a
    // storm deck, warm under a sunset, and it tracks the horizon band.
    const cloud = f.params.sky.cloudCoverage;
    const amb = f.sky.ambient(this.tmpAmbient);
    this.tmpColor.copy(amb.sky).lerp(this.tmpColor2.setRGB(0.5, 0.5, 0.5), 0.4 * cloud);
    f.sky.sunColor(this.tmpColor2).multiplyScalar(0.2 * (1 - 0.8 * cloud));
    (u.uColor!.value as THREE.Color).copy(this.tmpColor).multiplyScalar(2.4).add(this.tmpColor2);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.ripple.dispose();
  }
}
