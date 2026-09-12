/**
 * Right-hand control panel (spec §5). Hand-rolled HTML; every control carries
 * a `data-testid`. Emits `GuiEvent`s through `onChange`.
 */
import { tierConfig, type OceanParams, type QualityTier } from "../core/params";
import { PRESETS } from "./presets";

export type GuiEvent =
  | { kind: "quality"; tier: QualityTier }
  | { kind: "preset"; name: string }
  | { kind: "param"; path: string; value: number | boolean }
  | { kind: "pixelRatio"; value: number }
  | { kind: "toggle"; id: "buoyancyProbes" | "wakeProbes"; value: boolean }
  | { kind: "sunShafts"; value: boolean };

export const QUALITY_TIERS: { value: QualityTier; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "ultra", label: "Ultra" },
  { value: "max", label: "Max" },
];

interface SliderDef {
  id: string;
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const SLIDERS: SliderDef[] = [
  { id: "windSpeed", path: "waves.windSpeed", label: "Wind Speed", min: 0.1, max: 25, step: 0.1, format: (v) => `${v.toFixed(1)} m/s` },
  { id: "peakWavelength", path: "waves.peakWavelength", label: "Peak Wavelength", min: 1, max: 200, step: 1, format: (v) => `${Math.round(v)} m` },
  { id: "timeOfDay", path: "sky.timeOfDay", label: "Time of Day", min: 0, max: 24, step: 0.25, format: formatTime },
  { id: "cloudCoverage", path: "sky.cloudCoverage", label: "Cloud Coverage", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { id: "sprayDensity", path: "spray.density", label: "Spray Density", min: 0, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  // The checkbox owns `data-testid="rain"`; the slider is `rainAmount`.
  { id: "rainAmount", path: "weather.rain", label: "Rain", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
];

export function formatTime(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export class Gui {
  readonly el: HTMLElement;
  private readonly listeners: ((e: GuiEvent) => void)[] = [];
  private readonly sliders = new Map<string, { input: HTMLInputElement; value: HTMLElement; def: SliderDef }>();
  private readonly quality: HTMLSelectElement;
  private readonly preset: HTMLSelectElement;
  private readonly pixelRatio: HTMLInputElement;
  private readonly pixelRatioValue: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly ssr: HTMLInputElement;
  private readonly sunShafts: HTMLInputElement;
  private readonly spray: HTMLInputElement;
  private readonly rain: HTMLInputElement;

  constructor(parent: HTMLElement, initial: OceanParams, initialPreset: string, dpr: number) {
    this.el = document.createElement("aside");
    this.el.className = "panel";
    this.el.dataset.testid = "panel";
    this.el.innerHTML = `
      <header class="panel-head">
        <div class="wordmark">FFT <em>OCEAN</em> <span class="dash">—</span> DEMO</div>
        <div class="tagline">Clean-room FFT / JONSWAP ocean · three.js WebGL2</div>
      </header>
      <div class="panel-body">
        <div class="pill" data-testid="rebuilding" hidden>Rebuilding Shaders…</div>
        <label class="field">
          <span class="label">Quality</span>
          <span class="select-wrap"><select data-testid="quality"></select></span>
        </label>
        <label class="field">
          <span class="label">Preset</span>
          <span class="select-wrap"><select data-testid="preset"></select></span>
        </label>
        <div class="sliders"></div>
        <hr class="rule" />
        <label class="toggle-row">
          <span class="label">Buoyancy Probes</span>
          <input type="checkbox" class="toggle" data-testid="buoyancyProbes" />
        </label>
        <label class="toggle-row">
          <span class="label">Wake Probes</span>
          <input type="checkbox" class="toggle" data-testid="wakeProbes" />
        </label>
        <label class="toggle-row" title="Screen-space reflection of the ship and island in the water (off on Low)">
          <span class="label">Reflections (SSR)</span>
          <input type="checkbox" class="toggle" data-testid="ssr" />
        </label>
        <label class="toggle-row" title="Underwater light shafts (radial blur toward the sun)">
          <span class="label">Sun Shafts</span>
          <input type="checkbox" class="toggle" data-testid="sunShafts" />
        </label>
        <label class="toggle-row" title="Spray particles on breaking crests and at the bow (off on Low)">
          <span class="label">Spray</span>
          <input type="checkbox" class="toggle" data-testid="spray" />
        </label>
        <label class="toggle-row" title="Falling rain and the ripples it leaves on the water (off on Low)">
          <span class="label">Rain</span>
          <input type="checkbox" class="toggle" data-testid="rain" />
        </label>
        <label class="toggle-row is-disabled" title="WebGL2 is the only backend">
          <span class="label">Force WebGL</span>
          <input type="checkbox" class="toggle" data-testid="forceWebgl" checked disabled />
        </label>
        <div class="field slider-field" data-slider="pixelRatio">
          <div class="row"><span class="label">Pixel Ratio</span><span class="value" data-testid="pixelRatio-value"></span></div>
          <input type="range" data-testid="pixelRatio" min="0.5" max="2" step="0.05" />
        </div>
      </div>
      <footer class="panel-foot">
        <a class="btn btn-primary" data-testid="link-source" href="https://github.com/booherbg/clean-room-fft-ocean" target="_blank" rel="noopener">Source</a>
        <a class="btn" data-testid="link-docs" href="https://github.com/booherbg/clean-room-fft-ocean/blob/main/docs/design.md" target="_blank" rel="noopener">Docs</a>
      </footer>`;
    parent.appendChild(this.el);

    this.pill = this.el.querySelector(".pill") as HTMLElement;
    this.quality = this.el.querySelector('[data-testid="quality"]') as HTMLSelectElement;
    for (const t of QUALITY_TIERS) {
      const o = document.createElement("option");
      o.value = t.value;
      o.textContent = t.label;
      this.quality.appendChild(o);
    }
    this.quality.value = initial.quality;
    this.quality.addEventListener("change", () => this.emit({ kind: "quality", tier: this.quality.value as QualityTier }));

    this.preset = this.el.querySelector('[data-testid="preset"]') as HTMLSelectElement;
    for (const [name, p] of Object.entries(PRESETS)) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = p.label;
      this.preset.appendChild(o);
    }
    this.preset.value = initialPreset;
    this.preset.addEventListener("change", () => this.emit({ kind: "preset", name: this.preset.value }));

    const slidersEl = this.el.querySelector(".sliders") as HTMLElement;
    for (const def of SLIDERS) {
      const field = document.createElement("div");
      field.className = "field slider-field";
      field.innerHTML = `
        <div class="row"><span class="label">${def.label}</span><span class="value" data-testid="${def.id}-value"></span></div>
        <input type="range" data-testid="${def.id}" min="${def.min}" max="${def.max}" step="${def.step}" />`;
      slidersEl.appendChild(field);
      const input = field.querySelector("input") as HTMLInputElement;
      const value = field.querySelector(".value") as HTMLElement;
      this.sliders.set(def.id, { input, value, def });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        this.paintSlider(input, value, def, v);
        this.emit({ kind: "param", path: def.path, value: v });
      });
    }

    this.pixelRatio = this.el.querySelector('[data-testid="pixelRatio"]') as HTMLInputElement;
    this.pixelRatioValue = this.el.querySelector('[data-testid="pixelRatio-value"]') as HTMLElement;
    this.pixelRatio.value = String(dpr);
    this.paintRange(this.pixelRatio);
    this.pixelRatioValue.textContent = `${dpr.toFixed(2)}×`;
    this.pixelRatio.addEventListener("input", () => {
      const v = Number(this.pixelRatio.value);
      this.paintRange(this.pixelRatio);
      this.pixelRatioValue.textContent = `${v.toFixed(2)}×`;
      this.emit({ kind: "pixelRatio", value: v });
    });

    for (const id of ["buoyancyProbes", "wakeProbes"] as const) {
      const cb = this.el.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
      cb.addEventListener("change", () => this.emit({ kind: "toggle", id, value: cb.checked }));
    }

    this.sunShafts = this.el.querySelector('[data-testid="sunShafts"]') as HTMLInputElement;
    this.sunShafts.addEventListener("change", () => this.emit({ kind: "sunShafts", value: this.sunShafts.checked }));

    this.ssr = this.el.querySelector('[data-testid="ssr"]') as HTMLInputElement;
    this.ssr.addEventListener("change", () => this.emit({ kind: "param", path: "fresnel.ssr", value: this.ssr.checked }));

    this.spray = this.el.querySelector('[data-testid="spray"]') as HTMLInputElement;
    this.spray.addEventListener("change", () => this.emit({ kind: "param", path: "spray.enabled", value: this.spray.checked }));

    this.rain = this.el.querySelector('[data-testid="rain"]') as HTMLInputElement;
    this.rain.addEventListener("change", () => this.emit({ kind: "param", path: "weather.rainEnabled", value: this.rain.checked }));

    this.sync(initial);
  }

  onChange(cb: (e: GuiEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Reflect params into the controls without emitting. */
  sync(p: OceanParams): void {
    this.quality.value = p.quality;
    this.ssr.checked = p.fresnel.ssr;
    this.ssr.disabled = !tierConfig(p.quality).ssr;
    this.sunShafts.checked = p.underwater.sunShafts;
    this.spray.checked = p.spray.enabled;
    this.spray.disabled = !tierConfig(p.quality).spray;
    this.rain.checked = p.weather.rainEnabled;
    this.rain.disabled = !tierConfig(p.quality).rain;
    for (const { input, value, def } of this.sliders.values()) {
      const v = getNumber(p, def.path);
      input.value = String(v);
      this.paintSlider(input, value, def, v);
    }
  }

  setPreset(name: string): void {
    this.preset.value = name;
  }

  setPixelRatio(v: number): void {
    this.pixelRatio.value = String(v);
    this.paintRange(this.pixelRatio);
    this.pixelRatioValue.textContent = `${v.toFixed(2)}×`;
  }

  setRebuilding(on: boolean): void {
    this.pill.hidden = !on;
    this.quality.disabled = on;
  }

  private paintSlider(input: HTMLInputElement, value: HTMLElement, def: SliderDef, v: number): void {
    value.textContent = def.format(v);
    this.paintRange(input);
  }

  /** Blue fill to the left of the thumb via a CSS variable. */
  private paintRange(input: HTMLInputElement): void {
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty("--fill", `${pct}%`);
  }

  private emit(e: GuiEvent): void {
    for (const l of this.listeners) l(e);
  }
}

function getNumber(p: OceanParams, path: string): number {
  let cur: unknown = p;
  for (const k of path.split(".")) cur = (cur as Record<string, unknown>)[k];
  return typeof cur === "number" ? cur : 0;
}
