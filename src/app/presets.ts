/**
 * Demo presets. Wind speed / peak wavelength are the reference demo's measured
 * values; the look (colours, sky, fog) is ours. A preset is a deep-partial
 * patch applied on top of `DEFAULT_PARAMS`.
 */
import { cloneParams, DEFAULT_PARAMS, type OceanParams } from "../core/params";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface Preset {
  label: string;
  patch: DeepPartial<OceanParams>;
}

export const PRESETS: Record<string, Preset> = {
  fairWeather: {
    label: "Fair Weather",
    patch: { waves: { windSpeed: 15, peakWavelength: 47 }, foam: { crestStrength: 3.2 } },
  },
  arctic: {
    label: "Arctic",
    patch: {
      waves: { windSpeed: 3, peakWavelength: 11 },
      // Full overcast, a flat slate sea (reference ≈ sRGB 73,75,76, hue 204):
      // the body is a cool grey — lit by the warm deck it lands neutral —
      // and the absorption is near-neutral so the long path does not strip
      // the red out of it.
      color: { waterColor: "#414449", absorptionColor: "#050505", transmissionColor: "#505860" },
      sky: { timeOfDay: 10, cloudCoverage: 1.0 },
      fog: { color: "#c4c0ba", near: 300, far: 1200 },
    },
  },
  corsair: {
    label: "Corsair",
    patch: {
      waves: { windSpeed: 15, peakWavelength: 47 },
      foam: { crestStrength: 3.2 },
      color: { waterColor: "#0b2a33" },
      sky: { timeOfDay: 14, cloudCoverage: 0.5 },
    },
  },
  dusk: {
    label: "Dusk",
    patch: {
      waves: { windSpeed: 7, peakWavelength: 140 },
      sky: { timeOfDay: 18.5, cloudCoverage: 0.3 },
      // A pale slate swell (reference ≈ sRGB 50,54,71): at twilight the sea
      // keeps more light than the sky gradient alone would give it. The fog
      // bank is a cool violet-grey, not the afterglow's orange.
      color: { waterColor: "#2c3a50" },
      fog: { color: "#403c52" },
    },
  },
  foggy: {
    label: "Foggy",
    patch: {
      waves: { windSpeed: 5, peakWavelength: 110 },
      // A dark, warm-grey rain fog (reference ≈ sRGB 87,81,73 at the
      // horizon, 69,66,62 on the water): early under a full deck. The water
      // itself is the same warm grey — in fog the sea has no colour of its
      // own left.
      fog: { color: "#5a544d", near: 20, far: 260 },
      color: { waterColor: "#5a5147", absorptionColor: "#050505", transmissionColor: "#55504a" },
      sky: { timeOfDay: 8, cloudCoverage: 1.0 },
      // Drizzle: enough to pock the water, not enough to see across.
      weather: { rain: 0.25 },
    },
  },
  moonlit: {
    label: "Moonlit",
    patch: {
      waves: { windSpeed: 3, peakWavelength: 80 },
      sky: { timeOfDay: 0, cloudCoverage: 0.2 },
      color: { waterColor: "#04101c" },
    },
  },
  tropics: {
    label: "Tropics",
    patch: {
      waves: { windSpeed: 10.2, peakWavelength: 130 },
      // Deep water only a touch greener and brighter than Fair Weather
      // (reference ≈ sRGB 61,125,154); the turquoise is in the shallows.
      color: { waterColor: "#1a5068", transmissionColor: "#6fd0b0" },
      sky: { timeOfDay: 13 },
    },
  },
  storm: {
    label: "Storm",
    patch: {
      waves: { windSpeed: 17, peakWavelength: 60 },
      // A gale: whitecaps sit dense on every crest and linger in the troughs.
      foam: { threshold: 0.85, crestStrength: 3.5, decayTime: 0.8 },
      // Late, fully overcast: the deck goes dark and brownish, the sea a
      // dark slate grey (reference ≈ sRGB 60,62,63), and the fog closes
      // the horizon. The deck, not the sun, lights the body now.
      sky: { timeOfDay: 18.2, cloudCoverage: 1.0 },
      color: { waterColor: "#67707a", absorptionColor: "#050505", transmissionColor: "#565a5c" },
      sun: { intensity: 0.8 },
      fog: { color: "#504c48", near: 40, far: 700 },
      // Driving rain: the curtain leans hard with the 17 m/s gale.
      weather: { rain: 0.9 },
    },
  },
  sunset: {
    label: "Sunset",
    patch: {
      waves: { windSpeed: 2.5, peakWavelength: 20 },
      // 18:24: the disc has just set (el ≈ −0.10), the twilight band is at
      // its widest and the afterglow still lays a warm glint path. The fog
      // bank itself is lit haze, not afterglow: cool grey-blue.
      sky: { timeOfDay: 18.4, cloudCoverage: 0.35 },
      color: { waterColor: "#1c2c42" },
      fog: { color: "#454c5c" },
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
/** The preset the app boots into. */
export const INITIAL_PRESET = "fairWeather";

/** Apply a deep-partial patch onto a copy of `base`. */
export function applyPatch(base: OceanParams, patch: DeepPartial<OceanParams>): OceanParams {
  const next = cloneParams(base);
  for (const key of Object.keys(patch) as (keyof OceanParams)[]) {
    const v = patch[key];
    if (v && typeof v === "object") Object.assign(next[key] as object, v);
    else if (v !== undefined) (next as unknown as Record<string, unknown>)[key] = v;
  }
  return next;
}

/** Full params for a preset: defaults + patch, keeping the current quality. */
export function presetParams(name: string, current: OceanParams): OceanParams {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset: ${name}`);
  const p = applyPatch(DEFAULT_PARAMS, preset.patch);
  p.quality = current.quality;
  return p;
}

/** Set a dotted path (`waves.windSpeed`) on a copy of the params. */
export function setPath(p: OceanParams, path: string, value: unknown): OceanParams {
  const next = cloneParams(p);
  const parts = path.split(".");
  let obj: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    const child = obj[k];
    if (!child || typeof child !== "object") throw new Error(`setPath: no object at ${parts.slice(0, i + 1).join(".")}`);
    obj = child as Record<string, unknown>;
  }
  obj[parts[parts.length - 1] as string] = value;
  return next;
}

/** Read a dotted path. */
export function getPath(p: OceanParams, path: string): unknown {
  let cur: unknown = p;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
