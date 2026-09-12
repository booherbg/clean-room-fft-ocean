/**
 * Cascade layout (spec §1.4).
 *
 * A real sea spans ~1000 m swell down to cm ripples; one N×N tile cannot hold
 * that range. We run up to three tiles of decreasing side that *abut* in
 * wavenumber space: cascade i keeps only |k| ∈ [kMin_i, kMax_i) so the union
 * is contiguous and no wave is counted twice.
 *
 * Hand-off rule. Tile i+1 (side L, bin spacing dk = 2π/L) represents k-space
 * as dk×dk cells around its bins. Only the DC cell lies wholly inside
 * |k| < dk, so the finer tile can take over at its own fundamental,
 * kMin_{i+1} = dk, with nothing unrepresented. (Any higher cut leaves holes:
 * the old cut at the coarse tile's 16th harmonic, k = 2π·16/1024 = 1.5·dk on
 * the 1024/96 pair, dropped the (1,1) cells — no wave between 45 and 64 m
 * along the diagonal.) Because a seam bin's cell straddles the seam, the
 * energy is cross-faded linearly over one bin width `dk` centred on the
 * seam, complementary on the two sides (`core/spectrum.bandWeight`) — a
 * bin on the seam carries half its cell's energy, as it should.
 *
 * The coarse tile then resolves waves down to λ = L/1.5 with ≥ 16 texels
 * per wavelength on every tier (1024 m / 256 → 4 m texels vs 64 m).
 */
import { tierConfig, type QualityTier } from "./params";
import type { KBand } from "./spectrum";

export interface CascadeLayout extends KBand {
  /** Tile side in metres. */
  size: number;
  /** FFT size of this cascade (the tier's `N`, or `finestN` for the last one). */
  N: number;
  /** Inclusive lower wavenumber bound (rad/m); 0 for the first cascade. */
  kMin: number;
  /** Exclusive upper wavenumber bound; Infinity for the last cascade. */
  kMax: number;
  /** Energy cross-fade width around `kMin` (the finer tile's bin spacing = this tile's own); 0 on the first cascade. */
  kMinWidth: number;
  /** Energy cross-fade width around `kMax` (the next tile's bin spacing); 0 on the last cascade. */
  kMaxWidth: number;
}

/** Tile sides relative to maxScale = 1024. */
const SIZES_STANDARD = [1024, 96, 9];
const SIZES_MAX = [1024, 48, 2.25];

/**
 * `Ns` overrides the per-cascade FFT sizes (default: the tier's `N`, with
 * `finestN` for the last cascade). The bands depend on the tile sizes only,
 * so changing a cascade's N leaves the k-ranges untouched; it only moves
 * that tile's Nyquist limit (π·N/size), which must stay above its kMin.
 */
export function cascadeLayout(maxScale: number, tier: QualityTier, Ns?: readonly number[]): CascadeLayout[] {
  const { cascades, N, finestN } = tierConfig(tier);
  const base = tier === "max" ? SIZES_MAX : SIZES_STANDARD;
  const sizes = base.slice(0, cascades).map((s) => (s * maxScale) / 1024);

  return sizes.map((size, i) => {
    const next = sizes[i + 1];
    const last = next === undefined;
    const own = fundamental(size);
    const kMin = i === 0 ? 0 : own;
    const kMinWidth = i === 0 ? 0 : own;
    const kMax = last ? Infinity : fundamental(next);
    const kMaxWidth = last ? 0 : fundamental(next);
    const n = Ns?.[i] ?? (last ? finestN : N);
    return { size, N: n, kMin, kMax, kMinWidth, kMaxWidth };
  });
}

/** Bin spacing of a tile of the given side: the k of its fundamental (longest) wave. */
function fundamental(size: number): number {
  return (2 * Math.PI) / size;
}
