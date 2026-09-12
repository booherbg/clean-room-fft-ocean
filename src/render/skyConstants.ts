/**
 * The sky's colour constants, once. `sky.ts` reads them for the CPU-side
 * sun / ambient colours handed to spray, terrain and the sun shafts;
 * `withCommon` turns them into `#define`s ahead of `common.glsl`, whose
 * `sunTint` / `skyRadiance` / `nightFactor` use the same names — so the
 * water's sun highlight and the spray's sun colour cannot drift apart.
 */
export type Rgb = readonly [number, number, number];

export const SKY = {
  /** Sun colour (linear) high in the sky ... */
  sunTintHigh: [1, 0.96, 0.9] as Rgb,
  /** ... and on the horizon. */
  sunTintLow: [1, 0.42, 0.12] as Rgb,
  /** Elevation (sin) above which the sun is fully white. */
  sunWarmEl: 0.35,
  /** Elevation below which the sun's light is gone (afterglow fades over fadeEl..0). */
  sunFadeEl: -0.18,
  /** Elevation band over which the sky gradient goes night → day. */
  dayElLo: -0.3,
  dayElHi: 0.15,
  /**
   * Daytime gradient (linear radiance, before the ACES tonemap). These are
   * the exposure of the whole scene: the water reflects this, the ambient
   * on the island and the spray is derived from it. Fitted to the reference
   * demo's clear sky at ~20° elevation ≈ sRGB (72,107,148) and horizon haze
   * ≈ (114,130,147): a deep blue overhead going to a muted grey-blue, not
   * a pale wash — the old values (0.07,0.2,0.62)/(0.44,0.58,0.8) put the
   * sky at twice the reference's luminance and washed the sea with it.
   */
  zenithDay: [0.04, 0.13, 0.32] as Rgb,
  horizonDay: [0.17, 0.23, 0.31] as Rgb,
  zenithNight: [0.022, 0.03, 0.05] as Rgb,
  horizonNight: [0.04, 0.05, 0.075] as Rgb,
  /** Sun elevation band over which the moon rises / moonlight fades in (≈19:20–20:30). */
  moonRiseEl: -0.35,
  moonFullEl: -0.6,
  /** Moonlight colour (linear, cool) at full strength. */
  moonTint: [0.62, 0.7, 0.9] as Rgb,
} as const;

const glslFloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const glsl = (v: number | Rgb): string => (typeof v === "number" ? glslFloat(v) : `vec3(${v.map(glslFloat).join(", ")})`);
const snake = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

/** `#define SKY_… value` for every entry of `SKY`, one per line. */
export function skyDefines(): string {
  return (Object.keys(SKY) as (keyof typeof SKY)[]).map((k) => `#define SKY_${snake(k)} ${glsl(SKY[k])}`).join("\n") + "\n";
}
