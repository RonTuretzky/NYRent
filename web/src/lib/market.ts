/**
 * THE single market — constants and formulas (shared contract and calculator inputs).
 *
 * Every page renders numbers computed here so they always agree:
 *   growth        g  = settle/base − 1
 *   payout ratio  r  = clamp((g − 0.03) / 0.05, 0, 1)
 *                    = clamp((settle − strikeLow) / (strikeHigh − strikeLow), 0, 1)
 *   renter        N = R × 0.05, cost = N × p, breakeven g = 3% + 5% × p
 *   insurer       premium = p×u×C, yield = y×C (planned), claims = r×u×C,
 *                 breakeven g = 3% + 5% × (p + y/u), max loss (premium-only)
 *                 = (1−p)×u×C, worst-case net (with yield) = y×C − (1−p)×u×C
 *   market view   implied growth g* = 3% + 5% × p, implied rent = base×(1+g*)
 *
 * Pure module (no React, no chain) so it runs under `node --test`
 * (src/lib/market.test.ts pins the acceptance numbers).
 */

/** The one market the app exposes — hardcoded, never a picker. */
export const ACTIVE_SERIES_ID = 0;
export const MARKET_NAME = "Manhattan Rent Cover, Sep 2026 → Sep 2027";

/** Coverage band: payouts start at +3% YoY, full payout at +8% YoY. */
export const COVERAGE_FLOOR = 0.03;
export const COVERAGE_CEIL = 0.08;
export const BAND_WIDTH = COVERAGE_CEIL - COVERAGE_FLOOR; // 0.05

/** Demo fallbacks — the on-chain market is created with these exact
 * parameters; live chain reads take precedence when present. */
export const DEMO_BASE_CENTS = 9288; // verified Sept 2026 fixture print, $/SF
export const DEMO_PREMIUM_P = 0.285; // premiumRateBps 2850 / 10000
export const DEMO_YIELD_RATE = 0; // escrow holds the backing currency; no yield is assumed
export const DEMO_SALE_END = 1_819_756_800n; // 2027-09-01 00:00 UTC
export const DEMO_OBS_START = 1_819_756_800n;
export const DEMO_OBS_END = 1_822_348_740n;
export const DEMO_REDEEM_END = 1_824_940_740n;

export function strikeLowCentsFor(baseCents: number): number {
  return Math.round(baseCents * (1 + COVERAGE_FLOOR));
}
export function strikeHighCentsFor(baseCents: number): number {
  return Math.round(baseCents * (1 + COVERAGE_CEIL));
}
export const DEMO_STRIKE_LOW_CENTS = strikeLowCentsFor(DEMO_BASE_CENTS); // 9567
export const DEMO_STRIKE_HIGH_CENTS = strikeHighCentsFor(DEMO_BASE_CENTS); // 10031

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** YoY growth from a settle print: g = settle/base − 1. */
export function growthFor(settleCents: number, baseCents: number): number {
  return settleCents / baseCents - 1;
}

/** Payout ratio from YoY growth: 0 at ≤3%, linear to 1 at ≥8%. */
export function payoutRatioFromGrowth(g: number): number {
  return clamp01((g - COVERAGE_FLOOR) / BAND_WIDTH);
}

/** Equivalent form on index cents against the strikes. */
export function payoutRatioFromCents(
  settleCents: number,
  lowCents: number,
  highCents: number,
): number {
  return clamp01((settleCents - lowCents) / (highCents - lowCents));
}

/** Price as a forecast: price-equivalent growth (not expected growth) g* = 3% + 5% × p. */
export function impliedGrowth(p: number): number {
  return COVERAGE_FLOOR + BAND_WIDTH * p;
}

/** Implied Sept 2027 print = base × (1 + g*), in index cents. */
export function impliedRentCents(baseCents: number, p: number): number {
  return Math.round(baseCents * (1 + impliedGrowth(p)));
}

