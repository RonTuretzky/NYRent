/**
 * decide.test.mjs — unit tests for the two-sided market-maker policy core
 * (node --test). Covers: determinism, every legacy safety clamp (premium
 * bounds, plausibility gate, freshness clocks, window rules, one-series-per-
 * run), the sell-side capital clamp, the whole buy-side selection matrix
 * (edge threshold, own-series exclusion, skip flags, caps binding order,
 * stale-inputs refusal), inventory lean transitions, own-series levers
 * (pauses / cancels / withdrawResiduals), and decimals parameterization
 * (18-dec WXDAI and 6-dec USDC).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  DEFAULT_CONFIG,
  validateSeriesParams,
  unitScale,
  milliunitsToUnits,
  dustUnits,
} from "./decide.mjs";
import { fairRatioBps, fairPremiumBps } from "./valuation.mjs";

const DAY = 86_400;
const NOW = 1_790_000_000; // fixed clock — decide() must take time from chainState only
const UNIT = 10n ** 18n; // 1 currency unit at the default 18 decimals

const ME = "0xA11ce00000000000000000000000000000000001"; // the agent wallet
const OTHER = "0xB0b0000000000000000000000000000000000002"; // some other underwriter

function mkChain(overrides = {}) {
  return {
    ok: true,
    nowSec: NOW,
    agent: { address: ME, currencyUnits: UNIT }, // 1 unit of working capital
    series: [],
    holdings: [],
    oracle: { count: 0, observations: [] },
    ...overrides,
  };
}

function mkSignals(overrides = {}) {
  return {
    prints: [{ t: NOW - 1 * DAY, cents: 9288, source: "credaily-web" }],
    kalshi: null,
    ...overrides,
  };
}

/** A market series by another creator, open for sale. */
function mkMarket(overrides = {}) {
  return {
    id: 0,
    creator: OTHER,
    strikeLowCents: 9288,
    strikeHighCents: 10088,
    premiumRateBps: 200,
    saleEnd: NOW + 5 * DAY,
    obsStart: NOW + 5 * DAY,
    obsEnd: NOW + 35 * DAY,
    redeemEnd: NOW + 65 * DAY,
    escrowUnits: 4n * UNIT,
    soldUnits: 0n,
    settled: false,
    cancelled: false,
    paused: false,
    residualWithdrawn: false,
    payoutRatioWad: 0n,
    ...overrides,
  };
}

/** An own series (created by the agent). */
function mkOwn(overrides = {}) {
  return mkMarket({ creator: ME, ...overrides });
}

const FRESH_PRINTS = [{ t: NOW - 1 * DAY, cents: 9288 }];
/** Model fair value (bps) of a series under the fresh single print. */
const fairOf = (s) => fairRatioBps(s, { prints: FRESH_PRINTS }, NOW);
/** Standard own-series candidate windows for premium expectations. */
const CANDIDATE = {
  strikeLowCents: 9288,
  strikeHighCents: 10088,
  obsStart: NOW + 14 * DAY,
  obsEnd: NOW + 44 * DAY,
};
const CANDIDATE_FAIR_PREMIUM = fairPremiumBps(CANDIDATE, { prints: FRESH_PRINTS }, NOW);

// ---------------------------------------------------------------------------
// determinism + plan shape
// ---------------------------------------------------------------------------

test("determinism: identical inputs produce a deep-equal plan (incl. buys/inventory)", () => {
  const chain = () =>
    mkChain({
      series: [mkMarket({ premiumRateBps: 100 }), mkOwn({ id: 1, saleEnd: NOW - 1 * DAY, obsStart: NOW - 1 * DAY, obsEnd: NOW - 1, redeemEnd: NOW + 40 * DAY, soldUnits: UNIT / 2n })],
      holdings: [{ seriesId: 0, units: UNIT / 10n }],
    });
  const a = decide(mkSignals(), chain());
  const b = decide(mkSignals(), chain());
  assert.deepStrictEqual(a, b);
  assert.equal(a.refused, false);
});

test("plan carries no sponsor-era fields (fundPool/withdrawExcess machinery is gone)", () => {
  const plan = decide(mkSignals(), mkChain());
  for (const gone of ["targetFreeCapitalWei", "capitalDeltaWei", "pause"]) {
    assert.ok(!(gone in plan), `${gone} must not exist on the Plan`);
  }
  assert.ok(Array.isArray(plan.buys));
  assert.ok(Array.isArray(plan.pauses));
  assert.ok(Array.isArray(plan.withdrawResiduals));
  assert.ok(Array.isArray(plan.cancels));
});

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test("refuses to act when chainState read failed", () => {
  for (const bad of [null, undefined, { ok: false, error: "rpc timeout" }, { ok: "yes" }]) {
    const plan = decide(mkSignals(), bad);
    assert.equal(plan.refused, true);
    assert.equal(plan.newSeries, null);
    assert.deepStrictEqual(plan.buys, []);
    assert.deepStrictEqual(plan.pauses, []);
    assert.deepStrictEqual(plan.withdrawResiduals, []);
    assert.deepStrictEqual(plan.cancels, []);
    assert.equal(plan.inventory, null);
    assert.match(plan.rationale.join(" "), /REFUSE/);
  }
});

test("refuses on invalid nowSec", () => {
  const plan = decide(mkSignals(), mkChain({ nowSec: NaN }));
  assert.equal(plan.refused, true);
});

test("refuses when the agent identity is missing (own-series exclusion would be unsafe)", () => {
  for (const agent of [undefined, {}, { address: "not-an-address", currencyUnits: UNIT }]) {
    const plan = decide(mkSignals(), mkChain({ agent }));
    assert.equal(plan.refused, true);
    assert.match(plan.rationale.join(" "), /agent/i);
  }
});

test("refuses when the agent wallet balance is unreadable", () => {
  const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: "bogus" } }));
  assert.equal(plan.refused, true);
});

