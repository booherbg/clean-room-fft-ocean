/**
 * Underwater sun shafts (spec §1.13): a radial light-scattering post pass
 * (Mitchell 2007). When the camera is below the surface the frame is
 * rendered into a colour target instead of the canvas, then:
 *
 *  1. mask   (half res)  "sky through the surface": bright frame pixels whose
 *                        view direction rises toward Snell's window, plus the
 *                        refracted sun's lobe modulated by the frame, both
 *                        broken into beams by the caustics web sampled where
 *                        the ray meets the surface (the same web the floor
 *                        shows, so beams and floor caustics drift together);
 *  2. blur   (half res)  48-sample radial march toward the refracted sun's
 *                        screen position with decay / weight / exposure;
 *  3. composite (canvas) frame + shafts × sun tint × strength.
 *
 * `strength` folds in the depth below the surface (shafts fade with
 * e^(−depth/20 m)), the sun's elevation and intensity (none at night) and a
 * smooth fade as the sun goes behind the camera. When it reaches 0 the
 * caller should render straight to the canvas (`active` is false).
 *
 * The frame target is flagged `isXRRenderTarget` so three.js applies the
 * renderer's tone mapping + sRGB output to built-in materials (the ship,
 * rope lines, probe overlays) as it does for the canvas; the
 * RawShaderMaterials already `finish()` their own colour. The target is
 * pinned to RGBA8 so the composite pass samples display-ready bytes
 * untouched (the MSAA renderbuffer and the resolve texture must agree on
 * the format, and with an sRGB colour space three would pick SRGB8_ALPHA8
 * for one of them).
 *
 * Why the private flag: three r186 keys "tone-map into this target" on
 * `isXRRenderTarget` alone (`WebGLPrograms.getParameters`); there is no
 * public option, and the public MSAA path (`samples`, `UnsignedByteType`)
 * is already what this target uses. The alternative — every built-in
 * material applying the ACES + sRGB `finish()` itself via
 * `onBeforeCompile`, with the renderer set to NoToneMapping / linear
 * output and the night exposure nudge plumbed as a uniform — is a wider
 * change for no visible gain. `tests/threeCompat.test.ts` fails loudly if
 * an upgrade drops the hook.
 */
import * as THREE from "three";
import type { OceanParams } from "../core/params";
import { NULL_TIMER, type GpuTimer } from "../gpu/gpuTimer";
import { FullscreenPass } from "../gpu/passes/FullscreenPass";
import type { Sky } from "./sky";
import type { CausticsOptions } from "./underwater";
import { withCommon } from "./shaders/include";
import rawFrag from "./shaders/sunShafts.frag.glsl?raw";

const WHITE = new THREE.Color(1, 1, 1);

const frag = withCommon(rawFrag);

const DEPTH_FALLOFF_M = 20;

export interface SunShaftOptions {
  density: number;
  decay: number;
  weight: number;
  exposure: number;
  /** Longest radial march in screen (uv) units. */
  maxLength: number;
  /** Frame luminance (display space) where the mask starts / saturates. */
  threshold: number;
  knee: number;
}

export class SunShafts {
  readonly options: SunShaftOptions = {
    density: 0.85,
    decay: 0.975,
    weight: 0.075,
    exposure: 1.0,
    maxLength: 1.0,
    threshold: 0.5,
    knee: 0.95,
  };
  /** Refracted sun direction below the surface (world, unit). */
  readonly sunDirW = new THREE.Vector3(0, 1, 0);
  /** Refracted sun on screen (uv, v up); may lie outside [0, 1]. */
  readonly sunUv = new THREE.Vector2(0.5, 0.5);
  /** 0 = nothing to draw this frame. */
  strength = 0;

