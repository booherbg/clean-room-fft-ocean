/**
 * User-facing parameter types and defaults for the ocean. Pure data; no
 * three.js, no DOM. Mirrors the panel described in the spec (§5).
 */

export interface WaveParams {
  /** Linear scale on wave height (folds the JONSWAP α / fetch term). */
  amplitude: number;
  animationSpeed: number;
  /** Tessendorf's λ: horizontal displacement scale. */
  choppiness: number;
  gravity: number;
  /** JONSWAP peak-enhancement factor γ (3.3 is the North Sea mean). */
  jonswapGamma: number;
  /** Peak wavelength λp in metres; ωp = sqrt(g · 2π/λp). */
  peakWavelength: number;
  /** Multiplies the JONSWAP peak exponent r. */
  spectralSharpness: number;
  /** ∈ [0,1]: how much energy is mirrored to θ+π (returning swell). */
  standingWaveRatio: number;
  /** Radians, direction the wind blows towards. */
  windDirection: number;
  /** m/s at 10 m. */
  windSpeed: number;
  seed: number;
}

export interface ColorParams {
  /**
   * Body colour of deep water (sRGB hex): the diffuse "albedo" the water
   * volume scatters back, multiplied by the sky + sun irradiance. The sea's
   * dark troughs are this; crests add the sky by Fresnel on top.
   */
  waterColor: string;
  /**
   * Beer–Lambert extinction per metre (sRGB hex, tiny numbers) applied over
   * the refracted path down to `depth`: red dies first, so a longer path
   * shifts the body toward blue-green.
   */
  absorptionColor: string;
  /**
   * Colour that leaks through where the water is thin or back-lit (sub-
   * surface scattering on crests, the shallows over sand): the turquoise.
   */
  transmissionColor: string;
  /** Virtual floor depth (m) where no seabed is in the depth pass. */
  depth: number;
}

export interface FoamParams {
  enabled: boolean;
  threshold: number;
  crestStrength: number;
  windwardStrength: number;
  decayTime: number;
}

export interface SssParams {
  intensity: number;
  power: number;
}

export interface FogParams {
  color: string;
  near: number;
  far: number;
}

export interface SunParams {
  intensity: number;
}

export interface SkyParams {
  timeOfDay: number;
  cloudCoverage: number;
}

/** Spray particles (spec §1.14): breaking-crest and bow spray. */
export interface SprayParams {
  enabled: boolean;
  /** Emission multiplier, 0..2 (1 = default). */
  density: number;
  /** Sprite size multiplier, 0.25..3 (1 = default). */
  size: number;
}

/** Rain (spec §1.16): the falling curtain and the ripples it leaves. */
export interface WeatherParams {
  /**
   * Rain intensity ∈ [0,1]: streak density (sub-linear), drop-impact rate,
   * and how matte the ripples leave the surface. 0 = dry.
   */
  rain: number;
  /** Master switch; `tierConfig(...).rain` is false on Low regardless. */
  rainEnabled: boolean;
}

export interface FresnelParams {
  iorRatio: number;
  refractionStrength: number;
  /** Screen-space reflection of the ship and terrain in the water (spec §1.12); off on the low tier regardless. */
  ssr: boolean;
}

export interface UnderwaterParams {
  /** Radial light-shaft post pass when the camera is below the surface (spec §1.13). */
  sunShafts: boolean;
}

export type QualityTier = "low" | "medium" | "high" | "ultra" | "max";

export interface OceanParams {
  waves: WaveParams;
  color: ColorParams;
  foam: FoamParams;
  sss: SssParams;
  fog: FogParams;
  sun: SunParams;
  sky: SkyParams;
  fresnel: FresnelParams;
  spray: SprayParams;
  weather: WeatherParams;
  underwater: UnderwaterParams;
  quality: QualityTier;
  /** Side of the largest cascade tile in metres. */
  maxScale: number;
}

export const DEFAULT_PARAMS: OceanParams = {
  waves: {
    amplitude: 1,
    animationSpeed: 1,
    choppiness: 1,
    gravity: 9.81,
    jonswapGamma: 3.3,
    peakWavelength: 70,
    spectralSharpness: 1,
    standingWaveRatio: 0,
    windDirection: 0,
    windSpeed: 8,
    seed: 1337,
  },
  color: {
    // Fitted to the reference demo's deep water seen ~30° down (Fair Weather,
    // sRGB ≈ 54,100,121): a cerulean whose troughs go navy. #145d78 was
    // ~1.6× too bright and greener than the reference.
    waterColor: "#174560",
    absorptionColor: "#0a0503",
    transmissionColor: "#48b09c",
    depth: 30,
  },
  // J < 0.8 folds ~10 % of the 96 m cascade at 15–17 m/s and none at 8 m/s,
  // matching Monahan's whitecap coverage (≈ 4–6 % vs < 0.1 %).
  foam: { enabled: true, threshold: 0.8, crestStrength: 2.5, windwardStrength: 1.5, decayTime: 0.5 },
  sss: { intensity: 1, power: 4 },
  fog: { color: "#b4c0cc", near: 500, far: 1800 },
  sun: { intensity: 1.5 },
  sky: { timeOfDay: 15, cloudCoverage: 0.37 },
  fresnel: { iorRatio: 1.33, refractionStrength: 0.1, ssr: true },
  underwater: { sunShafts: true },
  spray: { enabled: true, density: 1, size: 1 },
  // Dry by default; the wet presets (Storm, Foggy) turn it up.
  weather: { rain: 0, rainEnabled: true },
  quality: "high",
  maxScale: 1024,
};

export interface TierConfig {
  /** FFT size (power of two). */
  N: number;
  /**
   * FFT size of the last (finest) cascade; `N` for the others. Medium runs
   * its 96 m tile at N/2: the band it carries is fixed by the tile sizes
   * (see `cascadeLayout`), so only its Nyquist limit moves (0.75 → 1.5 m).
   */
  finestN: number;
  cascades: number;
  meshSegments: number;
  foam: boolean;
  sss: boolean;
  /** Spray particles (need the foam field). */
  spray: boolean;
  /** Rain: the streak curtain and the ripple field (spec §1.16). */
  rain: boolean;
  /** Screen-space reflections allowed on this tier. */
  ssr: boolean;
}

const TIERS: Record<QualityTier, TierConfig> = {
  low: { N: 256, finestN: 256, cascades: 1, meshSegments: 16, foam: false, sss: false, spray: false, rain: false, ssr: false },
  medium: { N: 256, finestN: 128, cascades: 2, meshSegments: 32, foam: true, sss: false, spray: true, rain: true, ssr: true },
  high: { N: 256, finestN: 256, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true },
  ultra: { N: 512, finestN: 512, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true },
  max: { N: 512, finestN: 512, cascades: 3, meshSegments: 64, foam: true, sss: true, spray: true, rain: true, ssr: true },
};

export function tierConfig(t: QualityTier): TierConfig {
  return { ...TIERS[t] };
}

/** Deep copy (params are plain nested objects of primitives). */
export function cloneParams(p: OceanParams): OceanParams {
  return {
    waves: { ...p.waves },
    color: { ...p.color },
    foam: { ...p.foam },
    sss: { ...p.sss },
    fog: { ...p.fog },
    sun: { ...p.sun },
    sky: { ...p.sky },
    fresnel: { ...p.fresnel },
    spray: { ...p.spray },
    weather: { ...p.weather },
    underwater: { ...p.underwater },
    quality: p.quality,
    maxScale: p.maxScale,
  };
}
