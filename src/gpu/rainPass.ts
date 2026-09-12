/**
 * Rain field pass (spec §1.16): a 512² float field on a world-space square
 * that follows the camera in texel-snapped steps. Each frame it is cleared
 * and every live drop of a `RainDropletPool` is stamped as an instanced
 * quad running `rain.frag.glsl` with additive blending — no ping-pong and
 * no feedback: a ripple is a pure function of its drop's age, so the field
 * is rebuilt exactly each frame (`(slope.x, slope.z, wetness, splash)`).
 *
 * The water shader samples it once: `n.xz += field.rg`, matte from `.b`,
 * splash sparkle from `.a`.
 */
import * as THREE from "three";
import { RAIN_TUNING, snapToCell, type RainDropletPool, type RainTuning } from "../core/rainField";
import frag from "./rain.frag.glsl?raw";
import { makeFloatTarget } from "./targets";

const vert = /* glsl */ `
precision highp float;
precision highp int;
// Base quad corner in (−1..1)²; per-instance drop (x, z, age01, life).
in vec3 position;
in vec4 aRipple;
uniform vec2 uOrigin;
uniform float uSize;
uniform float uR0;
uniform float uRingSpeed;
uniform float uRingWidth;
out vec2 vLocal;
out float vRadius;
out float vAmp;
out float vAge01;

void main() {
  float age01 = aRipple.z;
  float life = aRipple.w;
  // core/rainField.ts ringRadius / ringAmplitude, exactly.
  float R = uR0 + uRingSpeed * age01 * life;
  float attack = min(1.0, age01 / 0.08);
  vAmp = attack * (1.0 - age01) * sqrt(uR0 / R);
  vRadius = R;
  vAge01 = age01;
  float half_ = R + 2.0 * uRingWidth;
  vLocal = position.xy * half_;
  vec2 uv = (aRipple.xy + vLocal - uOrigin) / uSize;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export class RainPass {
  readonly target: THREE.WebGLRenderTarget;
  /** Field side, metres. */
  readonly size: number;
  /** World (x, z) of the field's min corner this frame. */
  readonly origin: [number, number] = [0, 0];
  /** Live ripples stamped last update (for tests / HUD). */
  liveCount = 0;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.RawShaderMaterial;
  private readonly instances: THREE.InstancedBufferAttribute;
  private readonly data: Float32Array;
  private readonly tmpClear = new THREE.Color();

  /** `linear`: bilinear-filter the field (needs OES_texture_float_linear). */
  constructor(
    readonly N = 512,
    capacity = RAIN_TUNING.poolCapacity,
    linear = false,
    tuning: RainTuning = RAIN_TUNING,
  ) {
    this.size = tuning.fieldSize;
    const target = makeFloatTarget(N, 1, { linear });
    // The field is a window around the camera, not a periodic tile.
    target.texture.wrapS = THREE.ClampToEdgeWrapping;
    target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.target = target;

    const base = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute("position", base.getAttribute("position"));
    this.data = new Float32Array(capacity * 4);
    this.instances = new THREE.InstancedBufferAttribute(this.data, 4);
    this.instances.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aRipple", this.instances);
    geo.instanceCount = 0;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uOrigin: { value: new THREE.Vector2() },
        uSize: { value: this.size },
        uR0: { value: tuning.r0 },
        uRingSpeed: { value: tuning.ringSpeed },
        uRingWidth: { value: tuning.ringWidth },
      },
      depthTest: false,
      depthWrite: false,
      // Pure accumulation: gradients of overlapping rings sum.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /**
   * Rebuild the field for this frame: centre the square on the camera
   * (snapped to the texel grid so the stamps never swim), upload the live
   * ripples, clear, draw. Leaves the render target as it found it.
   */
  update(renderer: THREE.WebGLRenderer, pool: RainDropletPool, t: number, camX: number, camZ: number): void {
    const cell = this.size / this.N;
    this.origin[0] = snapToCell(camX, cell) - this.size / 2;
    this.origin[1] = snapToCell(camZ, cell) - this.size / 2;

    const count = pool.fillAttributes(t, this.data);
    this.liveCount = count;
    const geo = this.mesh.geometry as THREE.InstancedBufferGeometry;
    geo.instanceCount = count;
    this.instances.needsUpdate = true;
    (this.material.uniforms.uOrigin!.value as THREE.Vector2).set(this.origin[0], this.origin[1]);

    const prev = renderer.getRenderTarget();
    // The scene's clear colour is the renderer's, not ours: borrow it.
    const clearColor = renderer.getClearColor(this.tmpClear).getHex();
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (count > 0) renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clearColor, clearAlpha);
  }

  /** Zero the field without stamping anything (rain switched off). */
  clear(renderer: THREE.WebGLRenderer): void {
    this.liveCount = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    const prev = renderer.getRenderTarget();
    const clearColor = renderer.getClearColor(this.tmpClear).getHex();
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clearColor, clearAlpha);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
  }
}
