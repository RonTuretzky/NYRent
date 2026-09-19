/**
 * decide.mjs — deterministic policy core for the NY Rent Cover daily agent.
 *
 * decide(signals, chainState, config) -> Plan is a PURE function: no I/O, no
 * clocks (time comes from chainState.nowSec), no randomness. Same inputs =>
 * byte-identical Plan. Everything the executor may do on-chain is derived here
 * and clamped here; the executor must never widen a plan.
 *
 * Plan shape:
 *   {
 *     refused:              boolean          — true => do NOTHING on-chain
 *     targetFreeCapitalWei: bigint | null    — desired CoverPool freeCapital()
 *     capitalDeltaWei:      bigint | null    — target - current free capital
 *                                              (>0 fund, <0 withdraw), post-clamp
 *     newSeries:            null | {         — at most ONE series per run
 *       strikeLowCents, strikeHighCents,     — uint32, cents of $/SF
 *       premiumRateBps,                      — uint16, clamped [500, 5000]
 *       saleEnd, obsStart, obsEnd, redeemEnd,— unix seconds, saleEnd <= obsStart
 *       capacityWei                          — bigint, uint128
 *     }
 *     pause:                boolean | null   — setSalesPaused target; null = leave
 *     rationale:            string[]         — every decision, human-readable
 *   }
 *
 * POLICY (constants documented in DEFAULT_CONFIG below):
 *
 * 1. Authoritative print = the newest CRE Daily "Manhattan Office Rent · Avg
 *    Effective $/SF" value in cents, merged from (a) on-chain oracle
 *    observations (chainState.oracle.observations — DKIM-verified, strongest)
 *    and (b) collector web prints (signals.prints, source "credaily-web").
 *    Prints timestamped more than 1 day in the future are discarded (bad data).
 *    PLAUSIBILITY GATE: when at least one DKIM-verified oracle observation
 *    exists, a scraped web print may anchor strikes ONLY if it is within
 *    WEB_PRINT_MAX_DIVERGENCE_BPS (±15%) of the latest oracle observation;
 *    implausible web prints are rejected (recorded in rationale) and the
 *    policy falls back to the oracle prints. Prints with an unknown timestamp
 *    (t null — e.g. a credaily page missing article:published_time) are
 *    treated as stale: they may corroborate but never anchor strikes and
 *    never count toward freshness (stale/blackout clocks ignore them).
 *
 * 2. Strikes anchor to the print: strikeLow = round(print), strikeHigh =
 *    strikeLow + BAND_CENTS (800 = $8.00/SF, matching the live demo band
 *    8800/9600). Payout at the current print is therefore 0 and ramps to 100%
 *    if rents rise $8/SF over the observation window.
 *
 * 3. premiumRateBps = clamp(round(expectedClaimBps * LOADING), PREMIUM_MIN_BPS,
 *    PREMIUM_MAX_BPS). expectedClaimBps uses a normal approximation of the
 *    clamped-spread payout: with X ~ N(print, sigmaHorizon^2), L = strikeLow,
 *    B = band,
 *        E[clamp((X-L)/B, 0, 1)] = (C(L) - C(L+B)) / B,
 *        C(a) = sigma*phi((mu-a)/sigma) + (mu-a)*Phi((mu-a)/sigma)
 *    (the Bachelier call-spread identity). sigmaHorizon = sigmaMonthly *
 *    sqrt(monthsToObsEnd). sigmaMonthly is the sample std of month-normalized
 *    print-to-print moves (needs >= MIN_PRINTS_FOR_SIGMA prints, else the
 *    documented fallback SIGMA_FALLBACK_CENTS = 150 cents = $1.50/SF).
 *
 * 4. Capital: target freeCapital = DEPLOY_FRACTION (80%) * (current free
 *    capital + sponsor WXDAI) * health. health starts at 100% and is halved
 *    when data is stale (no print within STALE_AFTER_DAYS = 45d) and halved
 *    again under Kalshi-implied vacancy stress (P(vacancy below threshold) <
 *    KALSHI_STRESS_MAX_PROB on the KXMANOFFVAC market — the market implying a
 *    distressed, volatile office market).
 *
 * 5. Pause: setSalesPaused(true) ONLY on data blackout (> BLACKOUT_AFTER_DAYS
 *    = 60d without any print). The policy NEVER auto-unpauses: pause:false is
 *    only ever emitted when config.allowUnpause === true (default false) —
 *    otherwise an existing pause (possibly a deliberate manual sponsor pause)
 *    is respected, pause stays null, and the rationale says so.
 *
 * SAFETY CLAMPS (non-negotiable, unit-tested):
 *   - |capitalDeltaWei| <= MAX_CAPITAL_DELTA_WEI (0.5 WXDAI) per run
 *   - premiumRateBps in [500, 5000]
 *   - at most ONE newSeries per run (structural: single object or null)
 *   - never an obs window overlapping any UNSETTLED series' obs window
 *   - saleEnd <= obsStart ALWAYS (production rule; the demo series' violation
 *     of it is exactly what we refuse to repeat)
 *   - all series timestamps strictly in the future and ordered
 *   - chainState.ok !== true => refused plan, nothing else computed
 */

