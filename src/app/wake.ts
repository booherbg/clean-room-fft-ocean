/**
 * Boat wake: owns a `WakePass` (iWave field, spec §1.9) anchored to the hull,
 * feeds the water material, and draws the "Wake Probes" debug overlay — a
 * cyan ring at the stamp position and a translucent plane over the field
 * (blue = trough, red = crest, white = foam).
 */
import * as THREE from "three";
import { WakePass } from "../gpu/wakePass";
import { floatLinearSupported } from "../gpu/targets";
import { HullPhysics } from "./ship/hullPhysics";

const N = 512;
const SIZE = 512;
const BLOCK = 4;

export interface WakeSample {
  /** Largest |height| over a 4×4 texel block, metres. */
  height: number;
  /** Largest foam energy over the block. */
  foam: number;
}

export interface HullState {
  x: number;
  z: number;
  /** Radians, 0 = −z, matching `Hull.heading`. */
  heading: number;
  /** Signed speed along the heading, m/s. */
  speed: number;
  length: number;
  beam: number;
}

const debugVert = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
out vec2 vUv;
void main() {
  // PlaneGeometry's v runs +y → after the −90° x-rotation that is −z; the
  // field's v runs +z, so flip it.
  vUv = vec2(uv.x, 1.0 - uv.y);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const debugFrag = /* glsl */ `
precision highp float;
uniform sampler2D uWake;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 w = texture(uWake, vUv);
  float h = clamp(w.r * 8.0, -1.0, 1.0);
  vec3 c = mix(vec3(0.1, 0.25, 0.6), vec3(0.9, 0.2, 0.15), h * 0.5 + 0.5);
  c = mix(c, vec3(1.0), clamp(w.a, 0.0, 1.0));
  float a = 0.12 + 0.6 * max(abs(h), clamp(w.a, 0.0, 1.0));
  fragColor = vec4(c, a);
}`;

export class Wake {
  readonly pass: WakePass;
  /** Debug overlay; toggled by "Wake Probes". */
  readonly debug = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly plane: THREE.Mesh;
  private readonly planeMat: THREE.RawShaderMaterial;
  private originX = NaN;
  private originZ = NaN;
  private hullX = 0;
  private hullZ = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.pass = new WakePass(N, SIZE, floatLinearSupported(renderer));
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.2, 0.12, 6, 40),
      new THREE.MeshBasicMaterial({ color: 0x33e6ff, depthTest: false }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.renderOrder = 10;
    this.planeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: debugVert,
      fragmentShader: debugFrag,
      uniforms: { uWake: { value: null } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), this.planeMat);
    this.plane.rotation.x = -Math.PI / 2;
    this.plane.renderOrder = 9;
    this.debug.add(this.ring, this.plane);
    this.debug.visible = false;
    this.debug.name = "WakeProbes";
  }

  /** Metres per texel of the field. */
  get cell(): number {
    return this.pass.cell;
  }

  /** World (x, z) of the field's min corner, and its side. */
  get origin(): [number, number] {
    return [this.originX, this.originZ];
  }

  get size(): number {
    return SIZE;
  }

  get texture(): THREE.Texture {
    return this.pass.texture;
  }

  /** Forget the field (mode change, quality rebuild). */
  reset(): void {
    this.pass.reset();
    this.originX = NaN;
    this.originZ = NaN;
  }

  /** Step the field one frame. `hullY` only places the debug overlay. */
  update(dt: number, hull: HullState, hullY = 0): void {
    const cell = this.cell;
    // Anchor: the square centred on the hull, snapped to whole cells.
    const ox = Math.floor((hull.x - SIZE / 2) / cell) * cell;
    const oz = Math.floor((hull.z - SIZE / 2) / cell) * cell;
    const shift: [number, number] = Number.isNaN(this.originX)
      ? [0, 0]
      : [Math.round((ox - this.originX) / cell), Math.round((oz - this.originZ) / cell)];
    this.originX = ox;
    this.originZ = oz;
    this.hullX = hull.x;
    this.hullZ = hull.z;

    const fwd: [number, number] = [-Math.sin(hull.heading), -Math.cos(hull.heading)];
    const sf = Math.min(1, Math.abs(hull.speed) / HullPhysics.CRUISE);
    this.pass.render(this.renderer, {
      dt,
      shift,
      hull: [(hull.x - ox) / cell, (hull.z - oz) / cell],
      forward: hull.speed < 0 ? [-fwd[0], -fwd[1]] : fwd,
      halfSize: [(hull.length * 0.5) / cell, (hull.beam * 0.5) / cell],
      speedFactor: sf,
    });

    if (this.debug.visible) {
      this.ring.position.set(hull.x, hullY + 0.4, hull.z);
      this.plane.position.set(ox + SIZE / 2, hullY + 0.6, oz + SIZE / 2);
      (this.planeMat.uniforms.uWake as THREE.IUniform).value = this.pass.texture;
    }
  }

  /**
   * Read a 4×4 texel block of the field at world offset (dx, dz) from the
   * hull (synchronous readback). Zero outside the field.
   */
  sample(dx: number, dz: number): WakeSample {
    if (Number.isNaN(this.originX)) return { height: 0, foam: 0 };
    const cell = this.cell;
    const tx = Math.floor((this.hullX + dx - this.originX) / cell) - 1;
    const tz = Math.floor((this.hullZ + dz - this.originZ) / cell) - 1;
    if (tx < 0 || tz < 0 || tx + BLOCK > N || tz + BLOCK > N) return { height: 0, foam: 0 };
    const data = this.pass.readBlock(this.renderer, tx, tz, BLOCK, BLOCK);
    let height = 0;
    let foam = 0;
    for (let i = 0; i < data.length; i += 4) {
      const h = data[i] as number;
      if (Math.abs(h) > Math.abs(height)) height = h;
      foam = Math.max(foam, data[i + 3] as number);
    }
    return { height, foam };
  }

  dispose(): void {
    this.pass.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.plane.geometry.dispose();
    this.planeMat.dispose();
  }
}
