/**
 * valuation.mjs — pure fair-value model for CoverPool series (any strikes, any
 * observation window, any creator). No I/O, no clock (time is a parameter), no
 * randomness: same inputs => byte-identical outputs.
 *
 * WHAT IT PRICES
 * A CoverPool series settles at ratio clamp((cents − strikeLow)/(strikeHigh −
 * strikeLow), 0, 1) against a qualifying CredailyRentOracle observation whose
 * timestamp lies inside [obsStart, obsEnd]. The fair value of one claim unit is
 * therefore E[settlement ratio]; this module computes that expectation in bps:
 *
 *   fairRatioBps(series, signals, nowSec) -> integer bps in [0, 10000] | null
 *
 * MODEL (Bachelier / arithmetic normal — the machinery behind the live series
 * pricing, generalized from the old print-anchored strikes to arbitrary ones):
 *   X ~ N(mu, sigmaHorizon^2),  mu = latest authoritative print (cents),
 *   L = strikeLowCents, H = strikeHighCents, B = H − L,
 *   E[clamp((X−L)/B, 0, 1)] = (C(L) − C(H)) / B          (call-spread identity)
 *   C(a) = sigma*phi((mu−a)/sigma) + (mu−a)*Phi((mu−a)/sigma)
 *
 * EVERY CONSTANT, DOCUMENTED:
 *   - LOADING_BPS = 12500 (1.25x): the sell-side loading on expected claim,
 *     matching the economic model behind the live series (xlsx Option 2:
 *     premium = expected claim x (1 + 25%)). fairPremiumBps = fairRatioBps x 1.25.
 *     The BUY side never uses loading — arbitrage compares quoted premium to the
 *     unloaded fairRatioBps.
 *   - SIGMA_FALLBACK_CENTS = 150 ($1.50/SF-month): documented fallback monthly
 *     sigma when print history is too short or degenerate. Chosen when the live
 *     series was priced: roughly the month-to-month dispersion CRE Daily's Manhattan
 *     office effective-rent print has shown across regimes; deliberately on the
 *     high side so a thin history prices cover rich, never cheap.
 *   - MIN_PRINTS_FOR_SIGMA = 4: fewer usable prints than this and the sample
 *     std of month-normalized moves is noise — fall back.
 *   - HORIZON = time from `now` to the OBSERVATION-WINDOW MIDPOINT, floored at
 *     0. Settlement can occur at any qualifying observation inside [obsStart,
 *     obsEnd] and CRE Daily prints roughly uniformly (~monthly), so the
 *     expected settlement time is ~the window midpoint — not obsEnd (the old
 *     print-anchored policy used obsEnd; the midpoint is the correct
 *     generalization when valuing series bought mid-flight, and is what both
 *     sides of the book use so sell and buy pricing stay consistent). Once
 *     `now` passes the midpoint the horizon is 0 and the value degenerates to
 *     the deterministic clamp of the current print.
 *   - MONTH_SECONDS = 30 days: the month unit sigma is quoted in.
 *
 * All cent/sigma math is in Numbers (cents are small); nothing here touches
 * currency units, so the module is decimals-agnostic (WXDAI 18 / USDC 6).
 */

const DAY = 86_400;
export const MONTH_SECONDS = 30 * DAY;
const BPS = 10_000;

/** Valuation constants (see the header for the reasoning behind each). */
export const VALUATION_DEFAULTS = {
  LOADING_BPS: 12_500, // 1.25x sell-side loading (xlsx Option 2: B38 = B37 * 1.25)
  SIGMA_FALLBACK_CENTS: 150, // $1.50/SF-month fallback sigma (documented above)
  MIN_PRINTS_FOR_SIGMA: 4, // prints needed before trusting historical sigma
  MAX_FUTURE_PRINT_SKEW_SEC: 1 * DAY, // prints > 1d in the future are bad data
};

