/**
 * Foam field rules (spec §1.5 / §1.16), pure TypeScript — the CPU reference
 * of `gpu/foam.frag.glsl`, which implements exactly these formulas per
 * texel. The e2e GPU harness (`e2e/pages/gpu.ts`) checks the shader against
 * the closed forms below on constant fields; the vitest suite checks the
 * closed forms themselves.
 *
 * The model, per step:
 *
 *   fold      = max(threshold − J, 0)                (UNclamped above 1: a
 *               truly folded crest, J < 0, injects in proportion to how far
 *               the surface overturned — Monahan-style whitecap loading)
 *   windward  = sat(dot(slopeDir, windDir))          (the crest's forward face)
 *   source    = crest·fold + windwardStrength·windward·fold
 *   source   *= 1 − breakup·noise                    (breakup = 0 in the
 *               oracle harness so the closed forms stay exact)
 *   decayed   = prev(at p − v·dt)·exp(−dt / (decayTime·decayScale(J)))
 *   e         = max(decayed, source)
 *
 * where `prev` is advected: foam slides down the wave face (against the
 * slope gradient) and drifts with the wind, and `decayScale` slows decay in
 * stretched water (J > 1, the troughs the sheet is left in) so whitewater
 * lingers behind the crest that made it.
 */

export interface FoamAdvect {
  /** Downslope drift, m/s per unit slope. */
  slide: number;
  /** Wind drift, m/s per m/s of wind... expressed directly in m/s here. */
  wind: number;
  /** Largest advection step, texels/frame (a warp, so this is cosmetic). */
  capTexels: number;
}

/** Decay-time multiplier in stretched water: 1 in compressed/neutral, 1+boost in a full trough. */
export function foamDecayScale(J: number, troughBoost: number): number {
  const stretch = Math.min(1, Math.max(0, J - 1));
  return 1 + troughBoost * stretch;
}

/** Injection from the Jacobian: proportional to the fold past `threshold`, unclamped above. */
export function foamFold(threshold: number, J: number): number {
  return Math.max(threshold - J, 0);
}

/** sat(dot(slopeDir, windDir)) — 0 when the slope is flat. */
export function foamWindward(slope: [number, number], windDir: [number, number]): number {
  const len = Math.hypot(slope[0], slope[1]);
  if (len < 1e-6) return 0;
  const d = (slope[0] * windDir[0] + slope[1] * windDir[1]) / len;
  return Math.min(1, Math.max(0, d));
}

export function foamSource(fold: number, windward: number, crestStrength: number, windwardStrength: number): number {
  return crestStrength * fold + windwardStrength * windward * fold;
}

/** `prev` after `dt` seconds of decay at `decayTime`·`scale` (0 decay time forgets everything). */
export function foamDecayed(prev: number, dt: number, decayTime: number, scale: number): number {
  if (decayTime <= 0) return 0;
  return prev * Math.exp(-dt / (decayTime * scale));
}

/**
 * Texel offset the previous field is read at: the foam now at `p` was, `dt`
 * ago, up the slope (it slid down) and upwind (it drifted). Capped —
 * sampling is a warp, so a large step is safe but looks like teleporting.
 */
export function foamAdvectionOffset(
  slope: [number, number],
  windDir: [number, number],
  dt: number,
  cellMetres: number,
  a: FoamAdvect,
): [number, number] {
  const ox = (slope[0] * a.slide - windDir[0] * a.wind) * (dt / cellMetres);
  const oz = (slope[1] * a.slide - windDir[1] * a.wind) * (dt / cellMetres);
  const len = Math.hypot(ox, oz);
  if (len <= a.capTexels || len === 0) return [ox, oz];
  const s = a.capTexels / len;
  return [ox * s, oz * s];
}

export interface FoamStepInput {
  prev: number;
  J: number;
  slope: [number, number];
  windDir: [number, number];
  dt: number;
  threshold: number;
  crestStrength: number;
  windwardStrength: number;
  decayTime: number;
  troughBoost: number;
  /** Breakup noise sample ∈ [0,1] already looked up for this texel; weight ∈ [0,1]. */
  breakup?: number;
  breakupNoise?: number;
}

/** One local foam step (advection displacement excluded — that is a resample). */
export function foamStep(i: FoamStepInput): number {
  const decayed = foamDecayed(i.prev, i.dt, i.decayTime, foamDecayScale(i.J, i.troughBoost));
  let source = foamSource(foamFold(i.threshold, i.J), foamWindward(i.slope, i.windDir), i.crestStrength, i.windwardStrength);
  source *= 1 - (i.breakup ?? 0) * (i.breakupNoise ?? 0);
  return Math.max(decayed, source);
}
