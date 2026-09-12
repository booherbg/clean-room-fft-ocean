/**
 * Ocean wave spectrum (spec §1.1).
 *
 * The sea surface is modelled as a sum of deep-water plane waves whose
 * amplitudes are drawn from an energy spectrum Φ(k). We use the empirical
 * JONSWAP omnidirectional spectrum (Hasselmann et al. 1973) times the
 * Hasselmann (1980) directional spread, converted from (ω, θ) to the k-grid
 * as described in Horvath 2015 ("Empirical directional wave spectra for
 * computer graphics"). The result feeds Tessendorf's (2001) h0(k).
 *
 * This file is the *oracle*: the GPU spectrum shader ports it line-for-line.
 */
import type { WaveParams } from "./params";

export const G = 9.81;

/** Deep-water dispersion relation: ω = sqrt(g·k). */
export function dispersion(k: number, g: number = G): number {
  return Math.sqrt(g * k);
}

/** dω/dk = g / (2ω) — the Jacobian of the ω→k change of variables. */
export function dispersionDerivative(k: number, g: number = G): number {
  return g / (2 * dispersion(k, g));
}

export interface JonswapParams {
  omegaPeak: number;
  /** Peak-enhancement factor γ (1 = Pierson–Moskowitz). */
  gamma: number;
  /** Multiplies the peak exponent r. */
  sharpness: number;
  /** Phillips constant α (≈ 0.0081 for a fully developed sea). */
  alpha: number;
  g: number;
}

/**
 * JONSWAP: S(ω) = α g² / ω⁵ · exp(−1.25 (ωp/ω)⁴) · γ^r,
 * r = exp(−(ω−ωp)² / (2 σ² ωp²)), σ = 0.07 for ω ≤ ωp, 0.09 above.
 * Returns 0 for ω ≤ 0 (the exp(−1.25 (ωp/ω)⁴) term kills it anyway).
 */
export function jonswap(omega: number, p: JonswapParams): number {
  if (omega <= 0) return 0;
  const { omegaPeak, gamma, sharpness, alpha, g } = p;
  const sigma = omega <= omegaPeak ? 0.07 : 0.09;
  const d = omega - omegaPeak;
  const r = Math.exp(-(d * d) / (2 * sigma * sigma * omegaPeak * omegaPeak));
  const ratio = omegaPeak / omega;
  const pm = ((alpha * g * g) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(ratio, 4));
  return pm * Math.pow(gamma, r * sharpness);
}

export interface SpreadParams {
  omegaPeak: number;
  windSpeed: number;
  /** Radians. */
  windDirection: number;
  /** ∈ [0,1]: weight of the mirrored (θ+π) lobe. */
  standingWaveRatio: number;
  g: number;
}

const S_MIN = 1;
const S_MAX = 200;
/** Trapezoid samples used to normalise D. The GPU shader uses the same 64. */
const NORM_SAMPLES = 64;

/**
 * Hasselmann (1980) sharpness exponent:
 *   s = 6.97 (ω/ωp)^4.06                       for ω < ωp
 *   s = 9.77 (ω/ωp)^(−2.33 − 1.45 (U/cp − 1.17)) for ω ≥ ωp
 * with phase speed at the peak cp = ωp/kp = g/ωp. Clamped to [1, 200].
 */
function hasselmannS(omega: number, p: SpreadParams): number {
  const ratio = omega / p.omegaPeak;
  let s: number;
  if (omega < p.omegaPeak) {
    s = 6.97 * Math.pow(ratio, 4.06);
  } else {
    const cp = p.g / p.omegaPeak;
    const mu = -2.33 - 1.45 * (p.windSpeed / cp - 1.17);
    s = 9.77 * Math.pow(ratio, mu);
  }
  if (!Number.isFinite(s)) s = S_MAX;
  return Math.min(S_MAX, Math.max(S_MIN, s));
}

/** Unnormalised cos^{2s}((θ−θw)/2) with the mirrored lobe mixed in. */
function spreadRaw(theta: number, s: number, p: SpreadParams): number {
  const half = (theta - p.windDirection) / 2;
  const c = Math.cos(half);
  const m = Math.sin(half); // cos((θ − θw + π)/2) = −sin(half); even power
  return Math.pow(c * c, s) + p.standingWaveRatio * Math.pow(m * m, s);
}