/* ---------------------------------- renter ---------------------------------- */

export interface RenterQuote {
  /** RENT to buy for full coverage of the five-point band on annual rent R: N = R × 0.05. */
  units: number;
  /** Premium paid up front: N × p. */
  cost: number;
  /** Growth where payout = cost: 3% + 5% × p. */
  breakevenGrowth: number;
  /** Full-band payout: N (each RENT pays up to 1). */
  maxPayout: number;
}

export function renterQuote(annualRent: number, p: number): RenterQuote {
  const units = annualRent * BAND_WIDTH;
  return {
    units,
    cost: units * p,
    breakevenGrowth: impliedGrowth(p),
    maxPayout: units,
  };
}

/** Payout at growth g for N units: N × r. */
export function renterPayoutAt(g: number, units: number): number {
  return units * payoutRatioFromGrowth(g);
}

/* ---------------------------------- insurer --------------------------------- */

export interface InsurerQuote {
  /** RENT minted 1:1 against deposited capital C. */
  minted: number;
  /** RENT sold: u × C. */
  sold: number;
  /** Premium income: p × u × C. */
  premiumIncome: number;
  /** Planned yield on escrow: y × C (contracts hold the stable un-invested). */
  yieldIncome: number;
  /** Growth where net = 0: 3% + 5% × (p + y/u); Infinity when u = 0. */
  breakevenGrowth: number;
  /** Premium-only max loss at r = 1: (1 − p) × u × C. */
  maxLossPremiumOnly: number;
  /** Worst-case net including planned yield: y×C − (1 − p)×u×C. */
  worstCaseNet: number;
}

export function insurerQuote(
  capital: number,
  p: number,
  y: number,
  u: number,
): InsurerQuote {
  const sold = u * capital;
  const premiumIncome = p * sold;
  const yieldIncome = y * capital;
  const maxLossPremiumOnly = (1 - p) * sold;
  return {
    minted: capital,
    sold,
    premiumIncome,
    yieldIncome,
    breakevenGrowth:
      u === 0 ? Infinity : COVERAGE_FLOOR + BAND_WIDTH * (p + y / u),
    maxLossPremiumOnly,
    worstCaseNet: yieldIncome - maxLossPremiumOnly,
  };
}

/** Claims paid at growth g: r × u × C. */
export function insurerClaimsAt(g: number, capital: number, u: number): number {
  return payoutRatioFromGrowth(g) * u * capital;
}

/** Net P&L at growth g: premium + yield − claims. */
export function insurerNetAt(
  g: number,
  capital: number,
  p: number,
  y: number,
  u: number,
): number {
  const q = insurerQuote(capital, p, y, u);
  return q.premiumIncome + q.yieldIncome - insurerClaimsAt(g, capital, u);
}

/* --------------------------------- outcomes --------------------------------- */

/** The shared rent-outcome grid every table/chart runs over (spec):
 * g ∈ {−2%, 0, 2, 3, 4, 5, 6, 7, 8, 10, 12%}. */
export const OUTCOME_GRID: readonly number[] = [
  -0.02, 0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.12,
];

/** Hypothetical settle print at growth g: round(base × (1 + g)), index cents. */
export function settleCentsAt(baseCents: number, g: number): number {
  return Math.round(baseCents * (1 + g));
}

/* -------------------------------- formatting -------------------------------- */

/** "+4.4%" style growth label (one decimal, signed). */
export function formatGrowth(g: number, decimals = 1): string {
  if (!Number.isFinite(g)) return "—";
  const pct = (g * 100).toFixed(decimals);
  return `${g >= 0 && !pct.startsWith("-") ? "+" : ""}${pct}%`;
}

/** Unsigned percent label: 0.04425 → "4.4%"; Infinity (no breakeven) → "—". */
export function formatPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

/** Round a dollar amount to cent precision (half away from zero) — use at
 * display/compare boundaries so 3000 × 0.285 IS 855, not 854.99…9. */
