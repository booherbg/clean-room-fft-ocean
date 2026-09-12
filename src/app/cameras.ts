/**
 * Camera modes: Orbit (1, three's OrbitControls), Fly (2, WASD/QE + mouse
 * drag look) and Boat (3, the rigid-body ship on the water with a chase
 * camera). One `CameraRig` owns the camera, the key state and the ship.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Ship } from "./ship/ship";

export type CameraMode = "orbit" | "fly" | "boat";
export const MODE_INDEX: Record<CameraMode, number> = { orbit: 1, fly: 2, boat: 3 };

export interface HeightSampler {
  heightAt(x: number, z: number): number;
}

export class Keys {
  private readonly down = new Set<string>();
  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (isTyping(e)) return;
      this.down.add(e.key.toLowerCase());
    });
    target.addEventListener("keyup", (e) => this.down.delete(e.key.toLowerCase()));
    target.addEventListener("blur", () => this.down.clear());
  }
  has(k: string): boolean {
    return this.down.has(k);
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** The ship; `hull` is the historical name the app and tests use. */
  readonly hull = new Ship();
  /** Height above the water the ship is dropped from when boat mode starts. */
  static readonly DROP_HEIGHT = 2;
  mode: CameraMode = "orbit";
  private readonly orbit: OrbitControls;
  private readonly keys: Keys;
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly modeListeners: ((m: CameraMode) => void)[] = [];
  lastWaterHeight = 0;
  private readonly lookTarget = new THREE.Vector3();
  // Per-frame temporaries (fly and boat mode); the update allocates nothing.
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpFwd = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
    private readonly water: HeightSampler,
  ) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.5, 40000);
    this.camera.position.set(0, 14, 46);
    this.keys = new Keys(window);
    this.orbit = new OrbitControls(this.camera, dom);
    this.orbit.target.set(0, 2, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 4;
    this.orbit.maxDistance = 600;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.update();
    this.hull.visible = false;

    dom.addEventListener("pointerdown", (e) => {
      if (this.mode !== "fly") return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture?.(e.pointerId);
    });
    dom.addEventListener("pointermove", (e) => {
      if (!this.dragging || this.mode !== "fly") return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.003;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.003, -1.4, 1.4);
    });
    const stop = (): void => {
      this.dragging = false;
    };
    dom.addEventListener("pointerup", stop);
    dom.addEventListener("pointercancel", stop);
    dom.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("keydown", (e) => {
      if (isTyping(e)) return;
      if (e.key === "1") this.setMode("orbit");
      else if (e.key === "2") this.setMode("fly");
      else if (e.key === "3") this.setMode("boat");
    });
  }

  onModeChange(cb: (m: CameraMode) => void): void {
    this.modeListeners.push(cb);
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.orbit.enabled = m === "orbit";
    this.hull.visible = m === "boat";
    if (m === "fly") {
      // Continue from the current view direction.
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    } else if (m === "boat") {
      // Drop the ship from a little above the water so the buoyancy is visible.
      this.hull.reset(0, this.water.heightAt(0, 0) + CameraRig.DROP_HEIGHT, 0, 0);
      this.camera.position.set(30, 22, 55);
      this.lookTarget.set(0, 8, 0);
    } else {
      this.orbit.target.set(this.hull.position.x, 2, this.hull.position.z);
      const p = this.camera.position;
      if (p.y < 2) p.y = 2;
      this.orbit.update();
    }
    for (const l of this.modeListeners) l(m);
  }

  /** Point the fly camera along a world direction (yaw/pitch; roll stays 0). */
  setFlyDirection(dir: THREE.Vector3): void {
    const d = dir.clone().normalize();
    this.yaw = Math.atan2(-d.x, -d.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), -1.4, 1.4);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
  }

  update(dt: number): void {
    const k = this.keys;
    if (this.mode === "orbit") {
      this.orbit.update();
      return;
    }
    if (this.mode === "fly") {
      const speed = (k.has("shift") ? 60 : 20) * dt;
      const q = this.camera.quaternion.setFromEuler(this.tmpEuler.set(this.pitch, this.yaw, 0, "YXZ"));
      const fwd = this.tmpFwd.set(0, 0, -1).applyQuaternion(q);
      const right = this.tmpRight.set(1, 0, 0).applyQuaternion(q);
      const p = this.camera.position;
      if (k.has("w")) p.addScaledVector(fwd, speed);
      if (k.has("s")) p.addScaledVector(fwd, -speed);
      if (k.has("d")) p.addScaledVector(right, speed);
      if (k.has("a")) p.addScaledVector(right, -speed);
      if (k.has("e")) p.y += speed;
      if (k.has("q")) p.y -= speed;
      // Diving is allowed (underwater rendering); just don't fall forever.
      if (p.y < -60) p.y = -60;
      return;
    }
    // Boat.
    const h = this.hull;
    const throttle = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
    const rudder = (k.has("a") ? 1 : 0) - (k.has("d") ? 1 : 0);
    h.update(dt, throttle, rudder, this.water);
    this.lastWaterHeight = this.water.heightAt(h.position.x, h.position.z);
    // Chase camera: astern and above, easing toward the ideal spot, high
    // enough that the wake's V and foam trail stay in frame. The look-at
    // follows the (smoothed) heading only — a heaving hull should not shake
    // the camera.
    // Sits a little off the starboard quarter (the sun's side at the
    // default time of day) so the hull's lines show.
    const heading = h.heading + 0.5;
    const ideal = this.tmpFwd.set(Math.sin(heading) * 62, 22, Math.cos(heading) * 62).add(h.position);
    ideal.y = Math.max(ideal.y, this.lastWaterHeight + 10);
    this.camera.position.lerp(ideal, Math.min(1, dt * 2));
    this.lookTarget.lerp(this.tmpRight.set(h.position.x, this.lastWaterHeight + 8, h.position.z), Math.min(1, dt * 3));
    this.camera.lookAt(this.lookTarget);
  }
}
