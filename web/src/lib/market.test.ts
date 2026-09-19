/**
 * Acceptance numbers for the single shared market module (spec is law):
 *   renter  R=60,000 p=0.285 → N=3,000 cost=855 breakeven 4.4% (4.425) max 3,000
 *   insurer C=100,000 p=0.285 y=4% u=10% → premium 2,850 yield 4,000 worst −3,150
 *   market view p=0.285 → implied growth 4.4% (4.425)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INSURER_CAPITAL,
  DEFAULT_SOLD_FRACTION,
  DEFAULT_YIELD_RATE,
  DEMO_BASE_CENTS,
  DEMO_PREMIUM_P,
  DEMO_STRIKE_HIGH_CENTS,
  DEMO_STRIKE_LOW_CENTS,
  OUTCOME_GRID,
  WAD,
  formatGrowth,
  formatPct,
  growthFor,
  impliedGrowth,
  impliedRentCents,
  insurerBreakevenGrowth,
  insurerMaxLossPremiumOnly,
  insurerMinted,
  insurerNet,
  insurerNetAt,
  insurerOutcomes,
  insurerPremiumIncome,
  insurerQuote,
  insurerSold,
  insurerWorstCaseNet,
  insurerYieldIncome,
  payoutRatioFromCents,
  payoutRatioFromGrowth,
  payoutRatioWadFromCents,
  payoutWei,
  premiumWei,
  renterBreakevenGrowth,
  renterCost,
  renterCoverAmount,
  renterCoverWei,
  renterOutcome,
  renterOutcomes,
  renterQuote,
  roundCents,
  settleCentsForGrowth,
  strikeHighCentsFor,
  strikeLowCentsFor,
  type InsurerParams,
} from "./market.ts";

const approx = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} ≈ ${expected}`,
  );

test("locked strikes: round(9288×1.03)=9567, round(9288×1.08)=10031", () => {
  assert.equal(strikeLowCentsFor(DEMO_BASE_CENTS), 9567);
  assert.equal(strikeHighCentsFor(DEMO_BASE_CENTS), 10031);
  assert.equal(DEMO_STRIKE_LOW_CENTS, 9567);
  assert.equal(DEMO_STRIKE_HIGH_CENTS, 10031);
});

test("payout ratio: 0 at ≤3%, linear to 1 at ≥8%, both forms agree", () => {
  approx(payoutRatioFromGrowth(0.03), 0);
  approx(payoutRatioFromGrowth(-0.02), 0);
  approx(payoutRatioFromGrowth(0.055), 0.5);
  approx(payoutRatioFromGrowth(0.08), 1);
  approx(payoutRatioFromGrowth(0.12), 1);
  // cents form against the demo strikes
  approx(payoutRatioFromCents(9567, 9567, 10031), 0);
  approx(payoutRatioFromCents(10031, 9567, 10031), 1);
  const settle = 9800;
  approx(
    payoutRatioFromCents(settle, 9567, 10031),
    (settle - 9567) / (10031 - 9567),
  );
  // growth form ≈ cents form (rounding of strikes only)
  approx(
    payoutRatioFromGrowth(growthFor(settle, DEMO_BASE_CENTS)),
    payoutRatioFromCents(settle, 9567, 10031),
    1e-3,
  );
});

test("renter acceptance: R=60,000 p=0.285 → N=3,000 cost=855 breakeven 4.425% max 3,000", () => {
  const q = renterQuote(60_000, DEMO_PREMIUM_P);
  approx(q.units, 3000);
  approx(q.cost, 855);
  approx(q.breakevenGrowth, 0.04425);
  assert.equal(formatGrowth(q.breakevenGrowth), "+4.4%");
  approx(q.maxPayout, 3000);
});

test("insurer acceptance: C=100,000 p=0.285 y=4% u=10% → premium 2,850 yield 4,000 worst −3,150", () => {
  const q = insurerQuote(100_000, DEMO_PREMIUM_P, 0.04, 0.1);
  approx(q.minted, 100_000);
  approx(q.sold, 10_000);
  approx(q.premiumIncome, 2850, 1e-6);
  approx(q.yieldIncome, 4000);
  approx(q.maxLossPremiumOnly, 7150, 1e-6);
  approx(q.worstCaseNet, -3150, 1e-6);
  // worst case is the net at any r=1 outcome
  approx(insurerNetAt(0.12, 100_000, DEMO_PREMIUM_P, 0.04, 0.1), -3150, 1e-6);
  // insurer breakeven ≥ renter breakeven (the gap is the loading)
  const renter = renterQuote(60_000, DEMO_PREMIUM_P);
  approx(q.breakevenGrowth, 0.06425, 1e-9);
  assert.ok(q.breakevenGrowth >= renter.breakevenGrowth);
});

test("market view acceptance: p=0.285 → implied growth 4.425% (+4.4%), implied rent $96.99", () => {
  approx(impliedGrowth(DEMO_PREMIUM_P), 0.04425);
  assert.equal(formatGrowth(impliedGrowth(DEMO_PREMIUM_P)), "+4.4%");
  assert.equal(impliedRentCents(DEMO_BASE_CENTS, DEMO_PREMIUM_P), 9699);
});

/* ------------- per-figure function API (same primitives, same numbers) ------------- */

