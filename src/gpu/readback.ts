/**
 * Read a float render target back to the CPU. Used by the e2e tests and by
 * the buoyancy sampler. Rows come back bottom-up, which is the same order the
 * DataTextures are uploaded in and the same `(y*N + x)` indexing `core` uses.
 */
import type * as THREE from "three";

/** Full RGBA readback of one MRT attachment: `width*height*4` floats (synchronous `gl.readPixels`). */
export function readTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, attachment = 0): Float32Array {
  return readTargetBlock(renderer, target, 0, 0, target.width, target.height, attachment);
}

/** Synchronous block readback (buoyancy): `w*h*4` floats starting at (x, y). */
export function readTargetBlock(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  x: number,
  y: number,
  w: number,
  h: number,
  attachment = 0,
): Float32Array {
  const out = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(target, x, y, w, h, out, undefined, attachment);
  return out;
}

/**
 * Asynchronous block readback with one frame of latency (the buoyancy path).
 *
 * `issue(slot, …)` starts `gl.readPixels` into a pixel-pack buffer and drops
 * a fence behind it; `consume(slot)` on a later frame copies the buffer out
 * with `getBufferSubData`, which by then no longer waits. A synchronous
 * `readRenderTargetPixels` at the top of a frame stalls the CPU until the
 * GPU has drained everything queued before it — the whole previous frame —
 * so with vsync off it serialises the two; the PBO path lets them overlap.
 *
 * One PBO per slot; the Float32Array handed back is owned by the slot and
 * valid until its next `consume`. Slots are cheap: a slot is a buffer plus a
 * fence. Uses only the public `WebGLRenderer.getContext()` /
 * `setRenderTarget()` — no three.js internals.
 */
/**
 * How long `consume` will wait on a fence that the GPU has not reached yet.
 * One frame of latency means it practically always has; this is the ceiling
 * for the rare case where it has not, and is short enough that a stall shows
 * up as a dropped frame rather than a hang.
 */
const WAIT_TIMEOUT_NS = 1_000_000; // 1 ms

export class AsyncBlockReader {
  private readonly gl: WebGL2RenderingContext;
  private readonly slots = new Map<number, ReaderSlot>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
  }

  /** Start reading a `w`×`h` block of `target`'s attachment into `slot`. */
  issue(slot: number, target: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number, attachment = 0): void {
    const gl = this.gl;
    let s = this.slots.get(slot);
    if (!s) {
      s = { pbo: gl.createBuffer(), sync: null, data: new Float32Array(0), w: 0, h: 0 };
      this.slots.set(slot, s);
    }
    if (s.sync) {
      // Un-consumed read: drop it (its result is stale by definition).
      gl.deleteSync(s.sync);
      s.sync = null;
    }
    const bytes = w * h * 4 * 4;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    if (target.textures.length > 1) gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
    if (s.w !== w || s.h !== h) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      s.data = new Float32Array(w * h * 4);
      s.w = w;
      s.h = h;
    }
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    s.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.renderer.setRenderTarget(prev);
  }

  /**
   * The result of the last `issue` on `slot`: `w*h*4` floats (rows bottom-up),
   * or null when nothing was issued. Waits only if the GPU has not yet
   * reached the fence — one frame later it practically always has.
   */
  consume(slot: number): Float32Array | null {
    const s = this.slots.get(slot);
    if (!s || !s.sync) return null;
    const gl = this.gl;
    // Wait on the fence *before* touching the buffer, and delete it only
    // after the read. Reading first and deleting the sync up front makes the
    // driver discard the shadow copy it prepared at fence time: ANGLE then
    // logs "READ-usage buffer was written, then fenced, but written again
    // before being read back" once per frame and services the read as a
    // pipeline stall — the exact cost this class exists to avoid.
    gl.clientWaitSync(s.sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, s.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(s.sync);
    s.sync = null;
    return s.data;
  }

  /** True when `slot` has an issued read that has not been consumed. */
  pending(slot: number): boolean {
    return Boolean(this.slots.get(slot)?.sync);
  }

  /**
   * After a WebGL context restore: forget every slot without touching the
   * GL (the buffers and fences died with the old context); the next `issue`
   * recreates them.
   */
  reset(): void {
    this.slots.clear();
  }

  dispose(): void {
    const gl = this.gl;
    for (const s of this.slots.values()) {
      if (s.sync) gl.deleteSync(s.sync);
      gl.deleteBuffer(s.pbo);
    }
    this.slots.clear();
  }
}

interface ReaderSlot {
  pbo: WebGLBuffer;
  sync: WebGLSync | null;
  data: Float32Array;
  w: number;
  h: number;
}