// ---------------------------------------------------------------------------
// SELL side: capital clamp (successor of the 0.5-unit per-run capital cap)
// ---------------------------------------------------------------------------

test("per-run sell escrow is clamped to 0.5 currency units", () => {
  const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: 10n * UNIT } }));
  assert.equal(plan.newSeries.capacityUnits, milliunitsToUnits(DEFAULT_CONFIG.MAX_SELL_ESCROW_MILLIUNITS));
  assert.match(plan.rationale.join(" "), /SAFETY CLAMP/);
});

test("below the clamp, capacity = 80% of the wallet", () => {
  const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: UNIT / 2n } }));
  assert.equal(plan.newSeries.capacityUnits, (UNIT / 2n) * 8n / 10n); // 0.4 units
});

test("kalshi vacancy stress halves the deployable sell capital", () => {
  const plan = decide(mkSignals({ kalshi: { probVacancyBelow: 0.2 } }), mkChain());
  assert.equal(plan.newSeries.capacityUnits, (UNIT * 8n * 5n) / 100n); // 0.8 * 0.5 = 0.4 units
  assert.match(plan.rationale.join(" "), /STRESS/);
});

test("kalshi prob above threshold is not stress", () => {
  const plan = decide(mkSignals({ kalshi: { probVacancyBelow: 0.55 } }), mkChain());
  assert.equal(plan.newSeries.capacityUnits, milliunitsToUnits(500)); // clamped healthy 0.5
  assert.match(plan.rationale.join(" "), /no stress/);
});

test("no new series when the wallet cannot fund more than dust", () => {
  const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: 0n } }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /dust/);
});

// ---------------------------------------------------------------------------
// SELL side: premium (fair x 1.25, clamped [500, 5000])
// ---------------------------------------------------------------------------

function printsEvery30d(centsSeq) {
  return centsSeq.map((cents, i) => ({
    t: NOW - (centsSeq.length - i) * 30 * DAY,
    cents,
    source: "credaily-web",
  }));
}

test("own premium = fairPremiumBps (fair x 1.25) when unclamped and unleaned", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(plan.newSeries.premiumRateBps, CANDIDATE_FAIR_PREMIUM);
});

test("premium clamps to the 500 bps floor on near-zero vol history", () => {
  const prints = printsEvery30d([9288, 9289, 9288, 9289, 9288, 9289, 9288]);
  const plan = decide({ prints, kalshi: null }, mkChain());
  assert.notEqual(plan.newSeries, null);
  assert.equal(plan.newSeries.premiumRateBps, DEFAULT_CONFIG.PREMIUM_MIN_BPS);
  assert.match(plan.rationale.join(" "), /CLAMPED/);
});

test("premium clamps to the 5000 bps cap on extreme vol history", () => {
  const prints = printsEvery30d([9288, 6288, 9288, 6288, 9288, 6288, 9288]);
  const plan = decide({ prints, kalshi: null }, mkChain());
  assert.notEqual(plan.newSeries, null);
  assert.equal(plan.newSeries.premiumRateBps, DEFAULT_CONFIG.PREMIUM_MAX_BPS);
});

test("short history falls back to sigma $1.50/SF and yields an in-range premium", () => {
  const plan = decide(mkSignals(), mkChain());
  const p = plan.newSeries.premiumRateBps;
  assert.ok(p >= DEFAULT_CONFIG.PREMIUM_MIN_BPS && p <= DEFAULT_CONFIG.PREMIUM_MAX_BPS);
  assert.match(plan.rationale.join(" "), /fallback/);
});

// ---------------------------------------------------------------------------
// SELL side: series construction rules (all legacy rules kept)
// ---------------------------------------------------------------------------

test("strikes anchor to the latest print: low = round(print), band = +800c", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(plan.newSeries.strikeLowCents, 9288);
  assert.equal(plan.newSeries.strikeHighCents, 9288 + DEFAULT_CONFIG.BAND_CENTS);
});

test("oracle observation outranks an older web print for anchoring", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 1 * DAY, cents: 9400, emailId: "0xabc" }] },
  });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 10 * DAY, cents: 9000 }] }), chain);
  assert.equal(plan.newSeries.strikeLowCents, 9400);
});

test("saleEnd == obsStart; timestamps future, ordered, 7d+ claim window", () => {
  const plan = decide(mkSignals(), mkChain());
  const s = plan.newSeries;
  assert.equal(s.saleEnd, s.obsStart, "production rule saleEnd == obsStart");
  assert.ok(NOW < s.saleEnd && s.obsStart < s.obsEnd && s.obsEnd < s.redeemEnd);
  assert.ok(s.redeemEnd >= s.obsEnd + 7 * DAY, "contract MIN_REDEEM_WINDOW");
  assert.deepStrictEqual(validateSeriesParams(s, NOW), []);
});

test("never more than one series per run (single object, never an array)", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(typeof plan.newSeries, "object");
  assert.ok(!Array.isArray(plan.newSeries));
});

test("stale print (>45d) blocks the new series", () => {
  const plan = decide(mkSignals({ prints: [{ t: NOW - 50 * DAY, cents: 9288 }] }), mkChain());
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /stale/i);
});