export function roundCents(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100;
}

/* ----------------------- aliases + per-figure functions ---------------------- */
/* Second call style over the same primitives: page code that prefers
 * per-figure functions/param objects to the quote objects above. */

/** Alias of ACTIVE_SERIES_ID — "market" name for page-level code. */
export const ACTIVE_MARKET_ID = ACTIVE_SERIES_ID;
export const BAND_LOW_GROWTH = COVERAGE_FLOOR;
export const BAND_HIGH_GROWTH = COVERAGE_CEIL;
/** Demo premium in the pool's own unit (bps): 2850 ⇔ p = 0.285. */
export const DEMO_PREMIUM_RATE_BPS = 2850;

/** Dashboard input defaults (spec). */
export const DEFAULT_INSURER_CAPITAL = 100_000;
export const DEFAULT_RENTER_ANNUAL_RENT = 60_000;
export const DEFAULT_YIELD_RATE = DEMO_YIELD_RATE;
export const DEFAULT_SOLD_FRACTION = 0.1;

/** premiumRateBps → pool price p (dollar-stable per RENT). */
export function bpsToPrice(bps: number): number {
  return bps / 10_000;
}

/** growthFor with (base, settle) argument order. */
export function growthFromCents(
  baseCents: number,
  settleCents: number,
): number {
  return growthFor(settleCents, baseCents);
}

/** Alias of settleCentsAt. */
export function settleCentsForGrowth(baseCents: number, g: number): number {
  return settleCentsAt(baseCents, g);
}

// renter --------------------------------------------------------------------

/** RENT to buy for full coverage of the five-point band on annual rent R: N = R × 0.05. */
export function renterCoverAmount(annualRent: number): number {
  return annualRent * BAND_WIDTH;
}

/** Cost (premium) of buying N RENT at price p. */
export function renterCost(coverAmount: number, p: number): number {
  return coverAmount * p;
}

/** Renter breakeven growth = 3% + 5% × p. */
export function renterBreakevenGrowth(p: number): number {
  return impliedGrowth(p);
}

export interface RenterOutcome {
  g: number;
  settleCents: number;
  r: number;
  /** N × r — what the market pays. */
  payout: number;
  /** payout − cost. */
  net: number;
  /** R × max(g, 0) — the rent increase actually faced, for context. */
  rentIncrease: number;
}

export function renterOutcome(
  annualRent: number,
  p: number,
  baseCents: number,
  g: number,
): RenterOutcome {
  const units = renterCoverAmount(annualRent);
  const r = payoutRatioFromGrowth(g);
  const payout = units * r;
  return {
    g,
    settleCents: settleCentsAt(baseCents, g),
    r,
    payout,
    net: payout - renterCost(units, p),
    rentIncrease: annualRent * Math.max(g, 0),
  };
}

export function renterOutcomes(
  annualRent: number,
  p: number,
  baseCents: number,
  grid: readonly number[] = OUTCOME_GRID,
): RenterOutcome[] {
  return grid.map((g) => renterOutcome(annualRent, p, baseCents, g));
}

// insurer -------------------------------------------------------------------

export interface InsurerParams {
  /** C — capital deposited (mints C RENT 1:1). */
  capital: number;
  /** p — initial RENT price / premium (0..1). */
  p: number;
  /** y — planned annual yield on escrow (0..1). */
  yieldRate: number;
  /** u — fraction of minted RENT sold (0..1). */
  soldFraction: number;
}

/** RENT minted = C (1 token ⇔ $1 escrowed). */
export function insurerMinted(params: InsurerParams): number {
  return params.capital;
}

/** RENT sold = u × C. */
export function insurerSold(params: InsurerParams): number {
  return params.soldFraction * params.capital;
}

/** Premium income = p × u × C. */
export function insurerPremiumIncome(params: InsurerParams): number {
  return params.p * insurerSold(params);
}