// ---------------------------------------------------------------------------
// Normal distribution helpers
// ---------------------------------------------------------------------------

/** Standard normal pdf. */
export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal cdf, Abramowitz–Stegun 26.2.17 (|err| < 7.5e-8), deterministic. */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = normPdf(Math.abs(x)) * poly;
  return x >= 0 ? 1 - p : p;
}

// ---------------------------------------------------------------------------
// Core expectation — arbitrary strikes
// ---------------------------------------------------------------------------

/**
 * E[clamp((X − L)/(H − L), 0, 1)] in bps, X ~ N(muCents, sigmaCents^2).
 * Generalizes the old expectedClaimBps (which pinned L = round(mu)) to
 * arbitrary strikes so ANY open series on the pool can be valued.
 * sigmaCents = 0 degenerates to the deterministic clamp of muCents.
 */
export function expectedRatioBps(muCents, strikeLowCents, strikeHighCents, sigmaCents) {
  const L = strikeLowCents;
  const H = strikeHighCents;
  if (!(Number.isFinite(muCents) && Number.isFinite(L) && Number.isFinite(H)))
    throw new Error("muCents/strikes must be finite numbers");
  if (!(H > L)) throw new Error("strikeHighCents must be > strikeLowCents");
  if (!Number.isFinite(sigmaCents) || sigmaCents < 0) throw new Error("sigmaCents must be finite >= 0");
  const B = H - L;
  let e;
  if (sigmaCents === 0) {
    e = Math.min(1, Math.max(0, (muCents - L) / B));
  } else {
    const call = (a) => {
      const d = (muCents - a) / sigmaCents;
      return sigmaCents * normPdf(d) + (muCents - a) * normCdf(d);
    };
    e = (call(L) - call(H)) / B;
  }
  return Math.round(Math.min(1, Math.max(0, e)) * BPS);
}

// ---------------------------------------------------------------------------
// Sigma from print history
// ---------------------------------------------------------------------------

/**
 * Monthly sigma (cents) from print history: sample std (n−1) of
 * month-normalized consecutive moves (c_i − c_{i−1}) / sqrt(dt / 30d).
 * Falls back to SIGMA_FALLBACK_CENTS when history has fewer than
 * MIN_PRINTS_FOR_SIGMA usable prints or the estimate degenerates.
 * Returns { sigmaCents, source: "history" | "fallback", n }.
 */
export function estimateMonthlySigmaCents(prints, config = VALUATION_DEFAULTS) {
  const cfg = { ...VALUATION_DEFAULTS, ...config };
  const fallback = { sigmaCents: cfg.SIGMA_FALLBACK_CENTS, source: "fallback", n: 0 };
  const pts = (prints ?? [])
    .filter((p) => Number.isFinite(p?.t) && Number.isFinite(p?.cents) && p.t > 0 && p.cents > 0)
    .sort((a, b) => a.t - b.t);
  // collapse duplicate timestamps (keep the later-listed value)
  const uniq = [];
  for (const p of pts) {
    if (uniq.length && uniq[uniq.length - 1].t === p.t) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  fallback.n = uniq.length;
  if (uniq.length < cfg.MIN_PRINTS_FOR_SIGMA) return fallback;
  const moves = [];
  for (let i = 1; i < uniq.length; i++) {
    const dt = uniq[i].t - uniq[i - 1].t;
    if (dt <= 0) continue;
    moves.push((uniq[i].cents - uniq[i - 1].cents) / Math.sqrt(dt / MONTH_SECONDS));
  }
  if (moves.length < 2) return fallback;
  const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
  const variance = moves.reduce((a, m) => a + (m - mean) ** 2, 0) / (moves.length - 1);
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma <= 0) return fallback;
  return { sigmaCents: sigma, source: "history", n: uniq.length };
}

// ---------------------------------------------------------------------------
// Fair value of a series
// ---------------------------------------------------------------------------