test("no new series while an OWN unsettled series is still selling", () => {
  const live = mkOwn({ id: 3, obsStart: NOW + 100 * DAY, obsEnd: NOW + 130 * DAY, redeemEnd: NOW + 160 * DAY });
  const plan = decide(mkSignals(), mkChain({ series: [live] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /unsettled series is still in its sale window/i);
});

test("no new series while ANOTHER OPERATOR WALLET's unsettled series is still selling (one book across wallets)", () => {
  const deployer = DEFAULT_CONFIG.operatorWallets[0];
  const live = mkMarket({ id: 3, creator: deployer, obsStart: NOW + 100 * DAY, obsEnd: NOW + 130 * DAY, redeemEnd: NOW + 160 * DAY });
  const plan = decide(mkSignals(), mkChain({ series: [live] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /one own live sale at a time, across all operator wallets/i);
});

test("obs-window overlap with ANOTHER OPERATOR WALLET's unsettled series blocks creation too", () => {
  const bankr = DEFAULT_CONFIG.operatorWallets[1];
  const own = mkMarket({ id: 3, creator: bankr, saleEnd: NOW - 1 * DAY, obsStart: NOW - 5 * DAY, obsEnd: NOW + 90 * DAY, redeemEnd: NOW + 120 * DAY, soldUnits: UNIT / 10n });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /overlap/i);
});

test("refuses a series whose obs window overlaps an OWN unsettled series", () => {
  // soldUnits > 0: the series cannot be cancelled away — the overlap must block
  const own = mkOwn({ id: 3, saleEnd: NOW - 1 * DAY, obsStart: NOW - 5 * DAY, obsEnd: NOW + 90 * DAY, redeemEnd: NOW + 120 * DAY, soldUnits: UNIT / 10n });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /overlap/i);
  assert.equal(plan.refused, false, "only creation is refused — the rest of the plan stands");
});

test("ANOTHER creator's overlapping obs window does NOT block our series", () => {
  const other = mkMarket({ id: 3, saleEnd: NOW - 1 * DAY, obsStart: NOW - 5 * DAY, obsEnd: NOW + 90 * DAY, premiumRateBps: 5000 });
  const plan = decide(mkSignals(), mkChain({ series: [other] }));
  assert.notEqual(plan.newSeries, null);
});

test("own SETTLED series does not block creation", () => {
  const own = mkOwn({ id: 3, saleEnd: NOW - 1 * DAY, obsStart: NOW - 5 * DAY, obsEnd: NOW + 90 * DAY, settled: true });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.notEqual(plan.newSeries, null);
});

// ---------------------------------------------------------------------------
// web-print plausibility gate + freshness hygiene (legacy, unchanged)
// ---------------------------------------------------------------------------

test("web print within the plausibility band of the oracle may anchor", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 10 * DAY, cents: 9288, emailId: "0xabc" }] },
  });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 9400 }] }), chain);
  assert.equal(plan.newSeries.strikeLowCents, 9400);
});

test("web print outside the plausibility band is rejected — oracle anchors instead", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 10 * DAY, cents: 9288, emailId: "0xabc" }] },
  });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 5000 }] }), chain);
  assert.equal(plan.newSeries.strikeLowCents, 9288);
  assert.match(plan.rationale.join(" "), /PLAUSIBILITY REJECTION/);
});

test("a rejected implausible web print does not reset the freshness clocks", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 70 * DAY, cents: 9288, emailId: "0xabc" }] },
    series: [mkOwn({ id: 0 })],
  });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 5000 }] }), chain);
  assert.equal(plan.newSeries, null);
  assert.deepStrictEqual(plan.pauses, [{ seriesId: 0, paused: true }], "blackout persists — own sales pause");
  assert.deepStrictEqual(plan.buys, [], "and the buy leg is refused");
});

test("unknown-age prints never anchor and never count for freshness", () => {
  const p1 = decide({ prints: [{ t: null, cents: 9288 }], kalshi: null }, mkChain());
  assert.equal(p1.newSeries, null);
  assert.match(p1.rationale.join(" "), /no publish timestamp/i);
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 1 * DAY, cents: 9400, emailId: "0xabc" }] },
  });
  const p2 = decide({ prints: [{ t: null, cents: 9000 }], kalshi: null }, chain);
  assert.equal(p2.newSeries.strikeLowCents, 9400);
});

test("prints timestamped in the future are discarded", () => {
  const plan = decide(
    mkSignals({ prints: [{ t: NOW + 30 * DAY, cents: 12000 }, { t: NOW - 1 * DAY, cents: 9288 }] }),
    mkChain(),
  );
  assert.equal(plan.newSeries.strikeLowCents, 9288);
});

// ---------------------------------------------------------------------------
// BUY side: selection matrix
// ---------------------------------------------------------------------------

test("buys exactly when quotedPremiumBps <= fairRatioBps - EDGE_MIN (300)", () => {
  const fair = fairOf(mkMarket());
  const cheap = decide(mkSignals(), mkChain({ series: [mkMarket({ premiumRateBps: fair - 300 })] }));
  assert.equal(cheap.buys.length, 1);
  assert.equal(cheap.buys[0].seriesId, 0);
  assert.equal(cheap.buys[0].edgeBps, 300);
  assert.equal(cheap.buys[0].fairRatioBps, fair);
  const rich = decide(mkSignals(), mkChain({ series: [mkMarket({ premiumRateBps: fair - 299 })] }));
  assert.deepStrictEqual(rich.buys, []);
  assert.match(rich.rationale.join(" "), /No buys/);
});

test("NEVER buys its own series, however attractive", () => {
  const fair = fairOf(mkMarket());
  const ownCheap = mkOwn({ id: 7, premiumRateBps: 1 }); // absurdly cheap, but ours
  const otherCheap = mkMarket({ id: 8, premiumRateBps: fair - 400 });
  const plan = decide(mkSignals(), mkChain({ series: [ownCheap, otherCheap] }));
  assert.deepStrictEqual(plan.buys.map((b) => b.seriesId), [8]);
  const alone = decide(mkSignals(), mkChain({ series: [ownCheap] }));
  assert.deepStrictEqual(alone.buys, []);
});

test("skips paused, sale-closed, settled and cancelled series", () => {
  const cheap = { premiumRateBps: 100 };
  for (const flags of [
    { paused: true },
    { saleEnd: NOW - 1 },
    { settled: true },
    { cancelled: true },
  ]) {
    const plan = decide(mkSignals(), mkChain({ series: [mkMarket({ ...cheap, ...flags })] }));
    assert.deepStrictEqual(plan.buys, [], JSON.stringify(flags));
  }
});