  private readonly frame: THREE.WebGLRenderTarget;
  private readonly mask: THREE.WebGLRenderTarget;
  private readonly shafts: THREE.WebGLRenderTarget;
  private readonly maskPass: FullscreenPass;
  private readonly blurPass: FullscreenPass;
  private readonly compositePass: FullscreenPass;
  private readonly size = new THREE.Vector2();
  private readonly tint = new THREE.Color();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.frame = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.SRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
    });
    this.frame.texture.name = "SunShaftsFrame";
    // Display-ready bytes, stored linearly: the MSAA renderbuffer and the
    // resolve texture must agree on RGBA8 (three would otherwise pick
    // SRGB8_ALPHA8 for one of them and the blit fails).
    this.frame.texture.internalFormat = "RGBA8";
    (this.frame as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    const half = (name: string): THREE.WebGLRenderTarget => {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      });
      t.texture.name = name;
      return t;
    };
    this.mask = half("SunShaftsMask");
    this.shafts = half("SunShaftsBlur");

    this.maskPass = new FullscreenPass(
      frag,
      {
        uSize: { value: new THREE.Vector2(1, 1) },
        uFrame: { value: this.frame.texture },
        uInvProj: { value: new THREE.Matrix4() },
        uInvViewRot: { value: new THREE.Matrix3() },
        uSunDirW: { value: this.sunDirW },
        uCamPos: { value: new THREE.Vector3() },
        uSurfaceY: { value: 0 },
        uCausticScale: { value: 65 },
        uTime: { value: 0 },
        uThreshold: { value: 0.3 },
        uKnee: { value: 0.8 },
      },
      { defines: { STAGE_MASK: 1 } },
    );
    this.blurPass = new FullscreenPass(
      frag,
      {
        uSize: { value: new THREE.Vector2(1, 1) },
        uMask: { value: this.mask.texture },
        uSunUv: { value: this.sunUv },
        uDensity: { value: 1 },
        uDecay: { value: 0.95 },
        uWeight: { value: 0.05 },
        uMaxLen: { value: 1 },
      },
      { defines: { STAGE_BLUR: 1 } },
    );
    this.compositePass = new FullscreenPass(
      frag,
      {
        uSize: { value: new THREE.Vector2(1, 1) },
        uFrame: { value: this.frame.texture },
        uShafts: { value: this.shafts.texture },
        uTint: { value: this.tint },
      },
      { defines: { STAGE_COMPOSITE: 1 } },
    );
  }

  get active(): boolean {
    return this.strength > 1e-3;
  }

  /**
   * Per-frame state. `depthBelow` is metres from the surface down to the eye
   * (≤ 0 means at/above the surface).
   */
  update(
    camera: THREE.PerspectiveCamera,
    sky: Sky,
    params: OceanParams,
    depthBelow: number,
    caustics: CausticsOptions,
    time: number,
  ): void {
    const s = sky.sunDirection;
    const mu = this.maskPass.uniforms;
    (mu.uCamPos!.value as THREE.Vector3).copy(camera.position);
    mu.uSurfaceY!.value = camera.position.y + depthBelow;
    mu.uCausticScale!.value = caustics.scale;
    mu.uTime!.value = time;
    // Refract the sun into the water (Snell, n = iorRatio): the shafts
    // converge on where the sun appears from below, not where it is.
    const n = Math.max(1.0, params.fresnel.iorRatio);
    const sinAir = Math.sqrt(Math.max(0, 1 - s.y * s.y));
    const sinW = sinAir / n;
    const h = Math.hypot(s.x, s.z);
    if (h > 1e-6) this.sunDirW.set((s.x / h) * sinW, Math.sqrt(1 - sinW * sinW), (s.z / h) * sinW);
    else this.sunDirW.set(0, 1, 0);

    // Screen position: view-space direction through the projection.
    const v = this.tmp.copy(this.sunDirW).transformDirection(camera.matrixWorldInverse);
    const p = camera.projectionMatrix.elements;
    const w = Math.max(-v.z, 0.05);
    this.sunUv.set(((p[0]! * v.x) / w) * 0.5 + 0.5, ((p[5]! * v.y) / w) * 0.5 + 0.5);

    const fwd = camera.getWorldDirection(this.tmp);
    const facing = smoothstep(-0.15, 0.25, fwd.dot(this.sunDirW));
    const daylight = smoothstep(-0.02, 0.18, s.y) * (params.sun.intensity / 1.5);
    const depthAtten = Math.exp(-Math.max(0, depthBelow) / DEPTH_FALLOFF_M);
    const enabled = params.underwater.sunShafts ? 1 : 0;
    this.strength = enabled * facing * daylight * depthAtten;

    sky.sunColor(this.tint).lerp(WHITE, 0.35).multiplyScalar(this.strength * this.options.exposure);
  }

  /** Render `scene` through the post stack to the canvas (`timer`: sections `water`, `post`). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, timer: GpuTimer = NULL_TIMER): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    if (this.frame.width !== w || this.frame.height !== h) this.frame.setSize(w, h);
    if (this.mask.width !== hw || this.mask.height !== hh) {
      this.mask.setSize(hw, hh);
      this.shafts.setSize(hw, hh);
    }

    timer.begin("water");
    r.setRenderTarget(this.frame);
    r.clear();
    r.render(scene, camera);
    timer.end();
    timer.begin("post");

    const o = this.options;
    const mu = this.maskPass.uniforms;
    (mu.uSize!.value as THREE.Vector2).set(hw, hh);
    (mu.uInvProj!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (mu.uInvViewRot!.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
    mu.uThreshold!.value = o.threshold;
    mu.uKnee!.value = o.knee;
    this.maskPass.render(r, this.mask);

    const bu = this.blurPass.uniforms;
    (bu.uSize!.value as THREE.Vector2).set(hw, hh);
    bu.uDensity!.value = o.density;
    bu.uDecay!.value = o.decay;
    bu.uWeight!.value = o.weight;
    bu.uMaxLen!.value = o.maxLength;
    this.blurPass.render(r, this.shafts);

    (this.compositePass.uniforms.uSize!.value as THREE.Vector2).set(w, h);
    this.compositePass.render(r, null);
    timer.end();
  }

  dispose(): void {
    this.frame.dispose();
    this.mask.dispose();
    this.shafts.dispose();
    this.maskPass.dispose();
    this.blurPass.dispose();
    this.compositePass.dispose();
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
