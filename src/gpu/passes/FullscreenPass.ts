/**
 * One GLSL ES 3.00 `RawShaderMaterial` drawn on a fullscreen quad into a
 * `WebGLRenderTarget` (or the canvas when `target` is null). Every GPU pass
 * of the ocean is an instance of this class with its own fragment shader;
 * the quad geometry, camera and scene are shared by all of them.
 *
 * The fragment shader must declare its own `layout(location = i) out vec4`
 * outputs — one per MRT attachment of the target it is rendered into.
 */
import * as THREE from "three";
import vert from "./fullscreen.vert.glsl?raw";

export interface FullscreenPassOptions {
  defines?: Record<string, string | number>;
}

/**
 * One quad, camera and scene for every pass: the geometry never changes, so
 * each `FullscreenPass` only owns its material and swaps it onto the shared
 * mesh for its draw. Created lazily (module load must not touch WebGL).
 */
interface SharedQuad {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
}

let shared: SharedQuad | null = null;

function sharedQuad(): SharedQuad {
  if (!shared) {
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    mesh.frustumCulled = false;
    scene.add(mesh);
    shared = { scene, camera, mesh };
  }
  return shared;
}

export class FullscreenPass {
  readonly material: THREE.RawShaderMaterial;

  constructor(frag: string, uniforms: Record<string, THREE.IUniform>, opts: FullscreenPassOptions = {}) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      defines: opts.defines ?? {},
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  /** Render the quad into `target` (null = default framebuffer). */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    const q = sharedQuad();
    q.mesh.material = this.material;
    renderer.setRenderTarget(target);
    renderer.render(q.scene, q.camera);
  }

  /** Releases the material; the shared quad lives for the page. */
  dispose(): void {
    this.material.dispose();
  }
}
