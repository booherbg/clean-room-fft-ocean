/**
 * `Ocean`: simulation provider + clipmap mesh + water material + sky, as one
 * `Object3D`. Add it to a scene, call `update(camera, t, dt)` every frame.
 *
 * The simulation is any `CascadeProvider`: by default the gpu layer's
 * `OceanSim`; the render e2e page injects a CPU stub instead.
 */
import * as THREE from "three";
import { cloneParams, tierConfig, type OceanParams } from "../core/params";
import { NULL_TIMER, type GpuTimer } from "../gpu/gpuTimer";
import { OceanSim } from "../gpu/oceanSim";
import type { CascadeProvider } from "./cascadeTextures";
import { clipmapGeometry, snapCamera } from "./clipmap";
import { ScenePass } from "./scenePass";
import { Sky } from "./sky";
import { WaterMaterial } from "./waterMaterial";

export interface OceanOptions {
  /** Rings around the centre grid (default 10 → ±32 km at 64 segments / 1 m). */
  rings?: number;
  /** Centre-grid cell in metres (default 1). */
  baseCell?: number;
  /** Simulation to render; defaults to a new `OceanSim` on the renderer. */
  sim?: CascadeProvider;
  /** GPU section timer (`gpu/gpuTimer`); the sim and the pre-pass report into it. */
  timer?: GpuTimer;
}

export class Ocean extends THREE.Object3D {
  readonly sim: CascadeProvider;
  readonly sky: Sky;
  /** Scene colour + depth pre-pass the water reads for shallows and reflections (spec §1.11, §1.12). */
  readonly scenePass: ScenePass;
  /** Replaced (not mutated) on a quality change; re-read after `setParams`. */
  material!: WaterMaterial;
  /** Replaced (not mutated) on a quality change; re-read after `setParams`. */
  mesh!: THREE.Mesh;
  private params: OceanParams;
  private readonly baseCell: number;
  private readonly rings: number;
  private readonly renderer: THREE.WebGLRenderer;
  private terrain: { tex: THREE.Texture; x: number; z: number; extent: number } | null = null;
  private readonly timer: GpuTimer;
  /** `Sky.version` the material's sky uniforms were last bound from. */
  private skyVersion = -1;

  constructor(renderer: THREE.WebGLRenderer, params: OceanParams, opts: OceanOptions = {}) {
    super();
    this.name = "Ocean";
    this.renderer = renderer;
    this.params = cloneParams(params);
    this.timer = opts.timer ?? NULL_TIMER;
    this.sim = opts.sim ?? new OceanSim(renderer, this.params);
    if (this.sim instanceof OceanSim) this.sim.timer = this.timer;
    this.baseCell = opts.baseCell ?? 1;
    this.rings = opts.rings ?? 10;

    this.sky = new Sky(renderer);
    this.add(this.sky.skybox);
    this.scenePass = new ScenePass(renderer);
    this.buildSurface();
  }

  setParams(p: OceanParams): void {
    const prevQuality = this.params.quality;
    this.params = cloneParams(p);
    this.sim.setParams(this.params);
    // A tier change alters the cascade count (a shader define) and the
    // clipmap density: the material and geometry must be rebuilt, not patched.
    if (p.quality !== prevQuality) this.buildSurface();
    else this.material.setParams(this.params);
  }

  /**
   * After a WebGL context restore: three re-uploads textures, programs and
   * geometry on its own, but render-target *contents* (h0 spectra, foam,
   * the sky cubemap) and the readback PBOs are gone. Rebuild the sim and
   * the surface the way a tier change does, and re-render the sky.
   */
  contextRestored(): void {
    this.sim.contextRestored?.();
    this.sky.invalidate();
    this.buildSurface(true);
  }

  /**
   * (Re)create the water mesh + material for the current tier and cascades.
   * With `afterLoss` the old ones are dropped rather than disposed: their GL
   * objects died with the context, and three would only report each delete
   * of a dead object as an error.
   */
  private buildSurface(afterLoss = false): void {
    if ((this.mesh as THREE.Mesh | undefined) !== undefined) {
      this.remove(this.mesh);
      if (!afterLoss) {
        this.mesh.geometry.dispose();
        this.material.dispose();
      }
    }
    const tier = tierConfig(this.params.quality);
    this.material = new WaterMaterial(this.sim.cascades.length);
    this.material.setParams(this.params);
    this.material.setSky(this.sky.cubemap, this.sky.sunDirection, this.sky.moonDirection, this.sky.moonIntensity);
    this.skyVersion = this.sky.version;
    this.material.setCascades(this.sim.cascades);
    this.material.setScene(this.scenePass.color, this.scenePass.depth);
    if (this.terrain) this.material.setTerrain(this.terrain.tex, this.terrain.x, this.terrain.z, this.terrain.extent);
    this.mesh = new THREE.Mesh(clipmapGeometry(tier.meshSegments, this.rings, this.baseCell), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = "OceanSurface";
    this.add(this.mesh);
  }

  update(camera: THREE.Camera, t: number, dt: number): void {
    // The sim's passes leave the renderer pointed at their targets.
    const prevTarget = this.renderer.getRenderTarget();
    this.sim.update(t, dt);
    this.renderer.setRenderTarget(prevTarget);
    this.sky.update(this.params.sky.timeOfDay, this.params.sky.cloudCoverage, this.params.fog);
    if (this.sky.version !== this.skyVersion) {
      this.skyVersion = this.sky.version;
      this.material.setSky(this.sky.cubemap, this.sky.sunDirection, this.sky.moonDirection, this.sky.moonIntensity);
    }
    // Every frame: the foam textures ping-pong, so the bound texture changes.
    this.material.setCascades(this.sim.cascades);
    this.material.setTime(t);
    const [x, z] = snapCamera(camera.position.x, camera.position.z, this.baseCell * 2);
    this.material.setOrigin(x, z, this.baseCell);
  }

  /** Terrain heightmap for wave shoaling (kept across tier rebuilds); see `WaterMaterial.setTerrain`. */
  setTerrain(tex: THREE.Texture | null, x = 0, z = 0, extent = 0): void {
    this.terrain = tex ? { tex, x, z, extent } : null;
    this.material.setTerrain(tex, x, z, extent);
  }

  /**
   * Render the scene pre-pass (objects tagged `userData.castsWaterDepth`:
   * colour + depth) for this frame. Call after `update` and before the main
   * render; if it is never called the water behaves as over an infinitely
   * deep sea with nothing to reflect but the sky.
   */
  renderSceneDepth(scene: THREE.Scene, camera: THREE.Camera): void {
    this.timer.begin("prepass");
    this.scenePass.render(scene, camera);
    this.timer.end();
    this.material.setScene(this.scenePass.color, this.scenePass.depth);
  }

  /** Draw calls and triangles the ocean's visible meshes (surface, skybox) submit. */
  stats(): { draws: number; tris: number } {
    let draws = 0;
    let tris = 0;
    this.traverseVisible((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry as THREE.BufferGeometry;
      draws++;
      tris += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    });
    return { draws, tris };
  }

  override dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.sky.dispose();
    this.scenePass.dispose();
    this.sim.dispose();
  }
}