test("caps binding order: per-series 25% cap binds before the total clamp", () => {
  // capacityLeft 1 unit -> 25% cap = 0.25 < 0.5 total budget
  const plan = decide(
    mkSignals(),
    mkChain({ series: [mkMarket({ premiumRateBps: 100, escrowUnits: UNIT })] }),
  );
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].maxClaimUnits, UNIT / 4n);
});

test("per-run total buy notional is clamped to 0.5 units across buys", () => {
  // two deep series: per-series caps 0.4 each; total = 0.8 > 0.5 budget
  const fair = fairOf(mkMarket());
  const s1 = mkMarket({ id: 1, premiumRateBps: fair - 400, escrowUnits: (16n * UNIT) / 10n });
  const s2 = mkMarket({ id: 2, premiumRateBps: fair - 300, escrowUnits: (16n * UNIT) / 10n });
  const plan = decide(mkSignals(), mkChain({ series: [s2, s1] })); // scan order shuffled
  assert.deepStrictEqual(plan.buys.map((b) => b.seriesId), [1, 2], "higher edge fills first");
  assert.equal(plan.buys[0].maxClaimUnits, (4n * UNIT) / 10n); // full per-series cap
  assert.equal(plan.buys[1].maxClaimUnits, UNIT / 10n); // truncated by the total clamp
  const total = plan.buys.reduce((a, b) => a + b.maxClaimUnits, 0n);
  assert.equal(total, milliunitsToUnits(DEFAULT_CONFIG.MAX_BUY_NOTIONAL_MILLIUNITS));
});

test("once the notional budget is exhausted, later candidates are skipped with a clamp note", () => {
  const s1 = mkMarket({ id: 1, premiumRateBps: 100, escrowUnits: 4n * UNIT }); // cap 1 > 0.5
  const s2 = mkMarket({ id: 2, premiumRateBps: 101, escrowUnits: 4n * UNIT });
  const plan = decide(mkSignals(), mkChain({ series: [s1, s2] }));
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].maxClaimUnits, milliunitsToUnits(500));
  assert.match(plan.rationale.join(" "), /notional budget exhausted/);
});

test("maxPremiumUnits is the exact contract premium: floor(maxClaim x rate / 1e4)", () => {
  const plan = decide(mkSignals(), mkChain({ series: [mkMarket({ premiumRateBps: 157 })] }));
  assert.equal(plan.buys.length, 1);
  const b = plan.buys[0];
  assert.equal(b.maxPremiumUnits, (b.maxClaimUnits * 157n) / 10_000n);
  assert.equal(b.quotedPremiumBps, 157);
});

test("buys are truncated by the wallet premium budget left after the sell escrow", () => {
  // wallet 0.001 unit: sell escrow 0.0008, premium budget 0.0002
  const wallet = UNIT / 1000n;
  const fair = fairOf(mkMarket());
  const rate = fair - 300; // still a real premium
  const plan = decide(
    mkSignals(),
    mkChain({ agent: { address: ME, currencyUnits: wallet }, series: [mkMarket({ premiumRateBps: rate })] }),
  );
  const premiumBudget = wallet - plan.newSeries.capacityUnits;
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].maxClaimUnits, (premiumBudget * 10_000n) / BigInt(rate));
  assert.ok(plan.buys[0].maxPremiumUnits <= premiumBudget);
  assert.match(plan.rationale.join(" "), /truncated by wallet premium budget/);
});

test("REFUSES the whole buy leg when fair-value inputs are stale", () => {
  const staleprints = [{ t: NOW - 50 * DAY, cents: 9288 }];
  const plan = decide(
    mkSignals({ prints: staleprints }),
    mkChain({ series: [mkMarket({ premiumRateBps: 1 })] }), // absurdly cheap — must still refuse
  );
  assert.deepStrictEqual(plan.buys, []);
  assert.match(plan.rationale.join(" "), /BUY LEG REFUSED/);
});

test("REFUSES the whole buy leg when no print exists at all", () => {
  const plan = decide({ prints: [], kalshi: null }, mkChain({ series: [mkMarket({ premiumRateBps: 1 })] }));
  assert.deepStrictEqual(plan.buys, []);
  assert.match(plan.rationale.join(" "), /BUY LEG REFUSED/);
});

// ---------------------------------------------------------------------------
// inventory + lean transitions (deterministic)
// ---------------------------------------------------------------------------

/** Own matured-obs unsettled deep-ITM series: SOLD units = short exposure. */
function mkOwnShortBook({ escrowUnits, soldUnits }) {
  return mkOwn({
    id: 9,
    strikeLowCents: 8000,
    strikeHighCents: 8800, // print 9288 >= high => fair ratio 10000 bps at horizon 0
    saleEnd: NOW - 40 * DAY,
    obsStart: NOW - 40 * DAY,
    obsEnd: NOW - 10 * DAY, // obs over, awaiting settlement — no window overlap
    redeemEnd: NOW + 20 * DAY,
    escrowUnits,
    soldUnits,
  });
}

test("balanced book: no lean, base edge threshold", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(plan.inventory.lean, "balanced");
  assert.equal(plan.inventory.premiumLeanBps, 0);
  assert.equal(plan.inventory.edgeMinBps, DEFAULT_CONFIG.EDGE_MIN_BPS);
  assert.equal(plan.inventory.netExposureUnits, 0n);
});

test("exposure inside the band stays balanced (sold-based)", () => {
  // SOLD 0.05 x ratio 1.0 = 0.05 units < 0.1 band — the 0.5 units of unsold
  // escrow are uncommitted (cancellable), NOT short exposure
  const own = mkOwnShortBook({ escrowUnits: (55n * UNIT) / 100n, soldUnits: UNIT / 20n });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.equal(plan.inventory.netExposureUnits, UNIT / 20n);
  assert.equal(plan.inventory.lean, "balanced");
});