/**
 * Directional spread D(θ, ω) = N(s) · cos^{2s}((θ − θw)/2) (+ mirror lobe),
 * normalised numerically so that ∫₀^{2π} D dθ = 1 using a 64-sample
 * trapezoid (the integrand is periodic, so the trapezoid rule is spectrally
 * accurate).
 */
export function hasselmannSpread(theta: number, omega: number, p: SpreadParams): number {
  const s = hasselmannS(omega, p);
  let sum = 0;
  const step = (2 * Math.PI) / NORM_SAMPLES;
  for (let i = 0; i < NORM_SAMPLES; i++) sum += spreadRaw(i * step, s, p);
  const integral = sum * step;
  if (integral <= 0) return 0;
  return spreadRaw(theta, s, p) / integral;
}

/**
 * Pierson–Moskowitz significant wave height for a fully developed sea:
 *   Hs ≈ 0.21 · U² / g   (2.5 m at 10 m/s, 13 m at 25 m/s).
 */
export function piersonMoskowitzHs(windSpeed: number, g: number = G): number {
  return (0.21 * windSpeed * windSpeed) / g;
}

/**
 * Upper bound on significant steepness Hs / λp. Fully developed seas sit
 * near 0.03–0.05; fetch-limited (young) seas approach 1/16. The demo pairs
 * 17–25 m/s winds with 60–70 m peaks, which PM alone would turn into a 13 m
 * sea that folds everywhere, so the wave height is soft-capped at this
 * steepness times the peak wavelength.
 */
export const MAX_STEEPNESS = 0.06;
/** Exponent of the smooth-minimum joining the PM curve and the steepness cap. */
const SOFT_MIN_P = 4;

/**
 * Significant wave height (m) the spectrum is calibrated to:
 *   Hs = amplitude · softmin(0.21 U²/g, MAX_STEEPNESS · λp)
 * where softmin(a, b) = (a⁻ᵖ + b⁻ᵖ)^(−1/p) blends the two limits without a
 * kink on the wind slider. Monotonic in U, ∝ U² while well below the cap.
 */
export function significantWaveHeight(w: Pick<WaveParams, "amplitude" | "windSpeed" | "peakWavelength" | "gravity">): number {
  const pm = piersonMoskowitzHs(w.windSpeed, w.gravity);
  const cap = MAX_STEEPNESS * w.peakWavelength;
  if (pm <= 0) return 0;
  const soft = Math.pow(Math.pow(pm, -SOFT_MIN_P) + Math.pow(cap, -SOFT_MIN_P), -1 / SOFT_MIN_P);
  return w.amplitude * soft;
}

/** Samples of the log-ω trapezoid in `spectrumMoment0`. */
const M0_SAMPLES = 2048;

/**
 * Zeroth moment m0 = ∫₀^∞ S(ω) dω of the JONSWAP shape for the given
 * parameters (whatever `alpha` they carry). Trapezoid in log ω over
 * [ωp/50, 50 ωp]; the ω⁻⁵ tail beyond that holds < 1e-6 of the energy and
 * the exp(−1.25 (ωp/ω)⁴) cut-off kills everything below.
 */
export function spectrumMoment0(p: JonswapParams): number {
  const lo = Math.log(p.omegaPeak / 50);
  const hi = Math.log(p.omegaPeak * 50);
  const step = (hi - lo) / M0_SAMPLES;
  let sum = 0;
  for (let i = 0; i <= M0_SAMPLES; i++) {
    const omega = Math.exp(lo + i * step);
    const f = jonswap(omega, p) * omega; // dω = ω d(ln ω)
    sum += i === 0 || i === M0_SAMPLES ? f / 2 : f;
  }
  return sum * step;
}

/**
 * Tessendorf's h̃(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt} with
 * E|h0|² = Φ gives Var(h) = Σ_k (Φ(k) + Φ(−k)) = 2 Σ Φ ≈ 2 m0 — twice the
 * spectrum's own variance. The calibration divides that out.
 */
const HERMITIAN_DOUBLING = 2;

