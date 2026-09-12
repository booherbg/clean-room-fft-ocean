/**
 * The galleon's hull lines, shared by the loft (`shipModel.ts`) and the
 * buoyancy columns (`hullPhysics.ts`). `t` runs 0 at the stern transom to 1
 * at the stem; all results are fractions of the beam / draft or metres of
 * height above the waterline.
 */

/** Half-beam as a fraction of B/2: a wide transom, fullest just aft of midships, a fine entry. */
export function halfBeamFraction(t: number): number {
  if (t < 0.45) return 0.62 + 0.38 * Math.sin(((Math.PI / 2) * t) / 0.45);
  const u = (t - 0.45) / 0.55;
  return Math.max(0.02, Math.pow(Math.cos((Math.PI / 2) * u), 0.7));
}

/** Keel depth as a fraction of the draft: deepest amidships, the forefoot rising into the stem. */
export function keelDepthFraction(t: number): number {
  const stern = 0.85 + 0.15 * Math.min(1, t / 0.3);
  const bow = t > 0.6 ? 1 - 0.45 * Math.pow((t - 0.6) / 0.4, 2) : 1;
  return Math.min(stern, bow);
}

/** Main-deck edge height above the waterline (m): the sheer rises toward both ends. */
export function deckHeight(t: number): number {
  return 3.1 + 4.5 * (t - 0.42) * (t - 0.42);
}

/** Bulwark height above the deck edge (m). */
export const BULWARK = 1.25;

/**
 * Section profile: half-width fraction of the local half-beam at height
 * fraction `u` (0 keel, 1 rail). A quarter-ellipse bilge with tumblehome
 * above the wales.
 */
export function sectionProfile(u: number): number {
  const ellipse = Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
  const tumble = 1 - 0.14 * Math.max(0, (u - 0.68) / 0.32);
  return ellipse * tumble;
}