test("unsold capacity is NOT short: a fully-unsold deep-ITM book stays balanced", () => {
  // escrow 1 unit, sold 0: the old unsold-based metric read this as 1 unit
  // short (and priced the next series UP — counterproductive); sold-based = 0.
  const own = mkOwnShortBook({ escrowUnits: UNIT, soldUnits: 0n });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.equal(plan.inventory.netExposureUnits, 0n);
  assert.equal(plan.inventory.lean, "balanced");
});

test("net SHORT: premium up one step, buy edge relaxed one step", () => {
  // SOLD 0.5 x ratio 1.0 = 0.5 units > 0.1 band
  const own = mkOwnShortBook({ escrowUnits: UNIT, soldUnits: UNIT / 2n });
  const plan = decide(mkSignals(), mkChain({ series: [own] }));
  assert.equal(plan.inventory.netExposureUnits, UNIT / 2n);
  assert.equal(plan.inventory.lean, "short");
  assert.equal(plan.inventory.edgeMinBps, DEFAULT_CONFIG.EDGE_MIN_BPS - DEFAULT_CONFIG.LEAN_EDGE_STEP_BPS);
  assert.notEqual(plan.newSeries, null, "own sale ended + obs over: a new series is allowed");
  assert.equal(plan.newSeries.premiumRateBps, CANDIDATE_FAIR_PREMIUM + DEFAULT_CONFIG.LEAN_PREMIUM_STEP_BPS);
});

test("net SHORT relaxes the buy edge: a 250-bps edge is bought short, not balanced", () => {
  const fair = fairOf(mkMarket());
  const nearMiss = mkMarket({ id: 4, premiumRateBps: fair - 250 });
  const balanced = decide(mkSignals(), mkChain({ series: [nearMiss] }));
  assert.deepStrictEqual(balanced.buys, [], "250 < 300 — no buy when balanced");
  const own = mkOwnShortBook({ escrowUnits: UNIT, soldUnits: UNIT / 2n });
  const short = decide(mkSignals(), mkChain({ series: [nearMiss, own] }));
  assert.deepStrictEqual(short.buys.map((b) => b.seriesId), [4], "250 >= 200 under the short lean");
});

test("net LONG: buy edge tightened one step, next series cheapened one step", () => {
  // hold 1 unit of a settled full-payout series: exposure -1 unit
  const settled = mkMarket({ id: 5, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 10 * DAY });
  const chain = mkChain({ series: [settled], holdings: [{ seriesId: 5, units: UNIT }] });
  const plan = decide(mkSignals(), chain);
  assert.equal(plan.inventory.netExposureUnits, -UNIT);
  assert.equal(plan.inventory.lean, "long");
  assert.equal(plan.inventory.edgeMinBps, DEFAULT_CONFIG.EDGE_MIN_BPS + DEFAULT_CONFIG.LEAN_EDGE_STEP_BPS);
  assert.equal(plan.newSeries.premiumRateBps, CANDIDATE_FAIR_PREMIUM - DEFAULT_CONFIG.LEAN_PREMIUM_STEP_BPS);
});

test("net LONG tightens the buy edge: a 350-bps edge is bought balanced, not long", () => {
  const fair = fairOf(mkMarket());
  const decent = mkMarket({ id: 4, premiumRateBps: fair - 350 });
  const balanced = decide(mkSignals(), mkChain({ series: [decent] }));
  assert.deepStrictEqual(balanced.buys.map((b) => b.seriesId), [4]);
  const settled = mkMarket({ id: 5, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 10 * DAY });
  const long = decide(
    mkSignals(),
    mkChain({ series: [decent, settled], holdings: [{ seriesId: 5, units: UNIT }] }),
  );
  assert.deepStrictEqual(long.buys, [], "350 < 400 under the long lean");
});

// ---------------------------------------------------------------------------
// own-series pauses (blackout rule; per-series, no global pause exists)
// ---------------------------------------------------------------------------

test("data blackout pauses OWN open series only", () => {
  const chain = mkChain({ series: [mkOwn({ id: 0 }), mkMarket({ id: 1 })] });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }), chain);
  assert.deepStrictEqual(plan.pauses, [{ seriesId: 0, paused: true }]);
  assert.equal(plan.newSeries, null);
});

test("blackout with own series already paused emits no redundant pause", () => {
  const chain = mkChain({ series: [mkOwn({ id: 0, paused: true })] });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }), chain);
  assert.deepStrictEqual(plan.pauses, []);
});

test("healthy data NEVER auto-unpauses by default — a manual pause is respected", () => {
  const plan = decide(mkSignals(), mkChain({ series: [mkOwn({ id: 0, paused: true })] }));
  assert.deepStrictEqual(plan.pauses, []);
  assert.match(plan.rationale.join(" "), /allowUnpause/);
});

test("allowUnpause=true opt-in lets healthy data unpause own series (never in blackout)", () => {
  const plan = decide(mkSignals(), mkChain({ series: [mkOwn({ id: 0, paused: true })] }), {
    allowUnpause: true,
  });
  assert.deepStrictEqual(plan.pauses, [{ seriesId: 0, paused: false }]);
  const blackout = decide(
    mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }),
    mkChain({ series: [mkOwn({ id: 0, paused: true })] }),
    { allowUnpause: true },
  );
  assert.deepStrictEqual(blackout.pauses, []);
});

// ---------------------------------------------------------------------------
// own residual withdrawals + cancels
// ---------------------------------------------------------------------------