/** Planned yield income = y × C. */
export function insurerYieldIncome(params: InsurerParams): number {
  return params.yieldRate * params.capital;
}

/** Claims paid at ratio r = r × u × C. */
export function insurerClaims(params: InsurerParams, r: number): number {
  return r * insurerSold(params);
}

/** Net P&L at ratio r = premium + yield − claims. */
export function insurerNet(params: InsurerParams, r: number): number {
  return (
    insurerPremiumIncome(params) +
    insurerYieldIncome(params) -
    insurerClaims(params, r)
  );
}

/** Insurer breakeven growth = 3% + 5% × (p + y/u); Infinity when u = 0. */
export function insurerBreakevenGrowth(
  p: number,
  yieldRate: number,
  soldFraction: number,
): number {
  if (soldFraction <= 0) return Infinity;
  return COVERAGE_FLOOR + BAND_WIDTH * (p + yieldRate / soldFraction);
}

/** Premium-only worst case (r = 1, yield ignored): (1 − p) × u × C. */
export function insurerMaxLossPremiumOnly(params: InsurerParams): number {
  return (1 - params.p) * insurerSold(params);
}

/** With-yield worst-case net (r = 1): y×C − (1 − p)×u×C. */
export function insurerWorstCaseNet(params: InsurerParams): number {
  return insurerYieldIncome(params) - insurerMaxLossPremiumOnly(params);
}

export interface InsurerOutcome {
  g: number;
  settleCents: number;
  r: number;
  claims: number;
  net: number;
  endingCapital: number;
  /** net / C. */
  returnOnCapital: number;
}

export function insurerOutcome(
  params: InsurerParams,
  baseCents: number,
  g: number,
): InsurerOutcome {
  const r = payoutRatioFromGrowth(g);
  const net = insurerNet(params, r);
  return {
    g,
    settleCents: settleCentsAt(baseCents, g),
    r,
    claims: insurerClaims(params, r),
    net,
    endingCapital: params.capital + net,
    returnOnCapital: params.capital > 0 ? net / params.capital : 0,
  };
}

export function insurerOutcomes(
  params: InsurerParams,
  baseCents: number,
  grid: readonly number[] = OUTCOME_GRID,
): InsurerOutcome[] {
  return grid.map((g) => insurerOutcome(params, baseCents, g));
}

/* ------------------------ chain units (bigint-safe) ------------------------ */
/* Amounts that touch chain units never round-trip through Number. */

export const WAD = 10n ** 18n;

/** One year in seconds — the base observation window (Sept 2026) sits exactly
 * one year before the settle observation window (Sept 2027). */
export const YEAR_SECONDS = 365n * 86_400n;

/** Bigint (WAD) payout ratio, exactly mirroring CoverPool's settlement math —
 * use this whenever the ratio multiplies chain amounts. */
export function payoutRatioWadFromCents(
  settleCents: number,
  lowCents: number,
  highCents: number,
): bigint {
  const low = BigInt(lowCents);
  const high = BigInt(highCents);
  const c = BigInt(settleCents);
  if (c <= low) return 0n;
  if (c >= high) return WAD;
  return ((c - low) * WAD) / (high - low);
}

/** N = R × 0.05 in currency wei, exact: rentWei / 20. */
export function renterCoverWei(annualRentWei: bigint): bigint {
  return annualRentWei / 20n;
}

/** Premium in wei for buying `coverWei` RENT at `premiumRateBps` (matches the
 * pool's premium math: cover × bps / 10000). */
export function premiumWei(coverWei: bigint, premiumRateBps: number): bigint {
  return (coverWei * BigInt(premiumRateBps)) / 10_000n;
}

/** Redemption value of `coverWei` RENT at a settled WAD ratio. */
export function payoutWei(coverWei: bigint, ratioWad: bigint): bigint {
  return (coverWei * ratioWad) / WAD;
}
