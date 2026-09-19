/**
 * Pure recommendation logic for the "Help me choose" wizard (/choose).
 *
 * Takes the user's plain answers (rough monthly rent, how worried they are,
 * how long they want protection) plus the open series on the active chain,
 * and returns the best-priced open series with a suggested protection size
 * derived from their rent exposure via the strike-band math:
 *
 *   riseFraction = (strikeHigh − strikeLow) / strikeLow
 *     — the payout ratio goes 0 → 1 as the reported rent index climbs
 *       across the band, i.e. rises ~riseFraction above the low strike.
 *   monthly increase at the top of the band ≈ rent × riseFraction
 *   suggested claim = months-of-increase-to-cover × that monthly increase
 *
 * No chain, react or environment dependencies — unit-tested with node:test.
 */

export type Worry = "a-little" | "a-lot";
export type Horizon = "this-window" | "longer";

export interface CandidateSeries {
  id: number;
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  saleEnd: bigint;
  obsStart: bigint;
  obsEnd: bigint;
  /** Escrowed capacity (currency wei). */
  escrow: bigint;
  /** Max-claim already sold (currency wei). */
  sold: bigint;
  paused: boolean;
  settled: boolean;
  cancelled: boolean;
}

export interface RecommendInput {
  /** Rough monthly rent in dollars (a range midpoint is fine). */
  monthlyRentUsd: number;
  worry: Worry;
  horizon: Horizon;
  nowSec: bigint;
  /** Active-chain currency decimals (18 WXDAI / 6 USDC). */
  currencyDecimals: number;
  series: CandidateSeries[];
}

export interface Recommendation {
  seriesId: number;
  /** True when the pick matches the reference shape (800-cent band,
   * saleEnd == obsStart). */
  standard: boolean;
  premiumRateBps: number;
  /** Index rise, low → high strike, as a fraction (e.g. 0.0909 ≈ 9%). */
  riseFraction: number;
  /** Suggested protection size in currency wei, capacity-clamped. */
  suggestedClaimWei: bigint;
  /** One-time price for that size in currency wei. */
  premiumWei: bigint;
  /** How many months of the full-band rent increase the suggested size
   * covers (recomputed after clamping). */
  monthsCovered: number;
  /** True when unsold capacity forced the suggestion below the target. */
  capacityLimited: boolean;
}

/** Reference series shape the market curates around. */
export const STANDARD_BAND_CENTS = 800;

export function isStandard(s: {
  strikeLowCents: number;
  strikeHighCents: number;
  saleEnd: bigint;
  obsStart: bigint;
}): boolean {
  return (
    s.strikeHighCents - s.strikeLowCents === STANDARD_BAND_CENTS &&
    s.saleEnd === s.obsStart
  );
}

export function capacityLeft(s: CandidateSeries): bigint {
  return s.cancelled ? 0n : s.escrow - s.sold;
}

/** Buyable right now: sale open, not paused/settled/cancelled, capacity left. */
export function isOpenForSale(s: CandidateSeries, nowSec: bigint): boolean {
  return (
    !s.cancelled &&
    !s.settled &&
    !s.paused &&
    nowSec <= s.saleEnd &&
    capacityLeft(s) > 0n
  );
}

/** Months of full-band rent increase the wizard aims to cover. */
export function targetMonths(worry: Worry): number {
  return worry === "a-lot" ? 12 : 4;
}

/** Dollars → currency wei (both live currencies are ~$1 stable units). */
export function usdToWei(usd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  // Two-decimal cents precision, then scale — avoids float blowups at 18 dec.
  const cents = BigInt(Math.round(usd * 100));
  return cents * 10n ** BigInt(Math.max(decimals - 2, 0));
}

export function weiToUsd(wei: bigint, decimals: number): number {
  return Number(wei) / 10 ** decimals;
}

export function riseFractionOf(s: {
  strikeLowCents: number;
  strikeHighCents: number;
}): number {
  return (s.strikeHighCents - s.strikeLowCents) / s.strikeLowCents;
}

export function premiumFor(claimWei: bigint, premiumRateBps: number): bigint {
  return (claimWei * BigInt(premiumRateBps)) / 10_000n;
}

/**
 * Picks the best-priced open series (standard-shaped first, anything open as
 * a fallback) and sizes the protection to the user's rent exposure.
 * Returns null when nothing is open for sale.
 */
export function recommend(input: RecommendInput): Recommendation | null {
  const open = input.series.filter((s) => isOpenForSale(s, input.nowSec));
  if (open.length === 0) return null;

  const standard = open.filter(isStandard);
  const pool = standard.length > 0 ? standard : open;

  const sorted = [...pool].sort((a, b) => {
    if (a.premiumRateBps !== b.premiumRateBps) {
      return a.premiumRateBps - b.premiumRateBps; // cheapest first
    }
    // Horizon tie-break: "this window" prefers the nearest observation
    // window, "longer" the furthest-out one.
    const byEnd = a.obsEnd < b.obsEnd ? -1 : a.obsEnd > b.obsEnd ? 1 : 0;
    return input.horizon === "longer" ? -byEnd : byEnd;
  });
  const pick = sorted[0];

  const rise = riseFractionOf(pick);
  const months = targetMonths(input.worry);
  const monthlyIncreaseUsd = input.monthlyRentUsd * rise;
  const targetWei = usdToWei(
    monthlyIncreaseUsd * months,
    input.currencyDecimals,
  );

  const left = capacityLeft(pick);
  const capacityLimited = targetWei > left;
  const suggestedClaimWei = capacityLimited ? left : targetWei;

  const monthsCovered =
    monthlyIncreaseUsd > 0
      ? weiToUsd(suggestedClaimWei, input.currencyDecimals) /
        monthlyIncreaseUsd
      : 0;

  return {
    seriesId: pick.id,
    standard: isStandard(pick),
    premiumRateBps: pick.premiumRateBps,
    riseFraction: rise,
    suggestedClaimWei,
    premiumWei: premiumFor(suggestedClaimWei, pick.premiumRateBps),
    monthsCovered,
    capacityLimited,
  };
}