test("withdrawResiduals lists own matured series only", () => {
  const matured = mkOwn({ id: 1, saleEnd: NOW - 90 * DAY, obsStart: NOW - 90 * DAY, obsEnd: NOW - 60 * DAY, redeemEnd: NOW - 1, settled: true, soldUnits: UNIT / 2n });
  const maturedUnsettled = mkOwn({ id: 2, saleEnd: NOW - 90 * DAY, obsStart: NOW - 90 * DAY, obsEnd: NOW - 60 * DAY, redeemEnd: NOW - 1, soldUnits: UNIT / 2n });
  const alreadyTaken = mkOwn({ id: 3, redeemEnd: NOW - 1, residualWithdrawn: true });
  const notOurs = mkMarket({ id: 4, redeemEnd: NOW - 1 });
  const open = mkOwn({ id: 5 });
  const plan = decide(
    mkSignals(),
    mkChain({ series: [matured, maturedUnsettled, alreadyTaken, notOurs, open] }),
  );
  assert.deepStrictEqual(plan.withdrawResiduals, [1, 2]);
});

test("cancels own UNSOLD series whose sale ended (dead escrow)", () => {
  const deadUnsold = mkOwn({ id: 1, saleEnd: NOW - 1 * DAY, obsStart: NOW - 1 * DAY, obsEnd: NOW + 29 * DAY, redeemEnd: NOW + 59 * DAY });
  const soldOne = mkOwn({ id: 2, saleEnd: NOW - 1 * DAY, obsStart: NOW - 1 * DAY, obsEnd: NOW + 29 * DAY, redeemEnd: NOW + 59 * DAY, soldUnits: 1n });
  const notOurs = mkMarket({ id: 3, saleEnd: NOW - 1 * DAY });
  const plan = decide(mkSignals(), mkChain({ series: [deadUnsold, soldOne, notOurs] }));
  assert.deepStrictEqual(plan.cancels, [1], "sold or foreign series are never cancelled");
});

test("cancels own unsold series when a FRESH print drifted a band away from its strikes", () => {
  const drifted = mkOwn({ id: 1, strikeLowCents: 8000, strikeHighCents: 8800 }); // print 9288 => drift 1288 >= 800
  const plan = decide(mkSignals(), mkChain({ series: [drifted] }));
  assert.deepStrictEqual(plan.cancels, [1]);
  assert.match(plan.rationale.join(" "), /stale shape/);
});

test("no drift cancel on stale data (the drift judgment needs a fresh print)", () => {
  const drifted = mkOwn({ id: 1, strikeLowCents: 8000, strikeHighCents: 8800 });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 50 * DAY, cents: 9288 }] }), mkChain({ series: [drifted] }));
  assert.deepStrictEqual(plan.cancels, []);
});

test("a matured unsold series exits via withdrawResidual, never both exits", () => {
  const maturedUnsold = mkOwn({ id: 1, saleEnd: NOW - 90 * DAY, obsStart: NOW - 90 * DAY, obsEnd: NOW - 60 * DAY, redeemEnd: NOW - 1 });
  const plan = decide(mkSignals(), mkChain({ series: [maturedUnsold] }));
  assert.deepStrictEqual(plan.withdrawResiduals, [1]);
  assert.deepStrictEqual(plan.cancels, [], "cancel and withdrawResidual share a one-shot latch on-chain");
});

test("a series cancelled this run frees the sell side (no phantom overlap block)", () => {
  // own unsold series with an overlapping obs window gets cancelled for drift —
  // the replacement series may be created in the same run
  const drifted = mkOwn({ id: 1, strikeLowCents: 8000, strikeHighCents: 8800, saleEnd: NOW + 5 * DAY, obsStart: NOW + 5 * DAY, obsEnd: NOW + 35 * DAY });
  const plan = decide(mkSignals(), mkChain({ series: [drifted] }));
  assert.deepStrictEqual(plan.cancels, [1]);
  assert.notEqual(plan.newSeries, null);
});

// ---------------------------------------------------------------------------
// decimals parameterization (18-dec WXDAI vs 6-dec USDC) — same economics
// ---------------------------------------------------------------------------

for (const [decimals, label] of [[18, "WXDAI/Gnosis"], [6, "USDC/Arbitrum"]]) {
  const cfg = { decimals };
  const U = 10n ** BigInt(decimals);

  test(`[${label}] unit helpers scale with decimals`, () => {
    assert.equal(unitScale(cfg), U);
    assert.equal(milliunitsToUnits(500, cfg), U / 2n);
    assert.equal(dustUnits(cfg), U / 100_000n > 0n ? U / 100_000n : 1n);
  });

  test(`[${label}] sell escrow clamps to 0.5 currency units`, () => {
    const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: 10n * U } }), cfg);
    assert.equal(plan.newSeries.capacityUnits, U / 2n);
  });

  test(`[${label}] buy notional clamps to 0.5 currency units`, () => {
    const series = mkMarket({ premiumRateBps: 100, escrowUnits: 4n * U });
    const plan = decide(
      mkSignals(),
      mkChain({ agent: { address: ME, currencyUnits: 10n * U }, series: [series] }),
      cfg,
    );
    assert.equal(plan.buys.length, 1);
    assert.equal(plan.buys[0].maxClaimUnits, U / 2n);
    assert.equal(plan.buys[0].maxPremiumUnits, (U / 2n) * 100n / 10_000n);
  });

  test(`[${label}] dust threshold scales: a sub-dust wallet creates nothing`, () => {
    const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: dustUnits(cfg) } }), cfg);
    // 80% of dust is below dust — no series
    assert.equal(plan.newSeries, null);
  });
}

test("[USDC/Arbitrum] a buy whose premium would round to zero is skipped (PremiumRoundsToZero)", () => {
  const cfg = { decimals: 6 };
  const U = 10n ** 6n;
  // capacityLeft 4000 base units -> 25% cap = 1000; rate 1 bps -> premium 0
  const tiny = mkMarket({ premiumRateBps: 1, escrowUnits: 4000n });
  const plan = decide(mkSignals(), mkChain({ agent: { address: ME, currencyUnits: 2n * U }, series: [tiny] }), cfg);
  assert.deepStrictEqual(plan.buys, []);
  assert.match(plan.rationale.join(" "), /rounds to zero/);
});

