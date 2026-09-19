/**
 * decide.test.mjs — unit tests for the deterministic policy core (node --test).
 * Covers: every safety clamp, determinism, stale-data downscale, blackout
 * pause, window-overlap refusal, chain-read refusal, timestamp ordering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decide,
  DEFAULT_CONFIG,
  expectedClaimBps,
  estimateMonthlySigmaCents,
  validateSeriesParams,
} from "./decide.mjs";

const DAY = 86_400;
const NOW = 1_790_000_000; // fixed clock — decide() must take time from chainState only
const WXDAI = 10n ** 18n;

function mkChain(overrides = {}) {
  return {
    ok: true,
    nowSec: NOW,
    salesPaused: false,
    freeCapitalWei: 0n,
    totalReservedWei: 0n,
    poolBalanceWei: 0n,
    sponsorWxdaiWei: WXDAI, // 1 WXDAI
    sponsorXdaiWei: 10n ** 15n,
    seriesCount: 0,
    series: [],
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

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test("determinism: identical inputs produce a deep-equal plan (incl. newSeries)", () => {
  const a = decide(mkSignals(), mkChain());
  const b = decide(mkSignals(), mkChain());
  assert.deepStrictEqual(a, b);
  assert.equal(a.refused, false);
  assert.notEqual(a.newSeries, null, "healthy fresh-print state should propose a series");
});

// ---------------------------------------------------------------------------
// refuse on failed chain read
// ---------------------------------------------------------------------------

test("refuses to act when chainState read failed", () => {
  for (const bad of [null, undefined, { ok: false, error: "rpc timeout" }, { ok: "yes" }]) {
    const plan = decide(mkSignals(), bad);
    assert.equal(plan.refused, true);
    assert.equal(plan.targetFreeCapitalWei, null);
    assert.equal(plan.capitalDeltaWei, null);
    assert.equal(plan.newSeries, null);
    assert.equal(plan.pause, null);
    assert.match(plan.rationale.join(" "), /REFUSE/);
  }
});

test("refuses on invalid nowSec", () => {
  const plan = decide(mkSignals(), mkChain({ nowSec: NaN }));
  assert.equal(plan.refused, true);
});

// ---------------------------------------------------------------------------
// capital clamps
// ---------------------------------------------------------------------------

test("per-run fund delta is clamped to +0.5 WXDAI", () => {
  // sponsor holds 10 WXDAI, pool free 0 => raw target 8 WXDAI, delta clamped
  const plan = decide(mkSignals(), mkChain({ sponsorWxdaiWei: 10n * WXDAI }));
  assert.equal(plan.capitalDeltaWei, DEFAULT_CONFIG.MAX_CAPITAL_DELTA_WEI);
  assert.equal(plan.targetFreeCapitalWei, DEFAULT_CONFIG.MAX_CAPITAL_DELTA_WEI);
  assert.match(plan.rationale.join(" "), /SAFETY CLAMP/);
});

test("per-run withdraw delta is clamped to -0.5 WXDAI", () => {
  // pool free 10 WXDAI, sponsor 0 => raw target 8 WXDAI, delta -2 clamped to -0.5
  const plan = decide(
    mkSignals(),
    mkChain({ freeCapitalWei: 10n * WXDAI, poolBalanceWei: 10n * WXDAI, sponsorWxdaiWei: 0n }),
  );
  assert.equal(plan.capitalDeltaWei, -DEFAULT_CONFIG.MAX_CAPITAL_DELTA_WEI);
  assert.equal(plan.targetFreeCapitalWei, 10n * WXDAI - DEFAULT_CONFIG.MAX_CAPITAL_DELTA_WEI);
});

test("dust capital delta is zeroed (MIN_ACTION_DELTA_WEI)", () => {
  // craft free/sponsor so raw delta = 5e10 wei (< 1e13 dust threshold)
  const free = 10n ** 18n;
  const sponsor = 250_000_062_500_000_000n; // 0.8*(free+sponsor) - free = 5e10
  const plan = decide(mkSignals(), mkChain({ freeCapitalWei: free, sponsorWxdaiWei: sponsor }));
  assert.equal(plan.capitalDeltaWei, 0n);
  assert.equal(plan.targetFreeCapitalWei, free);
  assert.match(plan.rationale.join(" "), /dust/);
});

test("withdraw can never exceed current free capital", () => {
  // free tiny, sponsor 0, stale data => target scaled down, delta negative but >= -free
  const plan = decide(
    mkSignals({ prints: [{ t: NOW - 50 * DAY, cents: 9288 }] }),
    mkChain({ freeCapitalWei: 1_000n, sponsorWxdaiWei: 0n }),
  );
  assert.ok(plan.capitalDeltaWei >= -1_000n);
  assert.ok(plan.targetFreeCapitalWei >= 0n);
});

// ---------------------------------------------------------------------------
// stale-data downscale + kalshi stress
// ---------------------------------------------------------------------------

test("stale print (>45d) halves the deploy target and blocks new series", () => {
  const fresh = decide(mkSignals(), mkChain());
  const stale = decide(mkSignals({ prints: [{ t: NOW - 50 * DAY, cents: 9288 }] }), mkChain());
  // sponsor 1 WXDAI, free 0: fresh raw target 0.8 => clamped delta 0.5; stale raw 0.4 (< clamp)
  assert.equal(fresh.targetFreeCapitalWei, 500_000_000_000_000_000n);
  assert.equal(stale.targetFreeCapitalWei, 400_000_000_000_000_000n);
  assert.equal(stale.newSeries, null);
  assert.match(stale.rationale.join(" "), /stale/i);
  assert.equal(stale.pause, null, "stale is not blackout — no pause");
});

test("kalshi vacancy stress halves the deploy target; combined with stale it quarters", () => {
  const stress = decide(mkSignals({ kalshi: { probVacancyBelow: 0.2 } }), mkChain());
  assert.equal(stress.targetFreeCapitalWei, 400_000_000_000_000_000n); // 0.8 * 0.5
  const both = decide(
    mkSignals({ prints: [{ t: NOW - 50 * DAY, cents: 9288 }], kalshi: { probVacancyBelow: 0.2 } }),
    mkChain(),
  );
  assert.equal(both.targetFreeCapitalWei, 200_000_000_000_000_000n); // 0.8 * 0.25
});

test("kalshi prob above threshold is not stress", () => {
  const plan = decide(mkSignals({ kalshi: { probVacancyBelow: 0.55 } }), mkChain());
  assert.equal(plan.targetFreeCapitalWei, 500_000_000_000_000_000n); // clamped healthy target
  assert.match(plan.rationale.join(" "), /no stress/);
});

// ---------------------------------------------------------------------------
// blackout pause
// ---------------------------------------------------------------------------

test("data blackout (>60d) pauses sales and creates no series", () => {
  const plan = decide(mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }), mkChain());
  assert.equal(plan.pause, true);
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /blackout/i);
});

test("no prints at all counts as blackout", () => {
  const plan = decide({ prints: [], kalshi: null }, mkChain());
  assert.equal(plan.pause, true);
  assert.equal(plan.newSeries, null);
});

test("blackout with sales already paused leaves pause=null (no redundant tx)", () => {
  const plan = decide(
    mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }),
    mkChain({ salesPaused: true }),
  );
  assert.equal(plan.pause, null);
});

test("healthy data NEVER auto-unpauses by default — a manual sponsor pause is respected", () => {
  const plan = decide(mkSignals(), mkChain({ salesPaused: true }));
  assert.equal(plan.pause, null);
  assert.equal(plan.newSeries, null, "sales stay paused, so no new series either");
  assert.match(plan.rationale.join(" "), /allowUnpause/);
});

test("allowUnpause=true opt-in lets healthy data unpause", () => {
  const plan = decide(mkSignals(), mkChain({ salesPaused: true }), { allowUnpause: true });
  assert.equal(plan.pause, false);
  // and it still never unpauses during a blackout
  const blackout = decide(
    mkSignals({ prints: [{ t: NOW - 70 * DAY, cents: 9288 }] }),
    mkChain({ salesPaused: true }),
    { allowUnpause: true },
  );
  assert.equal(blackout.pause, null);
});

// ---------------------------------------------------------------------------
// premium clamps
// ---------------------------------------------------------------------------

function printsEvery30d(centsSeq) {
  return centsSeq.map((cents, i) => ({
    t: NOW - (centsSeq.length - i) * 30 * DAY,
    cents,
    source: "credaily-web",
  }));
}

test("premium clamps to the 500 bps floor on near-zero vol history", () => {
  // alternating +-1 cent => tiny historical sigma => expected claim ~0 bps
  const prints = printsEvery30d([9288, 9289, 9288, 9289, 9288, 9289, 9288]);
  const plan = decide({ prints, kalshi: null }, mkChain());
  assert.notEqual(plan.newSeries, null);
  assert.equal(plan.newSeries.premiumRateBps, DEFAULT_CONFIG.PREMIUM_MIN_BPS);
  assert.match(plan.rationale.join(" "), /CLAMPED/);
});

test("premium clamps to the 5000 bps cap on extreme vol history", () => {
  // +-3000 cent swings every 30d => sigma ~3273c => expected claim ~4600 bps * 1.25 > cap
  const prints = printsEvery30d([9288, 6288, 9288, 6288, 9288, 6288, 9288]);
  const plan = decide({ prints, kalshi: null }, mkChain());
  assert.notEqual(plan.newSeries, null);
  assert.equal(plan.newSeries.premiumRateBps, DEFAULT_CONFIG.PREMIUM_MAX_BPS);
});

test("short history falls back to sigma $1.50/SF and yields an in-range premium", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.notEqual(plan.newSeries, null);
  const p = plan.newSeries.premiumRateBps;
  assert.ok(p >= DEFAULT_CONFIG.PREMIUM_MIN_BPS && p <= DEFAULT_CONFIG.PREMIUM_MAX_BPS);
  assert.match(plan.rationale.join(" "), /fallback/);
});

// ---------------------------------------------------------------------------
// series construction rules
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

// ---------------------------------------------------------------------------
// web-print plausibility gate (vs the DKIM-verified oracle)
// ---------------------------------------------------------------------------

test("web print within the plausibility band of the oracle may anchor", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 10 * DAY, cents: 9288, emailId: "0xabc" }] },
  });
  // 9400 vs 9288 = 1.2% divergence — inside the ±15% band, newest print anchors
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 9400 }] }), chain);
  assert.equal(plan.newSeries.strikeLowCents, 9400);
});

test("web print outside the plausibility band is rejected — oracle print anchors instead", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 10 * DAY, cents: 9288, emailId: "0xabc" }] },
  });
  // 5000 vs 9288 = 46% divergence — a poisoned/mis-contexted page must not set strikes
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 5000 }] }), chain);
  assert.equal(plan.newSeries.strikeLowCents, 9288, "falls back to the DKIM-verified oracle print");
  assert.match(plan.rationale.join(" "), /PLAUSIBILITY REJECTION/);
});

test("a rejected implausible web print does not reset the freshness clocks", () => {
  const chain = mkChain({
    oracle: { count: 1, observations: [{ t: NOW - 70 * DAY, cents: 9288, emailId: "0xabc" }] },
  });
  const plan = decide(mkSignals({ prints: [{ t: NOW - 1 * DAY, cents: 5000 }] }), chain);
  assert.equal(plan.pause, true, "blackout persists — the poisoned print must not keep sales open");
  assert.equal(plan.newSeries, null);
});

// ---------------------------------------------------------------------------
// unknown-age prints (asOf/t null — e.g. credaily page missing published_time)
// ---------------------------------------------------------------------------

test("unknown-age prints are treated as stale: they never anchor and never count for freshness", () => {
  // only an unknown-age print -> no timestamped print at all -> blackout path
  const p1 = decide({ prints: [{ t: null, cents: 9288 }], kalshi: null }, mkChain());
  assert.equal(p1.newSeries, null);
  assert.equal(p1.pause, true);
  assert.match(p1.rationale.join(" "), /no publish timestamp/i);
  // a fresh oracle print anchors; the unknown-age web print cannot outrank it
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

test("saleEnd <= obsStart ALWAYS; timestamps future and strictly ordered", () => {
  const plan = decide(mkSignals(), mkChain());
  const s = plan.newSeries;
  assert.ok(s.saleEnd <= s.obsStart, "production rule saleEnd <= obsStart");
  assert.ok(NOW < s.saleEnd);
  assert.ok(s.obsStart < s.obsEnd);
  assert.ok(s.obsEnd < s.redeemEnd);
  assert.deepStrictEqual(validateSeriesParams(s, NOW), []);
});

test("never more than one series per run (single object, never an array)", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(typeof plan.newSeries, "object");
  assert.ok(!Array.isArray(plan.newSeries));
});

test("capacity equals targeted free capital and is positive", () => {
  const plan = decide(mkSignals(), mkChain());
  assert.equal(plan.newSeries.capacityWei, plan.targetFreeCapitalWei);
  assert.ok(plan.newSeries.capacityWei > 0n);
});

test("no series when target free capital is zero", () => {
  const plan = decide(mkSignals(), mkChain({ sponsorWxdaiWei: 0n, freeCapitalWei: 0n }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /nothing to back/);
});

// ---------------------------------------------------------------------------
// window-overlap refusal + live-sale exclusivity
// ---------------------------------------------------------------------------

function mkSeries(overrides = {}) {
  return {
    id: 0,
    strikeLowCents: 8800,
    strikeHighCents: 9600,
    premiumRateBps: 2850,
    saleEnd: NOW - 1 * DAY, // sale over
    obsStart: NOW - 5 * DAY,
    obsEnd: NOW + 90 * DAY,
    redeemEnd: NOW + 120 * DAY,
    capacityWei: WXDAI,
    soldWei: 0n,
    settled: false,
    ...overrides,
  };
}

test("refuses to create a series whose obs window overlaps an UNSETTLED series", () => {
  // proposed window is [NOW+14d, NOW+44d]; existing unsettled obs runs to NOW+90d
  const plan = decide(mkSignals(), mkChain({ seriesCount: 1, series: [mkSeries()] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /overlap/i);
  assert.equal(plan.refused, false, "capital/pause decisions still stand — only creation is refused");
});

test("overlap with a SETTLED series does not block creation", () => {
  const plan = decide(
    mkSignals(),
    mkChain({ seriesCount: 1, series: [mkSeries({ settled: true })] }),
  );
  assert.notEqual(plan.newSeries, null);
});

test("no new series while an unsettled series is still selling", () => {
  const live = mkSeries({
    saleEnd: NOW + 5 * DAY, // still selling
    obsStart: NOW + 100 * DAY, // obs window far away — no overlap
    obsEnd: NOW + 130 * DAY,
    redeemEnd: NOW + 160 * DAY,
  });
  const plan = decide(mkSignals(), mkChain({ seriesCount: 1, series: [live] }));
  assert.equal(plan.newSeries, null);
  assert.match(plan.rationale.join(" "), /sale window/i);
});

test("non-overlapping unsettled series with closed sale does not block creation", () => {
  const far = mkSeries({
    saleEnd: NOW - 10 * DAY,
    obsStart: NOW + 100 * DAY,
    obsEnd: NOW + 130 * DAY,
    redeemEnd: NOW + 160 * DAY,
  });
  const plan = decide(mkSignals(), mkChain({ seriesCount: 1, series: [far] }));
  assert.notEqual(plan.newSeries, null);
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
    capacityWei: WXDAI,
  };
  assert.deepStrictEqual(validateSeriesParams(good, NOW), []);

  const cases = [
    [{ saleEnd: NOW + 20 * DAY }, /saleEnd must be <= obsStart/],
    [{ obsEnd: NOW + 10 * DAY }, /obsStart must be < obsEnd/],
    [{ redeemEnd: NOW + 44 * DAY }, /obsEnd must be < redeemEnd/],
    [{ saleEnd: NOW - 1 }, /future/],
    [{ premiumRateBps: 499 }, /premiumRateBps/],
    [{ premiumRateBps: 5001 }, /premiumRateBps/],
    [{ strikeLowCents: 10088 }, /strikeLowCents must be < strikeHighCents/],
    [{ capacityWei: 0n }, /capacityWei/],
    [{ capacityWei: 2n ** 128n }, /capacityWei/],
  ];
  for (const [patch, re] of cases) {
    const errs = validateSeriesParams({ ...good, ...patch }, NOW);
    assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
  }
});

// ---------------------------------------------------------------------------
// math helpers
// ---------------------------------------------------------------------------

test("expectedClaimBps: zero sigma at-the-strike is 0 bps; monotonic in sigma", () => {
  assert.equal(expectedClaimBps(9288, 800, 0), 0);
  const a = expectedClaimBps(9288, 800, 50);
  const b = expectedClaimBps(9288, 800, 200);
  const c = expectedClaimBps(9288, 800, 1000);
  assert.ok(a < b && b < c, `expected monotonic: ${a} < ${b} < ${c}`);
  assert.ok(c <= 10_000);
});

test("estimateMonthlySigmaCents: short history falls back to 150c", () => {
  const est = estimateMonthlySigmaCents([{ t: NOW, cents: 9288 }]);
  assert.equal(est.sigmaCents, DEFAULT_CONFIG.SIGMA_FALLBACK_CENTS);
  assert.equal(est.source, "fallback");
});

test("estimateMonthlySigmaCents: constant prints degenerate to fallback", () => {
  const est = estimateMonthlySigmaCents(printsEvery30d([9288, 9288, 9288, 9288, 9288]));
  assert.equal(est.source, "fallback");
});

test("estimateMonthlySigmaCents: real history is used when long enough", () => {
  const est = estimateMonthlySigmaCents(printsEvery30d([9000, 9100, 9050, 9200, 9150]));
  assert.equal(est.source, "history");
  assert.ok(est.sigmaCents > 0);
});