const DAY = 86_400;
const MONTH_SECONDS = 30 * DAY;
const BPS = 10_000;

/**
 * Every policy constant, with meaning. Override via decide(..., config) —
 * unknown keys are ignored, missing keys fall back to these values.
 */
export const DEFAULT_CONFIG = {
  // -- strike anchoring ------------------------------------------------------
  BAND_CENTS: 800, // strikeHigh - strikeLow, $8.00/SF (live demo band 8800/9600)

  // -- premium ---------------------------------------------------------------
  LOADING_BPS: 12_500, // 1.25x loading on expected claim (xlsx Option 2: B38 = B37 * 1.25)
  PREMIUM_MIN_BPS: 500, // 5% floor  — never sell protection for less
  PREMIUM_MAX_BPS: 5_000, // 50% cap — above this the product is not credible
  SIGMA_FALLBACK_CENTS: 150, // $1.50/SF monthly sigma when history is too short
  MIN_PRINTS_FOR_SIGMA: 4, // prints needed before trusting historical sigma

  // -- capital ---------------------------------------------------------------
  DEPLOY_FRACTION_BPS: 8_000, // deploy up to 80% of sponsor WXDAI + pool free capital
  STALE_AFTER_DAYS: 45, // no print within 45d => data is stale
  STALE_HEALTH_BPS: 5_000, // stale data halves the deploy target
  KALSHI_STRESS_MAX_PROB: 0.35, // P(vacancy below strike) under this => vacancy stress
  KALSHI_STRESS_HEALTH_BPS: 5_000, // vacancy stress halves the deploy target
  MAX_CAPITAL_DELTA_WEI: 500_000_000_000_000_000n, // 0.5 WXDAI hard per-run cap
  MIN_ACTION_DELTA_WEI: 10_000_000_000_000n, // 0.00001 WXDAI — below this, do nothing (dust)

  // -- pause -----------------------------------------------------------------
  BLACKOUT_AFTER_DAYS: 60, // no print within 60d => pause sales
  allowUnpause: false, // NEVER auto-unpause unless explicitly enabled — a manual sponsor pause is respected

  // -- series windows (production rule saleEnd <= obsStart baked in) ---------
  SALE_DURATION_DAYS: 14, // sale runs [now, now+14d]
  OBS_DURATION_DAYS: 30, // observation window [saleEnd, saleEnd+30d]
  REDEEM_DURATION_DAYS: 30, // claim window [obsEnd, obsEnd+30d]

  // -- data hygiene ----------------------------------------------------------
  MAX_FUTURE_PRINT_SKEW_SEC: 1 * DAY, // prints > 1d in the future are discarded
  WEB_PRINT_MAX_DIVERGENCE_BPS: 1_500, // web print may anchor only within ±15% of the latest DKIM oracle observation
};

// ---------------------------------------------------------------------------
// Math helpers (exported for unit tests)
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

/**
 * Expected payout of clamp((X - L)/B, 0, 1) in bps, X ~ N(printCents, sigma^2),
 * L = round(printCents), B = bandCents. Bachelier call-spread:
 *   E = (C(L) - C(L+B)) / B,  C(a) = sigma*phi(d) + (mu-a)*Phi(d), d = (mu-a)/sigma.
 */