// ---------------------------------------------------------------------------
// REDEEM side — profit realization (settled holdings before redeemEnd)
// ---------------------------------------------------------------------------

test("redeems every settled holding with a positive ratio before redeemEnd (units × ratio realized)", () => {
  const settled = mkMarket({ id: 5, settled: true, payoutRatioWad: 10n ** 18n / 2n, saleEnd: NOW - 10 * DAY, redeemEnd: NOW + 5 * DAY });
  const plan = decide(mkSignals(), mkChain({ series: [settled], holdings: [{ seriesId: 5, units: UNIT / 5n }] }));
  assert.deepStrictEqual(plan.redeems, [{ seriesId: 5, units: UNIT / 5n }]);
  assert.match(plan.rationale.join(" "), /REDEEM series 5/);
});

test("redeem leg survives data staleness/blackout (a settled payout needs no valuation)", () => {
  const settled = mkMarket({ id: 5, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 10 * DAY, redeemEnd: NOW + 5 * DAY });
  const plan = decide(
    mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }),
    mkChain({ series: [settled], holdings: [{ seriesId: 5, units: UNIT / 5n }] }),
  );
  assert.equal(plan.newSeries, null, "blackout kills the sell side");
  assert.deepStrictEqual(plan.buys, [], "blackout kills the buy side");
  assert.deepStrictEqual(plan.redeems, [{ seriesId: 5, units: UNIT / 5n }], "but never the redeem side");
});

test("no redeem after redeemEnd (realized loss), at ratio 0, or on unsettled/cancelled series", () => {
  const expired = mkMarket({ id: 1, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 90 * DAY, redeemEnd: NOW - 1 });
  const zeroRatio = mkMarket({ id: 2, settled: true, payoutRatioWad: 0n, saleEnd: NOW - 10 * DAY, redeemEnd: NOW + 5 * DAY });
  const unsettled = mkMarket({ id: 3, premiumRateBps: 5000 });
  const cancelled = mkMarket({ id: 6, settled: true, cancelled: true, payoutRatioWad: 10n ** 18n });
  const plan = decide(
    mkSignals(),
    mkChain({
      series: [expired, zeroRatio, unsettled, cancelled],
      holdings: [
        { seriesId: 1, units: UNIT },
        { seriesId: 2, units: UNIT },
        { seriesId: 3, units: UNIT / 10n },
        { seriesId: 6, units: UNIT / 10n },
      ],
    }),
  );
  assert.deepStrictEqual(plan.redeems, []);
  assert.match(plan.rationale.join(" "), /REALIZED LOSS/);
  assert.match(plan.rationale.join(" "), /settled at ratio 0/);
});

// ---------------------------------------------------------------------------
// operator-wallet self-dealing exclusion (deployer + Bankr = ONE book)
// ---------------------------------------------------------------------------

test("NEVER buys ANY operator wallet's series — cross-wallet self-dealing exclusion, with rationale", () => {
  const [deployer, bankr] = DEFAULT_CONFIG.operatorWallets;
  const fair = fairOf(mkMarket());
  const cheapDeployer = mkMarket({ id: 7, creator: deployer, premiumRateBps: 1 });
  const cheapBankr = mkMarket({ id: 8, creator: bankr.toUpperCase().replace("0X", "0x"), premiumRateBps: 1 }); // case-insensitive
  const otherCheap = mkMarket({ id: 9, premiumRateBps: fair - 400 });
  const plan = decide(mkSignals(), mkChain({ series: [cheapDeployer, cheapBankr, otherCheap] }));
  assert.deepStrictEqual(plan.buys.map((b) => b.seriesId), [9], "only the true third-party series is buyable");
  assert.match(plan.rationale.join(" "), /OPERATOR-WALLET EXCLUSION/);
  const alone = decide(mkSignals(), mkChain({ series: [cheapDeployer, cheapBankr] }));
  assert.deepStrictEqual(alone.buys, []);
});

// ---------------------------------------------------------------------------
// buy-side idempotence — holdings count against the per-series cap
// ---------------------------------------------------------------------------

test("skips a series already held at/above its per-series cap; sizes net of holdings below it", () => {
  const s = mkMarket({ id: 4, premiumRateBps: 100, escrowUnits: UNIT }); // capLeft 1 => cap 0.25
  const atCap = decide(mkSignals(), mkChain({ series: [s], holdings: [{ seriesId: 4, units: UNIT / 4n }] }));
  assert.deepStrictEqual(atCap.buys, []);
  assert.match(atCap.rationale.join(" "), /already hold .* per-series cap/);
  const below = decide(mkSignals(), mkChain({ series: [s], holdings: [{ seriesId: 4, units: UNIT / 8n }] }));
  assert.equal(below.buys.length, 1);
  assert.equal(below.buys[0].maxClaimUnits, UNIT / 4n - UNIT / 8n, "cap headroom only — never stack past the cap");
  assert.match(below.rationale.join(" "), /net of .* already held/);
});

// ---------------------------------------------------------------------------
// inventory integrity — expiry zeroing + purchased-vs-gifted
// ---------------------------------------------------------------------------