/**
 * Energy scale α (JONSWAP's Phillips constant) such that the *continuous*
 * spectrum carries the variance of `significantWaveHeight`:
 *   ∫ S(ω) dω = (Hs / 4)² / 2.
 * Being a normalisation of the analytic spectrum, the resulting amplitude
 * is independent of tile size and N; a finite tile only truncates the tails
 * (see tests/oceanCpu.test.ts for what that costs). Wind enters through Hs
 * only; the Hasselmann spread integrates to 1 so it carries no energy.
 * Mirrored on the GPU by passing this value as `uAlpha`.
 */
export function alphaFor(w: WaveParams): number {
  const hs = significantWaveHeight(w);
  if (hs <= 0) return 0;
  const omegaPeak = dispersion((2 * Math.PI) / w.peakWavelength, w.gravity);
  const unit = spectrumMoment0({
    omegaPeak,
    gamma: w.jonswapGamma,
    sharpness: w.spectralSharpness,
    alpha: 1,
    g: w.gravity,
  });
  if (unit <= 0) return 0;
  const rms = hs / 4;
  return (rms * rms) / HERMITIAN_DOUBLING / unit;
}

/** A cascade's wavenumber band: see `bandWeight`. */
export interface KBand {
  /** Lower edge (rad/m); 0 for the coarsest cascade. */
  kMin: number;
  /** Upper edge; Infinity for the finest cascade. */
  kMax: number;
  /** Width of the energy cross-fade centred on `kMin` (0 = hard edge). */
  kMinWidth: number;
  /** Width of the energy cross-fade centred on `kMax` (0 = hard edge). */
  kMaxWidth: number;
}

/**
 * Energy weight of wavenumber |k| in a cascade's band (spec §1.4).
 *
 * With zero widths this is the hard mask [kMin, kMax). With a width `w` the
 * edge becomes a linear ramp in energy over [edge − w/2, edge + w/2], and
 * the neighbouring cascade uses the complementary ramp, so across a seam
 * the weights sum to 1. The width is the finer tile's bin spacing: each of
 * its bins stands for a dk×dk cell of k-space, so a bin sitting on the
 * seam should carry about half the energy of its cell — the ramp gives it
 * exactly that, while a hard cut on bin centres would either drop the cell
 * (a hole in the spectrum) or count it twice.
 */
export function bandWeight(k: number, band: KBand): number {
  const { kMin, kMax, kMinWidth, kMaxWidth } = band;
  let w = 1;
  if (kMinWidth > 0) w *= clamp01((k - (kMin - kMinWidth / 2)) / kMinWidth);
  else if (k < kMin) return 0;
  if (kMax !== Infinity) {
    if (kMaxWidth > 0) w *= 1 - clamp01((k - (kMax - kMaxWidth / 2)) / kMaxWidth);
    else if (k >= kMax) return 0;
  }
  return w;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Per-bin energy on the k-grid of a tile of side L:
 *   Φ(k) = S(ω) · D(θ, ω) · (dω/dk) / |k| · (2π/L)² · bandWeight(|k|)
 * Returns 0 at k = 0 and outside the cascade band [kMin, kMax) (soft-edged
 * by `kMinWidth` / `kMaxWidth`; see `bandWeight`).
 * Wave height (∝ √Φ) scales linearly with `amplitude`; `alpha` defaults to
 * `alphaFor(w)` and may be passed precomputed when looping over a grid.
 */
export function phi(
  kx: number,
  kz: number,
  w: WaveParams,
  L: number,
  kMin: number,
  kMax: number,
  alpha: number = alphaFor(w),
  kMinWidth = 0,
  kMaxWidth = 0,
): number {
  const k = Math.hypot(kx, kz);
  if (k === 0) return 0;
  const band = bandWeight(k, { kMin, kMax, kMinWidth, kMaxWidth });
  if (band <= 0) return 0;

  const g = w.gravity;
  const omega = dispersion(k, g);
  const theta = Math.atan2(kz, kx);
  const omegaPeak = dispersion((2 * Math.PI) / w.peakWavelength, g);

  const s = jonswap(omega, {
    omegaPeak,
    gamma: w.jonswapGamma,
    sharpness: w.spectralSharpness,
    alpha,
    g,
  });
  const d = hasselmannSpread(theta, omega, {
    omegaPeak,
    windSpeed: w.windSpeed,
    windDirection: w.windDirection,
    standingWaveRatio: w.standingWaveRatio,
    g,
  });
  const dk = (2 * Math.PI) / L;
  return (band * s * d * dispersionDerivative(k, g) * dk * dk) / k;
}
