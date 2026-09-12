/**
 * Per-section GPU timings via `EXT_disjoint_timer_query_webgl2`.
 *
 * `begin(name)` / `end()` bracket GPU work on the main path; a section may be
 * opened several times in one frame (once per cascade, say) and its results
 * are summed. Queries resolve some frames later: `poll()` (called once per
 * frame, at the top) reads back whichever whole frames have completed and
 * never blocks — `QUERY_RESULT_AVAILABLE` is checked before `QUERY_RESULT`.
 * When the extension is missing (Safari, some mobile GPUs, a blocklisted
 * driver) every method is a no-op, `supported` is false and `results()` is
 * `null`; the HUD then shows `n/a`.
 *
 * Sections must not nest: only one `TIME_ELAPSED_EXT` query can be active.
 *
 * Backend caveat: ANGLE over Metal implements a query by splitting the
 * command buffer, and the elapsed time it reports includes that buffer's
 * scheduling, so every section carries a fixed floor (~0.5 ms on an M-series
 * Mac) and sections in flight together overlap — their sum can exceed the
 * frame. `floor()` measures that floor with empty sections during the first
 * frames so a reader can subtract it; on native GL / D3D it reads ~0.
 */
import type * as THREE from "three";

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface PendingQuery {
  name: string;
  query: WebGLQuery;
}

interface PendingFrame {
  queries: PendingQuery[];
}

export interface GpuTimings {
  /** Milliseconds of GPU time per section, for the most recent resolved frame. */
  sections: Record<string, number>;
  /** Sum of the sections. */
  total: number;
}

/** How many frames of unresolved queries to keep before dropping the oldest. */
const MAX_PENDING_FRAMES = 8;
/** Frames on which an empty `floor` section is issued to measure per-query overhead. */
const FLOOR_FRAMES = 32;
/** Section name of the empty calibration query. */
export const FLOOR_SECTION = "_floor";

export class GpuTimer {
  readonly supported: boolean;
  /**
   * Issue queries at all. Off, `begin`/`end` are no-ops (pending queries
   * still drain) and `smoothed()` returns null. Each query splits the
   * command buffer on ANGLE Metal, which costs a few percent at High and
   * above — the perf script measures with it off unless `--gpu-timer`.
   */
  enabled = true;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly pool: WebGLQuery[] = [];
  private readonly pending: PendingFrame[] = [];
  private current: PendingFrame | null = null;
  private active: WebGLQuery | null = null;
  private last: GpuTimings | null = null;
  /** Smoothed copy of `last` (EMA over resolved frames) for display. */
  private smooth: Record<string, number> = {};
  private frameNo = 0;
  private floorMs = 0;
  private floorSamples = 0;

  constructor(renderer: THREE.WebGLRenderer | null) {
    const gl = renderer ? (renderer.getContext() as WebGL2RenderingContext) : null;
    const ext = gl ? (gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null) : null;
    this.gl = gl;
    this.ext = ext;
    this.supported = ext !== null;
  }

  /** Start a new frame: resolve finished queries, open a fresh frame record. */
  poll(): void {
    if (!this.supported) return;
    const gl = this.gl!;
    const ext = this.ext!;
    if (this.current && this.current.queries.length > 0) this.pending.push(this.current);
    this.current = { queries: [] };
    this.frameNo++;
    // Resolve in order; a frame is done when its last query is available.
    while (this.pending.length > 0) {
      const frame = this.pending[0]!;
      const lastQ = frame.queries[frame.queries.length - 1]!.query;
      if (!gl.getQueryParameter(lastQ, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      const sections: Record<string, number> = {};
      let total = 0;
      for (const q of frame.queries) {
        if (!disjoint) {
          const ns = gl.getQueryParameter(q.query, gl.QUERY_RESULT) as number;
          const ms = ns / 1e6;
          if (q.name === FLOOR_SECTION) {
            this.floorSamples++;
            this.floorMs += (ms - this.floorMs) / this.floorSamples;
          } else {
            sections[q.name] = (sections[q.name] ?? 0) + ms;
            total += ms;
          }
        }
        this.pool.push(q.query);
      }
      if (disjoint) continue;
      this.last = { sections, total };
      for (const k of Object.keys(sections)) {
        const prev = this.smooth[k];
        this.smooth[k] = prev === undefined ? sections[k]! : prev + (sections[k]! - prev) * 0.1;
      }
    }
    // Calibrate the per-query floor with an empty section on the first frames.
    if (this.enabled && this.frameNo <= FLOOR_FRAMES) {
      this.begin(FLOOR_SECTION);
      this.end();
    }
    // Never let an unresolvable backlog grow (context lost, tab hidden).
    while (this.pending.length > MAX_PENDING_FRAMES) {
      const dropped = this.pending.shift()!;
      for (const q of dropped.queries) gl.deleteQuery(q.query);
    }
  }

  begin(name: string): void {
    if (!this.supported || !this.enabled || this.active) return;
    const gl = this.gl!;
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q);
    this.active = q;
    if (!this.current) this.current = { queries: [] };
    this.current.queries.push({ name, query: q });
  }

  end(): void {
    if (!this.supported || !this.active) return;
    this.gl!.endQuery(this.ext!.TIME_ELAPSED_EXT);
    this.active = null;
  }

  /** Bracket `fn` in a section (a convenience for single calls). */
  section<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Most recent resolved frame, or `null` when unsupported / nothing resolved yet. */
  results(): GpuTimings | null {
    return this.last;
  }

  /** Mean elapsed time of an empty section (ms): the backend's per-query overhead. */
  floor(): number {
    return this.floorMs;
  }

  /** Exponentially smoothed section times (ms), or `null` when unsupported. Live object — do not mutate. */
  smoothed(): Readonly<Record<string, number>> | null {
    return this.supported && this.enabled ? this.smooth : null;
  }

  /**
   * After a WebGL context restore: drop every query (they died with the old
   * context) without GL calls; the pool refills on demand.
   */
  reset(): void {
    this.pool.length = 0;
    this.pending.length = 0;
    this.current = null;
    this.active = null;
  }

  dispose(): void {
    if (!this.supported) return;
    const gl = this.gl!;
    if (this.active) gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
    for (const q of this.pool) gl.deleteQuery(q);
    for (const f of this.pending) for (const q of f.queries) gl.deleteQuery(q.query);
    if (this.current) for (const q of this.current.queries) gl.deleteQuery(q.query);
    this.pool.length = 0;
    this.pending.length = 0;
    this.current = null;
    this.active = null;
  }
}

/** A timer that does nothing — the default when no renderer wants timings. */
export const NULL_TIMER = new GpuTimer(null);