test("held cover valued 0 past redeemEnd and 0 for unsettled series past obsEnd with no qualifying observation", () => {
  const expired = mkMarket({ id: 1, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 90 * DAY, redeemEnd: NOW - 1 });
  const deadObs = mkMarket({
    id: 2,
    strikeLowCents: 8000,
    strikeHighCents: 8800, // print 9288 >= high => deep ITM if it could still settle
    saleEnd: NOW - 40 * DAY,
    obsStart: NOW - 40 * DAY,
    obsEnd: NOW - 1 * DAY,
    redeemEnd: NOW + 29 * DAY,
  });
  const plan = decide(
    mkSignals(),
    mkChain({ series: [expired, deadObs], holdings: [{ seriesId: 1, units: UNIT }, { seriesId: 2, units: UNIT }] }),
  );
  assert.equal(plan.inventory.netExposureUnits, 0n, "phantom exposure must not accumulate");
  assert.equal(plan.inventory.lean, "balanced");
  assert.match(plan.rationale.join(" "), /valued 0 — redeem window closed/);
  assert.match(plan.rationale.join(" "), /no qualifying oracle observation/);
  // a qualifying observation inside the window keeps the unsettled holding valued
  const withObs = decide(
    mkSignals(),
    mkChain({
      series: [deadObs],
      holdings: [{ seriesId: 2, units: UNIT }],
      oracle: { count: 1, observations: [{ t: NOW - 20 * DAY, cents: 9288, emailId: "0xabc" }] },
    }),
  );
  assert.equal(withObs.inventory.netExposureUnits, -UNIT, "deep ITM, still settleable — full value");
  assert.equal(withObs.inventory.lean, "long");
});

test("outsider-GIFTED cover is excluded from the lean (purchased ledger) and reported; purchased cover counts", () => {
  const settled = mkMarket({ id: 5, settled: true, payoutRatioWad: 10n ** 18n, saleEnd: NOW - 10 * DAY });
  const mk = (purchasedUnits) =>
    mkChain({ series: [settled], holdings: [{ seriesId: 5, units: UNIT }], purchasedUnits });
  const gifted = decide(mkSignals(), mk({}));
  assert.equal(gifted.inventory.netExposureUnits, 0n, "an attacker's gift must not flip the lean long");
  assert.equal(gifted.inventory.lean, "balanced");
  assert.match(gifted.rationale.join(" "), /GIFTED COVER/);
  const bought = decide(mkSignals(), mk({ 5: UNIT.toString() }));
  assert.equal(bought.inventory.netExposureUnits, -UNIT);
  assert.equal(bought.inventory.lean, "long");
  const half = decide(mkSignals(), mk({ 5: (UNIT / 2n).toString() }));
  assert.equal(half.inventory.netExposureUnits, -(UNIT / 2n), "only the purchased fraction counts");
  // no ledger at all (tests/proofs): all holdings count — back-compat
  const noLedger = decide(mkSignals(), mkChain({ series: [settled], holdings: [{ seriesId: 5, units: UNIT }] }));
  assert.equal(noLedger.inventory.netExposureUnits, -UNIT);
});

test("sell-side exposure uses SOLD × settled ratio − paidOut for settled own series, extinguished past redeemEnd", () => {
  const settledOwn = mkOwn({
    id: 3,
    settled: true,
    payoutRatioWad: 10n ** 18n,
    saleEnd: NOW - 40 * DAY,
    obsStart: NOW - 40 * DAY,
    obsEnd: NOW - 10 * DAY,
    redeemEnd: NOW + 20 * DAY,
    escrowUnits: UNIT,
    soldUnits: UNIT / 2n,
    paidOutUnits: UNIT / 4n,
  });
  const plan = decide(mkSignals(), mkChain({ series: [settledOwn] }));
  assert.equal(plan.inventory.netExposureUnits, UNIT / 4n, "sold × ratio − paidOut");
  const past = decide(mkSignals(), mkChain({ series: [{ ...settledOwn, redeemEnd: NOW - 1 }] }));
  assert.equal(past.inventory.netExposureUnits, 0n, "liability extinguished at redeemEnd");
});

// ---------------------------------------------------------------------------
// plan stamp — {chainId, pool, decidedAtBlock, wallet}
// ---------------------------------------------------------------------------

test("plan carries the target stamp when chain state names the chain and pool", () => {
  const POOL = "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3";
  const plan = decide(mkSignals(), mkChain({ chainId: 100, pool: POOL, blockNumber: 12_345n }));
  assert.deepStrictEqual(plan.target, { chainId: 100, pool: POOL, decidedAtBlock: 12_345, wallet: ME });
  assert.equal(decide(mkSignals(), mkChain()).target, null, "fixtures without chainId/pool stay unstamped");
  const refused = decide(mkSignals(), { ok: false, error: "x" });
  assert.equal(refused.target, null);
  assert.deepStrictEqual(refused.redeems, []);
});

// ---------------------------------------------------------------------------
// validateSeriesParams direct
// ---------------------------------------------------------------------------

test("validateSeriesParams flags every violation", () => {
  const good = {
    strikeLowCents: 9288,
    strikeHighCents: 10088,
    premiumRateBps: 1200,
    saleEnd: NOW + 14 * DAY,
    obsStart: NOW + 14 * DAY,
    obsEnd: NOW + 44 * DAY,
    redeemEnd: NOW + 74 * DAY,
    capacityUnits: UNIT,
  };
  assert.deepStrictEqual(validateSeriesParams(good, NOW), []);

  const cases = [
    [{ saleEnd: NOW + 20 * DAY }, /saleEnd must be <= obsStart/],
    [{ obsEnd: NOW + 10 * DAY }, /obsStart must be < obsEnd/],
    [{ redeemEnd: NOW + 44 * DAY }, /obsEnd must be < redeemEnd/],
    [{ redeemEnd: NOW + 44 * DAY + 3 * DAY }, /MIN_REDEEM_WINDOW/],
    [{ saleEnd: NOW - 1 }, /future/],
    [{ premiumRateBps: 499 }, /premiumRateBps/],
    [{ premiumRateBps: 5001 }, /premiumRateBps/],
    [{ strikeLowCents: 10088 }, /strikeLowCents must be < strikeHighCents/],
    [{ capacityUnits: 0n }, /capacityUnits/],
    [{ capacityUnits: 2n ** 128n }, /capacityUnits/],
    [{ capacityUnits: 1 }, /capacityUnits/], // must be a bigint
  ];
  for (const [patch, re] of cases) {
    const errs = validateSeriesParams({ ...good, ...patch }, NOW);
    assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
  }
});
