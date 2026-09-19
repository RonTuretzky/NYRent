/**
 * valuation.test.mjs — unit tests for the pure fair-value model (node --test).
 * Golden cases (deep OTM ~0, mid-band 5000, deep ITM ~10000), strike
 * monotonicity, window-length effect, sigma estimation, horizon-to-midpoint,
 * and the 1.25x sell loading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VALUATION_DEFAULTS,
  MONTH_SECONDS,
  normCdf,
  normPdf,
  expectedRatioBps,
  estimateMonthlySigmaCents,
  fairValue,
  fairRatioBps,
  fairPremiumBps,
} from "./valuation.mjs";

const DAY = 86_400;
const NOW = 1_790_000_000;

// ---------------------------------------------------------------------------
// normal helpers
// ---------------------------------------------------------------------------

test("normCdf: known values and symmetry", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
  for (const x of [0.3, 1.1, 2.5]) {
    assert.ok(Math.abs(normCdf(x) + normCdf(-x) - 1) < 1e-7, `symmetry at ${x}`);
  }
  assert.ok(Math.abs(normPdf(0) - 0.3989422) < 1e-6);
});

// ---------------------------------------------------------------------------
// expectedRatioBps — golden cases
// ---------------------------------------------------------------------------

const L = 9288;
const H = 10088; // 800-cent band

test("golden: deep OTM is ~0 bps", () => {
  // print 10+ sigmas below the low strike — cover is near-worthless
  assert.ok(expectedRatioBps(L - 2000, L, H, 150) <= 1);
});

test("golden: deep ITM is ~10000 bps", () => {
  // print 10+ sigmas above the high strike — cover pays in full
  assert.ok(expectedRatioBps(H + 2000, L, H, 150) >= 9999);
});

test("golden: print at the band midpoint is 5000 bps (normal symmetry)", () => {
  const mid = (L + H) / 2;
  for (const sigma of [50, 150, 400]) {
    const r = expectedRatioBps(mid, L, H, sigma);
    assert.ok(Math.abs(r - 5000) <= 1, `sigma=${sigma}: got ${r}`);
  }
});

test("golden: at-anchor (mu = strikeLow) reproduces the documented worked example", () => {
  // README worked example (live series pricing): mu 9288, band 800, sigma_h
  // 181.7c => expected ratio 906 bps (premium 1133 bps after 1.25x loading).
  const r = expectedRatioBps(9288, 9288, 10088, 181.7);
  assert.ok(Math.abs(r - 906) <= 2, `got ${r}`);
});

test("zero sigma degenerates to the contract's deterministic clamp", () => {
  assert.equal(expectedRatioBps(L, L, H, 0), 0);
  assert.equal(expectedRatioBps(H, L, H, 0), 10_000);
  assert.equal(expectedRatioBps(L + 200, L, H, 0), 2_500);
  assert.equal(expectedRatioBps(L - 500, L, H, 0), 0);
  assert.equal(expectedRatioBps(H + 500, L, H, 0), 10_000);
});

test("monotonic: value decreases as the band shifts up, increases with mu", () => {
  const mu = 9288;
  let prev = Infinity;
  for (const shift of [-800, -400, 0, 400, 800, 1600]) {
    const r = expectedRatioBps(mu, L + shift, H + shift, 200);
    assert.ok(r <= prev, `shift ${shift}: ${r} > ${prev}`);
    prev = r;
  }
  // and monotonic non-decreasing in mu for fixed strikes
  let prevMu = -1;
  for (const m of [8000, 8800, 9288, 9700, 10100, 11000]) {
    const r = expectedRatioBps(m, L, H, 200);
    assert.ok(r >= prevMu, `mu ${m}: ${r} < ${prevMu}`);
    prevMu = r;
  }
});

test("monotonic in sigma at the anchor (more vol = more expected payout)", () => {
  const a = expectedRatioBps(L, L, H, 50);
  const b = expectedRatioBps(L, L, H, 200);
  const c = expectedRatioBps(L, L, H, 1000);
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
  assert.ok(c <= 10_000);
});

test("expectedRatioBps validates inputs", () => {
  assert.throws(() => expectedRatioBps(9288, 10088, 9288, 150)); // inverted strikes
  assert.throws(() => expectedRatioBps(9288, 9288, 9288, 150)); // zero band
  assert.throws(() => expectedRatioBps(9288, 9288, 10088, -1)); // negative sigma
  assert.throws(() => expectedRatioBps(NaN, 9288, 10088, 150));
});

// ---------------------------------------------------------------------------
// sigma estimation
// ---------------------------------------------------------------------------

function printsEvery30d(centsSeq) {
  return centsSeq.map((cents, i) => ({ t: NOW - (centsSeq.length - i) * 30 * DAY, cents }));
}

test("estimateMonthlySigmaCents: short history falls back to $1.50/SF", () => {
  const est = estimateMonthlySigmaCents([{ t: NOW, cents: 9288 }]);
  assert.equal(est.sigmaCents, VALUATION_DEFAULTS.SIGMA_FALLBACK_CENTS);
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

// ---------------------------------------------------------------------------
// fairValue / fairRatioBps / fairPremiumBps
// ---------------------------------------------------------------------------

const stdSeries = {
  strikeLowCents: 9288,
  strikeHighCents: 10088,
  obsStart: NOW + 14 * DAY,
  obsEnd: NOW + 44 * DAY,
};
const freshSignals = { prints: [{ t: NOW - 1 * DAY, cents: 9288 }] };

test("fairValue: null when no usable print exists", () => {
  assert.equal(fairValue(stdSeries, { prints: [] }, NOW), null);
  assert.equal(fairValue(stdSeries, null, NOW), null);
  // a print too far in the future is bad data, not a print
  assert.equal(fairValue(stdSeries, { prints: [{ t: NOW + 30 * DAY, cents: 9288 }] }, NOW), null);
  assert.equal(fairRatioBps(stdSeries, { prints: [] }, NOW), null);
  assert.equal(fairPremiumBps(stdSeries, { prints: [] }, NOW), null);
});

test("fairValue: newest usable print is mu", () => {
  const fv = fairValue(
    stdSeries,
    { prints: [{ t: NOW - 40 * DAY, cents: 8000 }, { t: NOW - 1 * DAY, cents: 9288 }] },
    NOW,
  );
  assert.equal(fv.muCents, 9288);
});

test("fairValue: horizon runs to the observation-window MIDPOINT", () => {
  const fv = fairValue(stdSeries, freshSignals, NOW);
  // midpoint of [NOW+14d, NOW+44d] is NOW+29d => 29/30 months
  assert.ok(Math.abs(fv.horizonMonths - (29 * DAY) / MONTH_SECONDS) < 1e-9);
  assert.ok(
    Math.abs(fv.sigmaHorizonCents - fv.sigmaMonthlyCents * Math.sqrt(fv.horizonMonths)) < 1e-9,
  );
});

test("fairValue: past the midpoint the horizon floors at 0 (deterministic clamp)", () => {
  const series = { ...stdSeries, obsStart: NOW - 20 * DAY, obsEnd: NOW - 2 * DAY };
  const fv = fairValue(series, freshSignals, NOW);
  assert.equal(fv.horizonMonths, 0);
  // mu == strikeLow with zero variance => ratio exactly 0
  assert.equal(fv.ratioBps, 0);
});

test("window-length effect: a longer window (later midpoint) is worth more at the anchor", () => {
  const short = fairRatioBps({ ...stdSeries, obsEnd: NOW + 24 * DAY }, freshSignals, NOW);
  const std = fairRatioBps(stdSeries, freshSignals, NOW);
  const long = fairRatioBps({ ...stdSeries, obsEnd: NOW + 104 * DAY }, freshSignals, NOW);
  assert.ok(short < std && std < long, `${short} < ${std} < ${long}`);
});

test("fairPremiumBps = fairRatioBps x 1.25 loading (sell side only)", () => {
  const ratio = fairRatioBps(stdSeries, freshSignals, NOW);
  const premium = fairPremiumBps(stdSeries, freshSignals, NOW);
  assert.equal(premium, Math.round((ratio * VALUATION_DEFAULTS.LOADING_BPS) / 10_000));
  assert.ok(premium > ratio, "loading must make the sell quote richer than fair");
});

test("fairValue is pure/deterministic and validates its frame", () => {
  const a = fairValue(stdSeries, freshSignals, NOW);
  const b = fairValue(stdSeries, freshSignals, NOW);
  assert.deepStrictEqual(a, b);
  assert.throws(() => fairValue({ ...stdSeries, obsEnd: stdSeries.obsStart }, freshSignals, NOW));
  assert.throws(() => fairValue(stdSeries, freshSignals, NaN));
});
