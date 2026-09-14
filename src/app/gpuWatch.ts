/**
 * Where was the frame when the GPU went away?
 *
 * A browser reports a lost WebGL context asynchronously: the event lands
 * after the tick that lost it has run to the end, every GL call in between
 * a silent no-op, so a plain "current stage" breadcrumb always names the
 * last stage of the tick. During the first frames after a mode switch —
 * where every first-use shader compile and texture upload happens — each
 * stage boundary therefore drains the queue (`finish`) and reads one texel
 * of a sentinel target back: a dead GPU process returns nothing, and the
 * breadcrumb stops at the stage that killed it. `?diag=1` probes every
 * frame.
 *
 * The report (stage, frame, GPU string, tier, buffer size, user agent) goes
 * on the overlay and into `localStorage`, so a device that cannot get a
 * context after the crash still shows what the previous visit was doing.
 */
import * as THREE from "three";

export const LOSS_KEY = "fft-ocean.lastContextLoss";

export interface LossReport {
  /** Stage in progress when the GPU was found gone. */
  stage: string;
  /** Frames since the last mode switch. */
  frame: number;
  mode: string;
  gpu: string;
  tier: string;
  /** Drawing buffer, e.g. "1280×800 @2". */
  buffer: string;
  ua: string;
  /** ISO time of the loss. */
  at: string;
}

/** Frames probed after every mode switch (the first-use compiles happen there). */
const PROBE_FRAMES = 8;

export class GpuWatch {
  stage = "boot";
  /** Frames since the last mode switch. */
  frame = 0;
  mode = "orbit";
  /** The stage a probe first found the GPU gone in, or null while it is alive. */
  lostAt: string | null = null;
  private lostFrame = 0;
  /** Unmasked renderer string, captured while the context is alive. */
  readonly gpu: string;
  private readonly gl: WebGL2RenderingContext;
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private readonly px = new Uint8Array(4);
  private readonly tmpColor = new THREE.Color();
  private buffer = "";
  private dpr = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly probeFrames = PROBE_FRAMES,
  ) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.gpu = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "unknown GPU");
    this.fill();
  }

  /** Paint the sentinel (at construction and after a context restore). */
  fill(): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(this.tmpColor).getHex();
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.target);
    r.setClearColor(0xffffff, 1);
    r.clear(true, false, false);
    r.setClearColor(prevColor, prevAlpha);
    r.setRenderTarget(prevTarget);
    this.lostAt = null;
  }

  modeChanged(mode: string): void {
    this.mode = mode;
    this.frame = 0;
  }

  /**
   * Name the stage about to run. While probing, the GPU is checked first
   * and a dead one is charged to the stage that has just run.
   */
  mark(stage: string): void {
    if (this.lostAt === null && this.frame < this.probeFrames) this.probe();
    this.stage = stage;
  }

  /** Close the frame (probes the last stage while probing). */
  endFrame(dpr: number): void {
    if (this.lostAt === null && this.frame < this.probeFrames) this.probe();
    const gl = this.gl;
    if (gl.drawingBufferWidth > 0) this.buffer = `${gl.drawingBufferWidth}×${gl.drawingBufferHeight} @${dpr}`;
    this.dpr = dpr;
    this.frame++;
  }

  report(tier: string): LossReport {
    // The event lands after the tick that lost the context has closed its
    // frame; without a probe's record the loss was somewhere in that tick.
    return {
      stage: this.lostAt ?? this.stage,
      frame: this.lostAt !== null ? this.lostFrame : Math.max(0, this.frame - 1),
      mode: this.mode,
      gpu: this.gpu,
      tier,
      buffer: this.buffer || `? @${this.dpr}`,
      ua: navigator.userAgent,
      at: new Date().toISOString(),
    };
  }

  private probe(): void {
    const gl = this.gl;
    const r = this.renderer;
    gl.finish();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    this.px.fill(0);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
    r.setRenderTarget(prev);
    if (this.px[0] !== 255) {
      this.lostAt = this.stage;
      this.lostFrame = this.frame;
    }
  }
}

export function saveLoss(report: LossReport): void {
  try {
    localStorage.setItem(LOSS_KEY, JSON.stringify(report));
  } catch {
    // Storage unavailable (private mode, quota): the overlay still shows it.
  }
}

export function loadLoss(): LossReport | null {
  try {
    const s = localStorage.getItem(LOSS_KEY);
    return s ? (JSON.parse(s) as LossReport) : null;
  } catch {
    return null;
  }
}

/** The overlay text for a loss that has just happened. */
export function formatLoss(r: LossReport): string {
  return [
    "GPU CONTEXT LOST",
    `while: ${r.stage} (frame ${r.frame} of ${r.mode} mode)`,
    `${r.gpu} · ${r.tier} · ${r.buffer}`,
    r.ua,
    "After a GPU crash the browser usually blocks WebGL for this site until it is closed completely and reopened.",
  ].join("\n");
}

/** One paragraph about a previous visit's loss, for the no-context gate. */
export function formatPreviousLoss(r: LossReport): string {
  const when = new Date(r.at);
  const time = Number.isNaN(when.getTime()) ? r.at : when.toLocaleString();
  return `The previous visit (${time}) lost the GPU while: ${r.stage} (frame ${r.frame} of ${r.mode} mode) on ${r.gpu}, ${r.tier} tier, ${r.buffer}. Browsers block WebGL for a site for a while after a GPU crash; closing the browser completely and reopening it clears that.`;
}
