/**
 * Procedural sky (spec §1.7). One analytic shader serves two purposes:
 *  - rendered by a `CubeCamera` into a 128² cubemap whenever timeOfDay or
 *    cloudCoverage changes (the water's reflection source, linear);
 *  - drawn directly as the visible skybox (tonemapped + sRGB).
 * Sun direction from timeOfDay: elevation = sin((t − 6)/12 · π), azimuth fixed.
 * The moon shares the sun's azimuth (so its glitter path faces the default
 * camera) and climbs as the sun sinks: highest (~17°) at midnight.
 */
import * as THREE from "three";
import { withCommon } from "./shaders/include";
import { SKY } from "./skyConstants";
import skyVert from "./shaders/sky.vert.glsl?raw";
import skyFrag from "./shaders/sky.frag.glsl?raw";

const CUBE_SIZE = 128;
/** Radians; the sun sits toward −z (in front of a camera looking down −z). */
const SUN_AZIMUTH = 2.75;

const AMB_ZENITH_DAY = new THREE.Color(...SKY.zenithDay);
const AMB_HORIZON_DAY = new THREE.Color(...SKY.horizonDay);
const AMB_ZENITH_NIGHT = new THREE.Color(...SKY.zenithNight);
const AMB_HORIZON_NIGHT = new THREE.Color(...SKY.horizonNight);
const AMB_GROUND_NIGHT = new THREE.Color(0.02, 0.05, 0.07);
const SUN_TINT_HIGH = new THREE.Color(...SKY.sunTintHigh);
const SUN_TINT_LOW = new THREE.Color(...SKY.sunTintLow);

export function sunDirectionFromTime(timeOfDay: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = Math.sin(((timeOfDay - 6) / 12) * Math.PI);
  const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
  return out.set(horizontal * Math.sin(SUN_AZIMUTH), y, horizontal * Math.cos(SUN_AZIMUTH)).normalize();
}

const MOON_RISE_EL = SKY.moonRiseEl;
const MOON_FULL_EL = SKY.moonFullEl;

/** Moon direction for the sun's elevation: on the horizon as it rises, ~17° at midnight. */
export function moonDirectionFromSun(sunDir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const y = 0.3 * Math.min(1, Math.max(0, (sunDir.y - MOON_RISE_EL) / (-1 - MOON_RISE_EL)));
  const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
  return out.set(horizontal * Math.sin(SUN_AZIMUTH), y, horizontal * Math.cos(SUN_AZIMUTH)).normalize();
}

/** Moonlight strength (0–1) for the sun's elevation. */
export function moonIntensityFromSun(sunDir: THREE.Vector3): number {
  const t = Math.min(1, Math.max(0, (sunDir.y - MOON_RISE_EL) / (MOON_FULL_EL - MOON_RISE_EL)));
  return t * t * (3 - 2 * t);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The scene's fog as shared sky-shader uniforms (colour kept linear). */
interface FogUniforms {
  color: { value: THREE.Color };
  near: { value: number };
  far: { value: number };
}

function makeSkyMaterial(
  tonemap: boolean,
  sunDir: THREE.Vector3,
  moonDir: THREE.Vector3,
  coverage: { value: number },
  fog: FogUniforms,
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: skyVert,
    fragmentShader: withCommon(skyFrag),
    defines: tonemap ? { TONEMAP: 1 } : {},
    uniforms: {
      uSunDir: { value: sunDir },
      uMoonDir: { value: moonDir },
      uCloudCoverage: coverage,
      uFogColor: fog.color,
      uFogNear: fog.near,
      uFogFar: fog.far,
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
}

export class Sky {
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, 1, 0);
  readonly skybox: THREE.Mesh;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly target: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly cubeScene: THREE.Scene;
  private readonly coverage = { value: 0 };
  private readonly fog: FogUniforms = {
    color: { value: new THREE.Color(1, 1, 1) },
    near: { value: 0 },
    far: { value: 1e9 },
  };
  private lastTime = NaN;
  private lastCoverage = NaN;
  private lastFog = "";

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.target);
    this.cubeScene = new THREE.Scene();
    const geo = new THREE.BoxGeometry(2, 2, 2);
    const inner = new THREE.Mesh(
      geo,
      makeSkyMaterial(false, this.sunDirection, this.moonDirection, this.coverage, this.fog),
    );
    inner.frustumCulled = false;
    this.cubeScene.add(inner);

    this.skybox = new THREE.Mesh(geo, makeSkyMaterial(true, this.sunDirection, this.moonDirection, this.coverage, this.fog));
    this.skybox.frustumCulled = false;
    this.skybox.renderOrder = -1;
  }

  get cubemap(): THREE.CubeTexture {
    return this.target.texture;
  }

  /** Moonlight strength (0 by day, 1 at night). */
  get moonIntensity(): number {
    return moonIntensityFromSun(this.sunDirection);
  }

  /**
   * Linear colour of direct sunlight for the current elevation — the
   * shader's `sunTint` (warm near the horizon, gone below it).
   */
  sunColor(out = new THREE.Color()): THREE.Color {
    const el = this.sunDirection.y;
    const warm = 1 - smoothstep(0, SKY.sunWarmEl, el);
    const s = smoothstep(SKY.sunFadeEl, 0, el);
    return out.copy(SUN_TINT_HIGH).lerp(SUN_TINT_LOW, warm * warm).multiplyScalar(s);
  }

  /**
   * Ambient sky / ground colours (linear) for a hemisphere light: the
   * shader's zenith and horizon gradient at the current sun elevation, the
   * ground a dim sea-blue.
   */
  ambient(out = { sky: new THREE.Color(), ground: new THREE.Color() }): { sky: THREE.Color; ground: THREE.Color } {
    const el = this.sunDirection.y;
    const day = smoothstep(SKY.dayElLo, SKY.dayElHi, el);
    const zenith = out.sky.copy(AMB_ZENITH_NIGHT).lerp(AMB_ZENITH_DAY, day);
    const horizon = out.ground.copy(AMB_HORIZON_NIGHT).lerp(AMB_HORIZON_DAY, day);
    zenith.lerp(horizon, 0.5);
    horizon.multiplyScalar(0.35).lerp(AMB_GROUND_NIGHT, 0.5);
    return out;
  }

  /** Bumped every time the cubemap / sun / moon are re-rendered; consumers re-bind on change. */
  version = 0;

  /** Force the next `update` to re-render (e.g. after a WebGL context restore). */
  invalidate(): void {
    this.lastTime = NaN;
    this.lastCoverage = NaN;
    this.lastFog = "";
  }

  /** Re-render the cubemap only when the inputs change. */
  update(timeOfDay: number, cloudCoverage: number, fog: { color: string; near: number; far: number }): void {
    const fogKey = `${fog.color}/${fog.near}/${fog.far}`;
    if (timeOfDay === this.lastTime && cloudCoverage === this.lastCoverage && fogKey === this.lastFog) return;
    this.version++;
    this.lastTime = timeOfDay;
    this.lastCoverage = cloudCoverage;
    this.lastFog = fogKey;
    sunDirectionFromTime(timeOfDay, this.sunDirection);
    moonDirectionFromSun(this.sunDirection, this.moonDirection);
    this.coverage.value = cloudCoverage;
    this.fog.color.value.set(fog.color);
    this.fog.near.value = fog.near;
    this.fog.far.value = fog.far;
    this.cubeCamera.update(this.renderer, this.cubeScene);
  }

  dispose(): void {
    this.target.dispose();
    (this.skybox.material as THREE.Material).dispose();
    this.skybox.geometry.dispose();
    this.cubeScene.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
  }
}
