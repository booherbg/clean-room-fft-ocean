/**
 * Bottom-left HUD line: `GPU WebGL2 · FPS · Frame ms · Draws · Tris · DPR`,
 * refreshed every 250 ms, plus a second line of GPU section timings when
 * `EXT_disjoint_timer_query_webgl2` is available (`GPU n/a` otherwise).
 * Also feeds the big FPS number on the mode card.
 */
export interface HudGpuStats {
  /** False when the timer-query extension is missing or the timer is switched off; `sections` is then empty. */
  supported: boolean;
  /** Smoothed milliseconds per section (`spectrum`, `fft`, `unpack`, `prepass`, `water`, `spray`, `post`, ...). */
  sections: Record<string, number>;
  /** Sum of the sections. */
  total: number;
  /** Elapsed time of an empty section (ms) — the backend's per-query overhead, to subtract. */
  floor: number;
}

export interface HudStats {
  fps: number;
  frameMs: number;
  draws: number;
  tris: number;
  dpr: number;
  gpu: HudGpuStats;
}

/** Display order of the GPU sections; anything else is appended. */
const SECTION_ORDER = ["spectrum", "fft", "unpack", "prepass", "water", "spray", "rain", "wake", "post"];

export class Hud {
  readonly el: HTMLElement;
  private readonly fields: Record<string, HTMLElement> = {};
  private readonly gpuLine: HTMLElement;
  private readonly bigFps: HTMLElement | null;
  private frames = 0;
  private accumMs = 0;
  private lastFlush = performance.now();
  private lastStats: HudStats = { fps: 0, frameMs: 0, draws: 0, tris: 0, dpr: 1, gpu: { supported: false, sections: {}, total: 0, floor: 0 } };
  private draws = 0;
  private tris = 0;
  private gpu: Readonly<Record<string, number>> | null = null;
  private gpuFloor = 0;

  constructor(parent: HTMLElement, bigFps: HTMLElement | null, gpuLabel: string, gpuTimerSupported = false) {
    this.bigFps = bigFps;
    this.el = document.createElement("div");
    this.el.className = "hud";
    this.el.dataset.testid = "hud";
    const line = document.createElement("div");
    line.className = "hud-line";
    const parts: [string, string][] = [
      ["gpu", gpuLabel],
      ["fps", "FPS —"],
      ["frame", "Frame — ms"],
      ["draws", "Draws —"],
      ["tris", "Tris —"],
      ["dpr", "DPR —"],
    ];
    parts.forEach(([key, text], i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "hud-sep";
        sep.textContent = "·";
        line.appendChild(sep);
      }
      const span = document.createElement("span");
      span.dataset.testid = `hud-${key}`;
      span.textContent = text;
      line.appendChild(span);
      this.fields[key] = span;
    });
    this.el.appendChild(line);
    this.gpuLine = document.createElement("div");
    this.gpuLine.className = "hud-line hud-gpu";
    this.gpuLine.dataset.testid = "hud-gpu-sections";
    this.gpuTimerSupported = gpuTimerSupported;
    this.el.appendChild(this.gpuLine);
    this.lastStats.gpu.supported = gpuTimerSupported;
    parent.appendChild(this.el);
    this.render();
  }

  private readonly gpuTimerSupported: boolean;

  /** Record one rendered frame. `gpu`: smoothed section ms (null when unsupported); `gpuFloor`: empty-section ms. */
  frame(
    frameMs: number,
    draws: number,
    tris: number,
    dpr: number,
    gpu: Readonly<Record<string, number>> | null = null,
    gpuFloor = 0,
  ): void {
    this.frames++;
    this.accumMs += frameMs;
    this.draws = draws;
    this.tris = tris;
    this.gpu = gpu;
    this.gpuFloor = gpuFloor;
    const now = performance.now();
    const elapsed = now - this.lastFlush;
    if (elapsed >= 250) {
      const fps = (this.frames * 1000) / elapsed;
      this.lastStats = { fps, frameMs: this.accumMs / this.frames, draws, tris, dpr, gpu: this.gpuStats() };
      this.frames = 0;
      this.accumMs = 0;
      this.lastFlush = now;
      this.render();
    }
  }

  /** Replace the GPU label (e.g. "GPU context lost"). */
  setGpuLabel(text: string): void {
    this.fields.gpu!.textContent = text;
  }

  stats(): HudStats {
    return { ...this.lastStats, draws: this.draws, tris: this.tris, gpu: this.gpuStats() };
  }

  private gpuStats(): HudGpuStats {
    if (!this.gpu) return { supported: false, sections: {}, total: 0, floor: 0 };
    const sections = { ...this.gpu };
    let total = 0;
    for (const k of Object.keys(sections)) total += sections[k]!;
    return { supported: true, sections, total, floor: this.gpuFloor };
  }

  private render(): void {
    const s = this.lastStats;
    this.fields.fps!.textContent = `FPS ${s.fps.toFixed(0)}`;
    this.fields.frame!.textContent = `Frame ${s.frameMs.toFixed(1)} ms`;
    this.fields.draws!.textContent = `Draws ${s.draws}`;
    this.fields.tris!.textContent = `Tris ${formatK(s.tris)}`;
    this.fields.dpr!.textContent = `DPR ${s.dpr.toFixed(2)}`;
    if (!this.gpuTimerSupported) {
      this.gpuLine.textContent = "GPU ms n/a (no EXT_disjoint_timer_query_webgl2)";
    } else if (!this.gpu) {
      this.gpuLine.textContent = "GPU ms off";
    } else if (Object.keys(s.gpu.sections).length === 0) {
      this.gpuLine.textContent = "GPU ms —";
    } else {
      const keys = orderedSections(s.gpu.sections);
      const parts = keys.map((k) => `${k} ${s.gpu.sections[k]!.toFixed(2)}`);
      const floor = s.gpu.floor > 0.05 ? ` · floor ${s.gpu.floor.toFixed(2)}` : "";
      this.gpuLine.textContent = `GPU ms ${s.gpu.total.toFixed(2)} · ${parts.join(" · ")}${floor}`;
    }
    if (this.bigFps) this.bigFps.textContent = s.fps.toFixed(0);
  }
}

function orderedSections(sections: Record<string, number>): string[] {
  const present = Object.keys(sections);
  const ordered = SECTION_ORDER.filter((k) => present.includes(k));
  for (const k of present) if (!ordered.includes(k)) ordered.push(k);
  return ordered;
}

function formatK(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}
