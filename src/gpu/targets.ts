/**
 * Float texture helpers shared by all passes.
 *
 * Every ocean texture is RGBA 32-bit float, no mipmaps; simulation-internal
 * targets are nearest-filtered, the renderer-facing ones may be bilinear.
 * Texel (x, y) of a DataTexture (row 0 first in the buffer) lands on the same
 * texel as `ivec2(gl_FragCoord.xy)` = (x, y) of a render target, and
 * `readRenderTargetPixels` returns rows in the same bottom-up order — so a
 * CPU array indexed `(y*N + x)` round-trips with no flip anywhere.
 */
import * as THREE from "three";

export interface FloatTargetOptions {
  /**
   * Bilinear sampling. Only the textures the *renderer* samples with world
   * UVs (unpack outputs, foam) want this; every simulation pass uses
   * `texelFetch` and is unaffected. Filtering 32-bit float textures needs
   * `OES_texture_float_linear` — check with `floatLinearSupported()` first.
   */
  linear?: boolean;
  /**
   * Also build a mip chain after every render (trilinear minification).
   * Implies `linear`. The water material samples the derivative texture at
   * grazing angles where one pixel spans many texels; without mips the
   * ripples alias into sparkle. three regenerates the chain at the end of
   * each `render()` into the target — a 256² float chain is negligible.
   */
  mipmaps?: boolean;
  /** Rows (defaults to `N`: square). */
  height?: number;
}

/**
 * RGBA FloatType render target with `count` MRT colour attachments:
 * `N`×`N`, or `N`×`opts.height` when given.
 */
export function makeFloatTarget(N: number, count = 1, opts: FloatTargetOptions = {}): THREE.WebGLRenderTarget {
  const linear = opts.linear || opts.mipmaps;
  const mipmaps = Boolean(opts.mipmaps);
  const target = new THREE.WebGLRenderTarget(N, opts.height ?? N, {
    count,
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: mipmaps,
  });
  return target;
}

const linearLogged = new WeakSet<THREE.WebGLRenderer>();

/**
 * Whether this context can bilinearly filter 32-bit float textures
 * (`OES_texture_float_linear`). Logged once per renderer so the console says
 * which path the displacement/foam textures took.
 */
export function floatLinearSupported(renderer: THREE.WebGLRenderer): boolean {
  const ok = renderer.extensions.has("OES_texture_float_linear");
  if (!linearLogged.has(renderer)) {
    linearLogged.add(renderer);
    console.info(
      ok
        ? "[ocean] OES_texture_float_linear: displacement/foam textures use LinearFilter"
        : "[ocean] OES_texture_float_linear missing: displacement/foam textures fall back to NearestFilter",
    );
  }
  return ok;
}

/** RGBA FloatType DataTexture of `width × height` texels from a CPU array. */
export function makeFloatDataTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  if (data.length !== width * height * 4) {
    throw new Error(`makeFloatDataTexture: expected ${width * height * 4} floats, got ${data.length}`);
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}