test("function API renter acceptance: N=3,000 cost=855 breakeven 4.4% max 3,000", () => {
  const n = renterCoverAmount(60_000);
  approx(n, 3_000);
  assert.equal(roundCents(renterCost(n, 0.285)), 855);
  approx(renterBreakevenGrowth(0.285), 0.04425);
  assert.equal(formatPct(renterBreakevenGrowth(0.285)), "4.4%");
  const worst = renterOutcome(60_000, 0.285, DEMO_BASE_CENTS, 0.12);
  approx(worst.payout, 3_000);
  approx(worst.net, 3_000 - 855, 1e-6);
});

test("function API insurer acceptance: premium 2,850 yield 4,000 worst −3,150", () => {
  const params: InsurerParams = {
    capital: DEFAULT_INSURER_CAPITAL,
    p: 0.285,
    yieldRate: DEFAULT_YIELD_RATE,
    soldFraction: DEFAULT_SOLD_FRACTION,
  };
  assert.equal(insurerMinted(params), 100_000);
  approx(insurerSold(params), 10_000);
  approx(insurerPremiumIncome(params), 2_850, 1e-6);
  approx(insurerYieldIncome(params), 4_000);
  approx(insurerMaxLossPremiumOnly(params), 7_150, 1e-6);
  approx(insurerWorstCaseNet(params), -3_150, 1e-6);
  // net at r=0 keeps premium+yield; r=1 equals the worst case; breakeven nets 0
  approx(insurerNet(params, 0), 6_850, 1e-6);
  approx(insurerNet(params, 1), insurerWorstCaseNet(params), 1e-9);
  const be = insurerBreakevenGrowth(0.285, 0.04, 0.1);
  approx(be, 0.06425);
  approx(insurerNet(params, payoutRatioFromGrowth(be)), 0, 1e-6);
  assert.equal(insurerBreakevenGrowth(0.285, 0.04, 0), Infinity);
  assert.equal(formatPct(insurerBreakevenGrowth(0.285, 0.04, 0)), "—");
});

test("outcome grids run the spec's g grid and agree with the quotes", () => {
  assert.deepEqual(
    [...OUTCOME_GRID],
    [-0.02, 0, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1, 0.12],
  );
  const params: InsurerParams = {
    capital: 100_000,
    p: 0.285,
    yieldRate: 0.04,
    soldFraction: 0.1,
  };
  const rows = insurerOutcomes(params, DEMO_BASE_CENTS);
  assert.equal(rows.length, OUTCOME_GRID.length);
  approx(rows[0].net, 6_850, 1e-6); // g = −2%: no claims
  const at8 = rows[OUTCOME_GRID.indexOf(0.08)];
  assert.equal(at8.r, 1);
  approx(at8.claims, 10_000);
  approx(at8.net, -3_150, 1e-6);
  approx(at8.endingCapital, 96_850, 1e-6);
  approx(at8.returnOnCapital, -0.0315, 1e-9);
  const renterRows = renterOutcomes(60_000, 0.285, DEMO_BASE_CENTS);
  approx(renterRows[0].net, -855, 1e-6);
  assert.equal(renterRows[0].rentIncrease, 0); // R × max(g, 0)
  const at5 = renterRows[OUTCOME_GRID.indexOf(0.05)];
  approx(at5.r, 0.4);
  approx(at5.payout, 1_200, 1e-6);
  approx(at5.rentIncrease, 3_000, 1e-6);
  assert.equal(at5.settleCents, settleCentsForGrowth(DEMO_BASE_CENTS, 0.05));
});

/* --------------------- chain units (bigint-safe helpers) --------------------- */

test("WAD payout ratio mirrors the pool's bigint settlement math", () => {
  assert.equal(payoutRatioWadFromCents(9567, 9567, 10031), 0n);
  assert.equal(payoutRatioWadFromCents(9000, 9567, 10031), 0n);
  assert.equal(payoutRatioWadFromCents(10031, 9567, 10031), WAD);
  assert.equal(payoutRatioWadFromCents(12000, 9567, 10031), WAD);
  // exact midpoint of the 464-cent band
  assert.equal(payoutRatioWadFromCents(9799, 9567, 10031), WAD / 2n);
  // historic settled market: clamp((9288−8800)/(9600−8800)) = 0.61
  assert.equal(payoutRatioWadFromCents(9288, 8800, 9600), (61n * WAD) / 100n);
});

test("bigint renter helpers: N = R/20, premium = N×bps/1e4, payout = N×r", () => {
  const rentWei = 60_000n * 10n ** 18n;
  const coverWei = renterCoverWei(rentWei);
  assert.equal(coverWei, 3_000n * 10n ** 18n);
  assert.equal(premiumWei(coverWei, 2850), 855n * 10n ** 18n);
  assert.equal(payoutWei(coverWei, WAD / 2n), 1_500n * 10n ** 18n);
  assert.equal(payoutWei(coverWei, 0n), 0n);
  assert.equal(payoutWei(coverWei, WAD), coverWei);
});