export function expectedClaimBps(printCents, bandCents, sigmaCents) {
  if (!(bandCents > 0)) throw new Error("bandCents must be > 0");
  if (!Number.isFinite(sigmaCents) || sigmaCents < 0) throw new Error("sigmaCents must be finite >= 0");
  const mu = printCents;
  const L = Math.round(printCents);
  let e;
  if (sigmaCents === 0) {
    e = Math.min(1, Math.max(0, (mu - L) / bandCents));
  } else {
    const call = (a) => {
      const d = (mu - a) / sigmaCents;
      return sigmaCents * normPdf(d) + (mu - a) * normCdf(d);
    };
    e = (call(L) - call(L + bandCents)) / bandCents;
  }
  return Math.round(Math.min(1, Math.max(0, e)) * BPS);
}

/**
 * Monthly sigma (cents) from the print history: sample std (n-1) of
 * month-normalized consecutive moves (c_i - c_{i-1}) / sqrt(dt / 30d).
 * Falls back to SIGMA_FALLBACK_CENTS when history has fewer than
 * MIN_PRINTS_FOR_SIGMA usable prints or the estimate degenerates.
 * Returns { sigmaCents, source: "history" | "fallback", n }.
 */
export function estimateMonthlySigmaCents(prints, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
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

/**
 * Final validation gate for a series candidate. Returns [] when valid, else a
 * list of violations. Enforces the PRODUCTION rule saleEnd <= obsStart (the
 * contract itself only requires saleEnd <= obsEnd).
 */
export function validateSeriesParams(c, nowSec, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errs = [];
  if (c === null || typeof c !== "object") return ["candidate is not an object"];
  if (!Number.isInteger(c.strikeLowCents) || c.strikeLowCents <= 0 || c.strikeLowCents >= 2 ** 32)
    errs.push("strikeLowCents must be a positive uint32");
  if (!Number.isInteger(c.strikeHighCents) || c.strikeHighCents >= 2 ** 32)
    errs.push("strikeHighCents must be a uint32");
  if (!(c.strikeLowCents < c.strikeHighCents)) errs.push("strikeLowCents must be < strikeHighCents");
  if (
    !Number.isInteger(c.premiumRateBps) ||
    c.premiumRateBps < cfg.PREMIUM_MIN_BPS ||
    c.premiumRateBps > cfg.PREMIUM_MAX_BPS
  )
    errs.push(`premiumRateBps must be an integer in [${cfg.PREMIUM_MIN_BPS}, ${cfg.PREMIUM_MAX_BPS}]`);
  for (const k of ["saleEnd", "obsStart", "obsEnd", "redeemEnd"]) {
    if (!Number.isInteger(c[k]) || c[k] <= 0 || c[k] > Number.MAX_SAFE_INTEGER)
      errs.push(`${k} must be a positive integer unix timestamp`);
    else if (!(c[k] > nowSec)) errs.push(`${k} must be strictly in the future (now=${nowSec})`);
  }
  if (!(c.saleEnd <= c.obsStart)) errs.push("PRODUCTION RULE violated: saleEnd must be <= obsStart");
  if (!(c.obsStart < c.obsEnd)) errs.push("obsStart must be < obsEnd");
  if (!(c.obsEnd < c.redeemEnd)) errs.push("obsEnd must be < redeemEnd");
  if (typeof c.capacityWei !== "bigint" || c.capacityWei <= 0n || c.capacityWei >= 2n ** 128n)
    errs.push("capacityWei must be a bigint in (0, 2^128)");
  return errs;
}

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

function refusedPlan(rationale) {
  return {
    refused: true,
    targetFreeCapitalWei: null,
    capitalDeltaWei: null,
    newSeries: null,
    pause: null,
    rationale,
  };
}

/**
 * @param {object} signals    collector output (see agent/README.md):
 *   { prints: [{t, cents, source}], kalshi: {probVacancyBelow, ticker?, ts?} | null, ... }
 *   May be null/empty — the policy then leans on on-chain oracle prints alone.
 * @param {object} chainState from run.mjs readChainState(); must include:
 *   ok, nowSec, salesPaused, freeCapitalWei, sponsorWxdaiWei,
 *   series: [{settled, saleEnd, obsStart, obsEnd, redeemEnd, ...}],
 *   oracle: { observations: [{t, cents}] }
 * @param {object} [config]   overrides merged over DEFAULT_CONFIG
 * @returns {object} Plan (see file header)
 */
export function decide(signals, chainState, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rationale = [];

  // -- SAFETY: refuse to act on a failed or absent chain read ---------------
  if (!chainState || chainState.ok !== true) {
    return refusedPlan([
      `REFUSE: chain state read failed (${chainState?.error ?? "chainState missing"}) — no on-chain action may be planned without a verified view of the pool.`,
    ]);
  }
  const now = Number(chainState.nowSec);
  if (!Number.isFinite(now) || now <= 0) {
    return refusedPlan(["REFUSE: chainState.nowSec is invalid — cannot reason about time."]);
  }

  // -- 1. authoritative print merge -----------------------------------------
  const validPrint = (p) =>
    Number.isFinite(p.t) &&
    Number.isFinite(p.cents) &&
    p.t > 0 &&
    p.cents > 0 &&
    p.t <= now + cfg.MAX_FUTURE_PRINT_SKEW_SEC;

  const oraclePrints = (chainState.oracle?.observations ?? [])
    .map((o) => ({ t: Number(o.t), cents: Number(o.cents), source: "oracle" }))
    .filter(validPrint)
    .sort((a, b) => a.t - b.t);
  const latestOracle = oraclePrints.length ? oraclePrints[oraclePrints.length - 1] : null;

  const rawWebPrints = (signals?.prints ?? []).map((p) => ({
    t: p?.t === null || p?.t === undefined ? null : Number(p.t),
    cents: Number(p?.cents),
    source: p?.source ?? "credaily-web",
  }));

  // Unknown-age prints (no publish timestamp): treated as stale — they may
  // corroborate but never anchor strikes and never count toward freshness.
  const unknownAgePrints = rawWebPrints.filter(
    (p) => p.t === null && Number.isFinite(p.cents) && p.cents > 0,
  );
  if (unknownAgePrints.length) {
    rationale.push(
      `${unknownAgePrints.length} web print(s) with no publish timestamp (${unknownAgePrints
        .map((p) => `${p.cents}c`)
        .join(", ")}) — treated as stale: corroboration only, never anchoring or freshness.`,
    );
  }

  // PLAUSIBILITY GATE: with a DKIM-verified oracle observation on-chain, a
  // scraped web print may only anchor when it is within the configured band of
  // the latest oracle print — otherwise it is rejected (a poisoned or
  // mis-contexted credaily page must not set strikes the pool settles against).
  const webPrints = [];
  for (const p of rawWebPrints.filter((p) => p.t !== null).filter(validPrint)) {
    if (latestOracle) {
      const divergenceBps = Math.abs(p.cents - latestOracle.cents) * BPS / latestOracle.cents;
      if (divergenceBps > cfg.WEB_PRINT_MAX_DIVERGENCE_BPS) {
        rationale.push(
          `PLAUSIBILITY REJECTION: web print ${p.cents}c diverges ${(divergenceBps / 100).toFixed(1)}% from the latest DKIM-verified oracle observation ${latestOracle.cents}c (> ${(cfg.WEB_PRINT_MAX_DIVERGENCE_BPS / 100).toFixed(0)}% band) — rejected; falling back to oracle prints for anchoring.`,
        );
        continue;
      }
    }
    webPrints.push(p);
  }

  const merged = [...oraclePrints, ...webPrints].sort((a, b) => a.t - b.t);
  const latest = merged.length ? merged[merged.length - 1] : null;
  const ageSec = latest ? now - latest.t : Infinity;
  const ageDays = ageSec / DAY;

  if (latest) {
    rationale.push(
      `Print: ${latest.cents} cents ($${(latest.cents / 100).toFixed(2)}/SF) from ${latest.source}, age ${ageDays.toFixed(1)}d (${merged.length} prints total).`,
    );
  } else {
    rationale.push("Print: NONE — no oracle observation and no collector print available.");
  }

  const stale = ageSec > cfg.STALE_AFTER_DAYS * DAY;
  const blackout = ageSec > cfg.BLACKOUT_AFTER_DAYS * DAY;

  // -- 2. Kalshi vacancy stress ---------------------------------------------
  const kalshiProb = signals?.kalshi?.probVacancyBelow;
  const kalshiStress = typeof kalshiProb === "number" && kalshiProb < cfg.KALSHI_STRESS_MAX_PROB;
  if (typeof kalshiProb === "number") {
    rationale.push(
      `Kalshi P(vacancy below strike) = ${kalshiProb.toFixed(2)} — ${
        kalshiStress ? `STRESS (< ${cfg.KALSHI_STRESS_MAX_PROB})` : "no stress"
      }.`,
    );
  } else {
    rationale.push("Kalshi signal absent — no vacancy-stress adjustment.");
  }

  // -- 3. health factor ------------------------------------------------------
  let healthBps = BPS;
  if (stale) {
    healthBps = Math.floor((healthBps * cfg.STALE_HEALTH_BPS) / BPS);
    rationale.push(
      `Data stale (no print within ${cfg.STALE_AFTER_DAYS}d) — health scaled to ${healthBps} bps.`,
    );
  }
  if (kalshiStress) {
    healthBps = Math.floor((healthBps * cfg.KALSHI_STRESS_HEALTH_BPS) / BPS);
    rationale.push(`Kalshi vacancy stress — health scaled to ${healthBps} bps.`);
  }
  if (!stale && !kalshiStress) rationale.push("Signals healthy — health 10000 bps.");

  // -- 4. pause decision -----------------------------------------------------
  let pause = null;
  if (blackout && !chainState.salesPaused) {
    pause = true;
    rationale.push(
      `PAUSE: data blackout (no print within ${cfg.BLACKOUT_AFTER_DAYS}d) — setSalesPaused(true).`,
    );
  } else if (blackout) {
    rationale.push("Data blackout persists — sales already paused, leaving as-is.");
  } else if (!blackout && chainState.salesPaused) {
    // NEVER auto-unpause: the pause may be a deliberate manual sponsor action
    // (incident response). Unpausing requires the explicit allowUnpause opt-in.
    if (cfg.allowUnpause === true) {
      pause = false;
      rationale.push("Data healthy again — setSalesPaused(false) to resume sales (allowUnpause=true).");
    } else {
      rationale.push(
        "Data healthy but sales are paused — respecting the existing (possibly manual) pause; auto-unpause is disabled (config.allowUnpause=false), leaving pause as-is.",
      );
    }
  }
  const effectivePaused = pause === null ? Boolean(chainState.salesPaused) : pause;

  // -- 5. capital target -----------------------------------------------------
  const free = BigInt(chainState.freeCapitalWei);
  const sponsorWxdai = BigInt(chainState.sponsorWxdaiWei);
  const total = free + sponsorWxdai;
  const rawTarget = (total * BigInt(cfg.DEPLOY_FRACTION_BPS) * BigInt(healthBps)) / (BigInt(BPS) * BigInt(BPS));
  let delta = rawTarget - free;
  if (delta > cfg.MAX_CAPITAL_DELTA_WEI) {
    rationale.push(
      `SAFETY CLAMP: capital delta ${delta} wei > +${cfg.MAX_CAPITAL_DELTA_WEI} — clamped to +0.5 WXDAI per run.`,
    );
    delta = cfg.MAX_CAPITAL_DELTA_WEI;
  } else if (delta < -cfg.MAX_CAPITAL_DELTA_WEI) {
    rationale.push(
      `SAFETY CLAMP: capital delta ${delta} wei < -${cfg.MAX_CAPITAL_DELTA_WEI} — clamped to -0.5 WXDAI per run.`,
    );
    delta = -cfg.MAX_CAPITAL_DELTA_WEI;
  }
  if (delta > sponsorWxdai) {
    rationale.push(`Fund delta capped at sponsor WXDAI balance (${sponsorWxdai} wei).`);
    delta = sponsorWxdai;
  }
  if (delta < -free) {
    rationale.push(`Withdraw delta capped at current free capital (${free} wei).`);
    delta = -free;
  }
  if (delta > -cfg.MIN_ACTION_DELTA_WEI && delta < cfg.MIN_ACTION_DELTA_WEI && delta !== 0n) {
    rationale.push(`Capital delta ${delta} wei is dust (< ${cfg.MIN_ACTION_DELTA_WEI}) — no capital action.`);
    delta = 0n;
  }
  const targetFreeCapitalWei = free + delta;
  rationale.push(
    `Capital: free=${free} sponsor=${sponsorWxdai} raw target=${rawTarget} => target=${targetFreeCapitalWei} (delta ${delta >= 0n ? "+" : ""}${delta} wei).`,
  );

  // -- 6. new series ---------------------------------------------------------
  // Structural clamp: at most one candidate is ever constructed per run.
  let newSeries = null;
  const unsettled = (chainState.series ?? []).filter((s) => !s.settled);
  if (blackout) {
    rationale.push("No new series: data blackout.");
  } else if (stale) {
    rationale.push("No new series: print is stale — strikes cannot be anchored safely.");
  } else if (!latest) {
    rationale.push("No new series: no authoritative print to anchor strikes.");
  } else if (effectivePaused) {
    rationale.push("No new series: sales are (or will be) paused.");
  } else if (unsettled.some((s) => Number(s.saleEnd) > now)) {
    rationale.push("No new series: an unsettled series is still in its sale window (one live sale at a time).");
  } else if (targetFreeCapitalWei <= 0n) {
    rationale.push("No new series: target free capital is zero — nothing to back it with.");
  } else {
    const saleEnd = now + cfg.SALE_DURATION_DAYS * DAY;
    const obsStart = saleEnd; // production rule saleEnd <= obsStart, set equal
    const obsEnd = obsStart + cfg.OBS_DURATION_DAYS * DAY;
    const redeemEnd = obsEnd + cfg.REDEEM_DURATION_DAYS * DAY;

    // SAFETY: never overlap the obs window of ANY unsettled series.
    const overlapping = unsettled.filter(
      (s) => obsStart <= Number(s.obsEnd) && Number(s.obsStart) <= obsEnd,
    );
    if (overlapping.length > 0) {
      rationale.push(
        `SAFETY REFUSAL: proposed obs window [${obsStart}, ${obsEnd}] overlaps unsettled series obs window(s) [${overlapping
          .map((s) => `${s.obsStart}-${s.obsEnd}`)
          .join(", ")}] — no series this run.`,
      );
    } else {
      const strikeLowCents = Math.round(latest.cents);
      const strikeHighCents = strikeLowCents + cfg.BAND_CENTS;
      const sigmaEst = estimateMonthlySigmaCents(merged, cfg);
      const monthsToObsEnd = (obsEnd - now) / MONTH_SECONDS;
      const sigmaHorizon = sigmaEst.sigmaCents * Math.sqrt(monthsToObsEnd);
      const ecBps = expectedClaimBps(latest.cents, cfg.BAND_CENTS, sigmaHorizon);
      const rawPremium = Math.round((ecBps * cfg.LOADING_BPS) / BPS);
      const premiumRateBps = Math.min(cfg.PREMIUM_MAX_BPS, Math.max(cfg.PREMIUM_MIN_BPS, rawPremium));
      const capacityWei = targetFreeCapitalWei; // capacity fully backed by targeted free capital
      rationale.push(
        `Series pricing: sigmaMonthly=${sigmaEst.sigmaCents.toFixed(2)}c (${sigmaEst.source}, n=${sigmaEst.n}), horizon=${monthsToObsEnd.toFixed(2)}mo, sigmaHorizon=${sigmaHorizon.toFixed(2)}c, expectedClaim=${ecBps} bps, x1.25 loading=${rawPremium} bps => premium ${premiumRateBps} bps${
          premiumRateBps !== rawPremium ? " (CLAMPED)" : ""
        }.`,
      );

      const candidate = {
        strikeLowCents,
        strikeHighCents,
        premiumRateBps,
        saleEnd,
        obsStart,
        obsEnd,
        redeemEnd,
        capacityWei,
      };
      const errs = validateSeriesParams(candidate, now, cfg);
      if (errs.length > 0) {
        rationale.push(`SAFETY REFUSAL: series candidate failed validation: ${errs.join("; ")} — no series this run.`);
      } else {
        newSeries = candidate;
        rationale.push(
          `New series: strikes ${strikeLowCents}/${strikeHighCents}c, ${premiumRateBps} bps, sale->${saleEnd}, obs [${obsStart}, ${obsEnd}], redeem->${redeemEnd}, capacity ${capacityWei} wei.`,
        );
      }
    }
  }

  return {
    refused: false,
    targetFreeCapitalWei,
    capitalDeltaWei: delta,
    newSeries,
    pause,
    rationale,
  };
}
