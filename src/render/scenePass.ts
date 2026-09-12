/**
 * Scene pre-pass (spec §1.11, §1.12). Renders every object tagged
 * `userData.castsWaterDepth` (the terrain, the ship) with its *own* material
 * — lit by the scene lights, no override — into a half-float colour target
 * with a 32-bit float depth texture, both at the drawing-buffer size. The
 * water material reads them back for two things:
 *
 *  - **depth**: how much water lies between the surface and whatever is
 *    behind it (shoreline foam, absorption by real depth, the seabed showing
 *    through the shallows), and the screen-space reflection march;
 *  - **colour**: what is reflected (the hull, the island) and what is seen
 *    through the water (the seabed, the hull below the waterline).
 *
 * The colour target is cleared to (0, 0, 0, 0): alpha 0 means "nothing
 * here" and the depth there is 1.0 (the far plane). Colour is *linear*, not
 * tone-mapped: three.js skips tone mapping and the output transfer when the
 * render target is not the canvas, and raw-shader materials that finish
 * their own colour (the terrain) are asked for linear output through a
 * `uLinearOut` uniform for the duration of the pass.
 *
 * Tagged objects are put on `SCENE_LAYER`; the pass renders with the
 * camera's layer mask narrowed to it, so nothing else (water, sky, debug
 * overlays) is touched and the scene graph is not mutated.
 */
import * as THREE from "three";

export const SCENE_LAYER = 1;

type UniformMaterial = THREE.Material & { uniforms?: Record<string, THREE.IUniform> };

export class ScenePass {
  private target: THREE.WebGLRenderTarget;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private readonly size = new THREE.Vector2();
  private readonly prevClear = new THREE.Color();
  private readonly linearOut: THREE.IUniform[] = [];

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target = ScenePass.makeTarget(1, 1);
  }

  private static makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    depthTexture.name = "SceneDepth";
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    t.texture.name = "SceneColor";
    return t;
  }

  /** Linear scene colour (alpha 1 where something was drawn, else 0). */
  get color(): THREE.Texture {
    return this.target.texture;
  }

  /** Non-linear depth-buffer value in `.r` (1.0 where nothing was drawn). */
  get depth(): THREE.Texture {
    return this.target.depthTexture as THREE.Texture;
  }

  get width(): number {
    return this.target.width;
  }

  get height(): number {
    return this.target.height;
  }

  /**
   * Render the tagged objects in `scene` from `camera`. Call before the main
   * render. Honours the renderer's drawing-buffer size (DPR and resizes) by
   * disposing and recreating the target when it changes.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.dispose();
      this.target = ScenePass.makeTarget(w, h);
    }

    // Put tagged subtrees on the scene layer (idempotent; objects may be
    // added by anyone at any time) and collect materials that finish their
    // own colour so they can be asked for linear output.
    this.linearOut.length = 0;
    scene.traverse((o) => {
      if (!o.userData.castsWaterDepth) return;
      o.traverse((c) => {
        c.layers.enable(SCENE_LAYER);
        const mat = (c as THREE.Mesh).material as UniformMaterial | UniformMaterial[] | undefined;
        for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          const u = m.uniforms?.uLinearOut;
          if (u) this.linearOut.push(u);
        }
      });
    });

    const prevTarget = r.getRenderTarget();
    const prevMask = camera.layers.mask;
    const prevAutoClear = r.autoClear;
    r.getClearColor(this.prevClear);
    const prevAlpha = r.getClearAlpha();

    for (const u of this.linearOut) u.value = 1;
    camera.layers.set(SCENE_LAYER);
    r.setRenderTarget(this.target);
    r.setClearColor(this.clearColor, 0);
    r.autoClear = true;
    r.render(scene, camera);
    for (const u of this.linearOut) u.value = 0;

    r.setClearColor(this.prevClear, prevAlpha);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    camera.layers.mask = prevMask;
  }

  dispose(): void {
    this.target.dispose();
  }
}