/**
 * Full fair-value breakdown for a series. PURE.
 *
 * @param {object} series  { strikeLowCents, strikeHighCents, obsStart, obsEnd }
 * @param {object} signals { prints: [{ t, cents }] } — the VETTED, MERGED print
 *                 history (oracle observations + plausibility-gated web prints;
 *                 the caller — decide.mjs — owns that vetting). The newest
 *                 usable print is mu; the whole history feeds sigma.
 * @param {number} nowSec  unix seconds (from chain state, never a wall clock)
 * @param {object} [config] overrides merged over VALUATION_DEFAULTS
 * @returns {object|null} null when no usable print exists (nothing can be
 *   valued), else {
 *     ratioBps,          // E[settlement ratio], integer bps in [0, 10000]
 *     premiumBps,        // sell-side quote: round(ratioBps * LOADING_BPS / 1e4)
 *     muCents, sigmaMonthlyCents, sigmaSource, sigmaN,
 *     horizonMonths, sigmaHorizonCents,
 *   }
 */
export function fairValue(series, signals, nowSec, config = VALUATION_DEFAULTS) {
  const cfg = { ...VALUATION_DEFAULTS, ...config };
  if (!series || typeof series !== "object") throw new Error("series required");
  const { strikeLowCents, strikeHighCents, obsStart, obsEnd } = series;
  if (!(Number.isFinite(obsStart) && Number.isFinite(obsEnd) && obsStart < obsEnd))
    throw new Error("series obsStart/obsEnd must be finite with obsStart < obsEnd");
  if (!Number.isFinite(nowSec) || nowSec <= 0) throw new Error("nowSec must be a positive number");

  const prints = (signals?.prints ?? []).filter(
    (p) =>
      Number.isFinite(p?.t) &&
      Number.isFinite(p?.cents) &&
      p.t > 0 &&
      p.cents > 0 &&
      p.t <= nowSec + cfg.MAX_FUTURE_PRINT_SKEW_SEC,
  );
  if (prints.length === 0) return null;
  const latest = prints.reduce((a, b) => (b.t >= a.t ? b : a));
  const mu = latest.cents;

  const sigmaEst = estimateMonthlySigmaCents(prints, cfg);
  // Horizon: now -> observation-window midpoint (see header), floored at 0.
  const midpoint = (obsStart + obsEnd) / 2;
  const horizonMonths = Math.max(0, (midpoint - nowSec) / MONTH_SECONDS);
  const sigmaHorizonCents = sigmaEst.sigmaCents * Math.sqrt(horizonMonths);

  const ratioBps = expectedRatioBps(mu, strikeLowCents, strikeHighCents, sigmaHorizonCents);
  const premiumBps = Math.round((ratioBps * cfg.LOADING_BPS) / BPS);
  return {
    ratioBps,
    premiumBps,
    muCents: mu,
    sigmaMonthlyCents: sigmaEst.sigmaCents,
    sigmaSource: sigmaEst.source,
    sigmaN: sigmaEst.n,
    horizonMonths,
    sigmaHorizonCents,
  };
}

/**
 * E[settlement ratio] in bps for a series — the BUY-side fair value.
 * Returns an integer in [0, 10000], or null when no usable print exists.
 */
export function fairRatioBps(series, signals, nowSec, config = VALUATION_DEFAULTS) {
  const fv = fairValue(series, signals, nowSec, config);
  return fv === null ? null : fv.ratioBps;
}

/**
 * SELL-side fair quote in bps: fairRatioBps x 1.25 loading (LOADING_BPS),
 * UNCLAMPED — decide.mjs applies the [PREMIUM_MIN_BPS, PREMIUM_MAX_BPS] clamp
 * and any inventory lean. Returns null when no usable print exists.
 */
export function fairPremiumBps(series, signals, nowSec, config = VALUATION_DEFAULTS) {
  const fv = fairValue(series, signals, nowSec, config);
  return fv === null ? null : fv.premiumBps;
}
