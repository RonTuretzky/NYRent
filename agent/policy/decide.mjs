/**
 * decide.mjs — deterministic policy core for the NY Rent Cover market-maker agent.
 *
 * decide(signals, chainState, config) -> Plan is a PURE function: no I/O, no
 * clocks (time comes from chainState.nowSec), no randomness. Same inputs =>
 * byte-identical Plan. Everything the executor may do on-chain is derived here
 * and clamped here; the executor must never widen a plan.
 *
 * THE MANDATE — a two-sided market maker running a hold-to-settlement book on
 * the permissionless CoverPool (src/CoverPool.sol — NO roles, anyone escrows
 * capacity via createSeries):
 *   SELL side: underwrite the agent's own standard series — escrow + create,
 *     priced fair x 1.25 loading (policy/valuation.mjs).
 *   BUY side: arbitrage — buy cover on ANY open series whose quoted premium is
 *     below the model's fair value minus an edge threshold. This is both the
 *     profit engine and the market-balancing function.
 *   REDEEM side: realize the buy side — every settled holding with a positive
 *     payout ratio is redeemed before its redeemEnd (units × settled ratio is
 *     the only way premium spent ever comes back as payout).
 *   INVENTORY: net exposure = own-book SOLD exposure x E[ratio] minus
 *     PURCHASED cover held x E[ratio-of-that-series]; unsold capacity is
 *     uncommitted (cancellable), not short, and outsider-gifted soulbound
 *     cover never moves the lean. Managed by leaning the NEXT cycle's actions
 *     (all positions are soulbound and held to settlement — there is no
 *     unwind, only the next cycle's lean).
 *
 * Plan shape (the executor may narrow it, never widen it):
 *   {
 *     refused:   boolean            — true => do NOTHING on-chain
 *     newSeries: null | {           — SELL side, at most ONE per run
 *       strikeLowCents, strikeHighCents,      — uint32, cents of $/SF
 *       premiumRateBps,                       — uint16, clamped [500, 5000]
 *       saleEnd, obsStart, obsEnd, redeemEnd, — unix sec, saleEnd == obsStart
 *       capacityUnits                         — bigint, currency base units,
 *                                               escrowed from the agent wallet
 *     }
 *     buys: [{                      — BUY side (buyProtectionFor to self)
 *       seriesId, maxClaimUnits, maxPremiumUnits,   — bigints (units)
 *       edgeBps, fairRatioBps, quotedPremiumBps     — audit trail
 *     }]
 *     redeems: [{ seriesId, units }] — REDEEM side: settled holdings with
 *                                      payoutRatioWad > 0, before redeemEnd
 *     pauses:            [{ seriesId, paused }]  — OWN series only (blackout rule)
 *     withdrawResiduals: [seriesId]              — own series past redeemEnd
 *     cancels:           [seriesId]              — own UNSOLD series, stale shape
 *     inventory: { netExposureUnits, lean, edgeMinBps, premiumLeanBps } | null
 *     target: { chainId, pool, decidedAtBlock, wallet } | null
 *                — the stamp of WHERE and AS WHOM this plan was decided;
 *                  executors refuse a plan whose stamp mismatches their target
 *     rationale: string[]           — every decision, human-readable
 *   }
 *
 * CURRENCY UNITS: all capital math is in base units of the per-target currency
 * (Gnosis WXDAI 18 decimals, Arbitrum native USDC 6 decimals). config.decimals
 * parameterizes every clamp: "0.5 currency units" is 5e17 on Gnosis and 5e5 on
 * Arbitrum. Fields are named *Units, never *Wei.
 *
 * SAFETY CLAMPS (non-negotiable, unit-tested — every clamp of the old
 * sponsor-era policy survives, re-expressed for the permissionless pool):
 *   - per-run SELL capital (createSeries escrow) <= 0.5 currency units
 *     (MAX_SELL_ESCROW_MILLIUNITS — successor of the old 0.5 WXDAI capital-move cap)
 *   - per-run BUY notional (sum of maxClaimUnits) <= 0.5 currency units
 *     (MAX_BUY_NOTIONAL_MILLIUNITS — a SEPARATE clamp from the sell side)
 *   - per-series buy <= 25% of that series' remaining capacity (BUY_SERIES_CAP_BPS),
 *     CUMULATIVE across runs: existing holdings count against the cap
 *   - NEVER buy the agent's own series OR any series created by a known
 *     operator wallet (config.operatorWallets — the deployer and Bankr custody
 *     wallets are one economic operator; buying across them is self-dealing)
 *   - buys skip paused / sale-closed / settled / cancelled series; the WHOLE
 *     buy leg is refused when fair-value inputs are stale
 *   - own premium always in [500, 5000] bps (PREMIUM_MIN/MAX_BPS)
 *   - at most ONE newSeries per run (structural: single object or null)
 *   - never an obs window overlapping any of the agent's OWN unsettled series'
 *     obs windows; only one own live sale at a time
 *   - saleEnd <= obsStart ALWAYS (now also a contract invariant)
 *   - redeemEnd >= obsEnd + 7d (contract MIN_REDEEM_WINDOW)
 *   - all series timestamps strictly future and ordered (validateSeriesParams)
 *   - a scraped web print diverging > ±15% from the latest DKIM oracle
 *     observation can never anchor strikes or feed valuation (plausibility gate)
 *   - pauses/cancels/withdrawResiduals only ever name OWN series
 *   - refuse everything if the chain read failed or the agent identity is
 *     missing (plan.refused)
 */

import {
  VALUATION_DEFAULTS,
  estimateMonthlySigmaCents,
  expectedRatioBps,
  fairValue,
  normCdf,
  normPdf,
} from "./valuation.mjs";

const DAY = 86_400;
const BPS = 10_000;
const WAD = 10n ** 18n;

// Re-exported so tests and executors can share one math surface.
export { VALUATION_DEFAULTS, estimateMonthlySigmaCents, expectedRatioBps, normCdf, normPdf };

/**
 * Every policy constant, with meaning. Override via decide(..., config) —
 * unknown keys are ignored, missing keys fall back to these values.
 * Clamps denominated in currency are expressed in MILLIUNITS (thousandths of
 * one whole currency unit) and scaled by config.decimals, so the same config
 * means the same economics on WXDAI (18) and USDC (6).
 */
export const DEFAULT_CONFIG = {
  // -- currency ---------------------------------------------------------------
  decimals: 18, // Gnosis WXDAI; Arbitrum native USDC target overrides to 6

  // -- strike anchoring (SELL side) -------------------------------------------
  BAND_CENTS: 800, // strikeHigh - strikeLow, $8.00/SF (the standard series shape)

  // -- premium (SELL side) -----------------------------------------------------
  ...VALUATION_DEFAULTS, // LOADING_BPS 12500, SIGMA_FALLBACK_CENTS 150,
  //                        MIN_PRINTS_FOR_SIGMA 4, MAX_FUTURE_PRINT_SKEW_SEC 1d
  PREMIUM_MIN_BPS: 500, // 5% floor  — never sell protection for less
  PREMIUM_MAX_BPS: 5_000, // 50% cap — above this the product is not credible

  // -- capital (SELL side) -----------------------------------------------------
  DEPLOY_FRACTION_BPS: 8_000, // escrow up to 80% of the agent wallet balance
  STALE_AFTER_DAYS: 45, // no print within 45d => data is stale
  STALE_HEALTH_BPS: 5_000, // stale data halves the deployable capital
  KALSHI_STRESS_MAX_PROB: 0.35, // P(vacancy below strike) under this => vacancy stress
  KALSHI_STRESS_HEALTH_BPS: 5_000, // vacancy stress halves the deployable capital
  MAX_SELL_ESCROW_MILLIUNITS: 500, // 0.5 currency units — hard per-run createSeries escrow cap
  //   (successor of the sponsor-era MAX_CAPITAL_DELTA_WEI 0.5 WXDAI per-run cap)

  // -- BUY side (arbitrage) ----------------------------------------------------
  EDGE_MIN_BPS: 300, // buy only when quotedPremiumBps <= fairRatioBps - 300
  EDGE_FLOOR_BPS: 100, // a lean-relaxed edge threshold never drops below this
  BUY_SERIES_CAP_BPS: 2_500, // per-series cap: 25% of remaining capacity
  MAX_BUY_NOTIONAL_MILLIUNITS: 500, // 0.5 currency units — per-run total buy notional
  //   clamp (Σ maxClaimUnits), SEPARATE from the sell-side capital clamp

  // -- inventory lean ----------------------------------------------------------
  LEAN_BAND_MILLIUNITS: 100, // |netExposure| <= 0.1 currency units => balanced
  LEAN_PREMIUM_STEP_BPS: 100, // one premium step when leaning the sell side
  LEAN_EDGE_STEP_BPS: 100, // one edge step when leaning the buy side

  // -- pause (own series only; there is no global pause on-chain) --------------
  BLACKOUT_AFTER_DAYS: 60, // no print within 60d => pause own open sales
  allowUnpause: false, // NEVER auto-unpause unless explicitly enabled — a manual pause is respected

  // -- cancels (own unsold series with stale shape) -----------------------------
  CANCEL_STRIKE_DRIFT_CENTS: 800, // cancel own unsold series when the print has
  //   drifted a full band away from its strikeLow (its shape is stale)

  // -- series windows (production rule saleEnd == obsStart baked in) -----------
  SALE_DURATION_DAYS: 14, // sale runs [now, now+14d]
  OBS_DURATION_DAYS: 30, // observation window [saleEnd, saleEnd+30d]
  REDEEM_DURATION_DAYS: 30, // claim window [obsEnd, obsEnd+30d] (>= 7d contract min)
  MIN_REDEEM_WINDOW_DAYS: 7, // contract MIN_REDEEM_WINDOW — validated here too

  // -- data hygiene -------------------------------------------------------------
  WEB_PRINT_MAX_DIVERGENCE_BPS: 1_500, // web print may anchor only within ±15% of the latest DKIM oracle observation

  // -- operator wallets (self-dealing prevention) -------------------------------
  // Every wallet the operator controls, on EVERY target. The buy side never
  // buys a series created by any of these (the Gnosis book must not buy the
  // Arbitrum deployer-fallback wallet's series and vice versa), and the
  // one-own-live-sale / obs-window-overlap guards treat them as one book.
  operatorWallets: [
    "0x6636A1CCBdf54485067304C1a590DE016DeaD9F0", // deployer (Gnosis agent wallet + Arbitrum direct fallback)
    "0x1a7223bc942b053794e17b537e73d837cf695561", // BANKR_WALLET (Arbitrum custody)
    "0x6d06bf32f9002b5777e1ae6ab242fb6cdf31888a", // current Bankr POC wallet (credit-backed key)
  ],
};

// ---------------------------------------------------------------------------
// Unit helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** One whole currency unit in base units (10^decimals). */
export function unitScale(config = DEFAULT_CONFIG) {
  return 10n ** BigInt(config.decimals ?? DEFAULT_CONFIG.decimals);
}

/** milliunits (thousandths of a currency unit) -> base units. */
export function milliunitsToUnits(milli, config = DEFAULT_CONFIG) {
  return (BigInt(milli) * unitScale(config)) / 1000n;
}

/**
 * Dust threshold: 1e-5 of a currency unit (1e13 wei on 18 decimals, 10 base
 * units on 6) — actions smaller than this are not worth a transaction.
 */
export function dustUnits(config = DEFAULT_CONFIG) {
  const d = unitScale(config) / 100_000n;
  return d > 0n ? d : 1n;
}

/**
 * Final validation gate for an OWN series candidate. Returns [] when valid,
 * else a list of violations. Enforces saleEnd <= obsStart (contract invariant,
 * kept here as defense in depth) and the contract's 7-day MIN_REDEEM_WINDOW.
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
  if (Number.isInteger(c.obsEnd) && Number.isInteger(c.redeemEnd) && c.redeemEnd < c.obsEnd + cfg.MIN_REDEEM_WINDOW_DAYS * DAY)
    errs.push(`redeemEnd must be >= obsEnd + ${cfg.MIN_REDEEM_WINDOW_DAYS}d (contract MIN_REDEEM_WINDOW)`);
  if (typeof c.capacityUnits !== "bigint" || c.capacityUnits <= 0n || c.capacityUnits >= 2n ** 128n)
    errs.push("capacityUnits must be a bigint in (0, 2^128)");
  return errs;
}

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

function refusedPlan(rationale) {
  return {
    refused: true,
    newSeries: null,
    buys: [],
    redeems: [],
    pauses: [],
    withdrawResiduals: [],
    cancels: [],
    inventory: null,
    target: null,
    rationale,
  };
}

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const sameAddr = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

/** Normalize one market-scan series row (bigints in, Number timestamps). */
function normSeries(s) {
  return {
    id: Number(s.id),
    creator: s.creator,
    strikeLowCents: Number(s.strikeLowCents),
    strikeHighCents: Number(s.strikeHighCents),
    premiumRateBps: Number(s.premiumRateBps),
    saleEnd: Number(s.saleEnd),
    obsStart: Number(s.obsStart),
    obsEnd: Number(s.obsEnd),
    redeemEnd: Number(s.redeemEnd),
    escrowUnits: BigInt(s.escrowUnits ?? s.capacityUnits ?? s.capacityWei ?? 0),
    soldUnits: BigInt(s.soldUnits ?? s.soldWei ?? 0),
    paidOutUnits: BigInt(s.paidOutUnits ?? 0),
    settled: Boolean(s.settled),
    cancelled: Boolean(s.cancelled),
    paused: Boolean(s.paused),
    residualWithdrawn: Boolean(s.residualWithdrawn),
    payoutRatioWad: s.payoutRatioWad === undefined ? 0n : BigInt(s.payoutRatioWad),
  };
}

/**
 * @param {object} signals    collector output (see agent/README.md):
 *   { prints: [{t, cents, source}], kalshi: {probVacancyBelow, ...} | null }
 *   May be null/empty — the policy then leans on on-chain oracle prints alone.
 * @param {object} chainState from run.mjs readChainState(); must include:
 *   ok, nowSec,
 *   agent: { address, currencyUnits },       // the underwriting wallet
 *   series | marketScan: [ALL series on the pool] — each { id, creator,
 *     strikeLowCents, strikeHighCents, premiumRateBps, saleEnd, obsStart,
 *     obsEnd, redeemEnd, escrowUnits, soldUnits, settled, cancelled, paused,
 *     residualWithdrawn, payoutRatioWad },
 *   holdings: [{ seriesId, units }],          // agent's CoverToken balances
 *   oracle: { observations: [{t, cents}] }
 * @param {object} [config]   overrides merged over DEFAULT_CONFIG
 * @returns {object} Plan (see file header)
 */
export function decide(signals, chainState, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rationale = [];

  // -- SAFETY: refuse to act on a failed or absent chain read -----------------
  if (!chainState || chainState.ok !== true) {
    return refusedPlan([
      `REFUSE: chain state read failed (${chainState?.error ?? "chainState missing"}) — no on-chain action may be planned without a verified view of the pool.`,
    ]);
  }
  const now = Number(chainState.nowSec);
  if (!Number.isFinite(now) || now <= 0) {
    return refusedPlan(["REFUSE: chainState.nowSec is invalid — cannot reason about time."]);
  }
  // The agent's own identity gates EVERYTHING two-sided: without it we cannot
  // tell own series from the market (own-series exclusion on the buy side,
  // creator-only levers on the sell side) or size escrow from the wallet.
  if (!isAddress(chainState.agent?.address)) {
    return refusedPlan([
      "REFUSE: chainState.agent.address missing/invalid — cannot separate own series from the market (own-series buy exclusion and creator-only levers would be unsafe).",
    ]);
  }
  let walletUnits;
  try {
    walletUnits = BigInt(chainState.agent.currencyUnits);
    if (walletUnits < 0n) throw new Error("negative");
  } catch {
    return refusedPlan(["REFUSE: chainState.agent.currencyUnits missing/invalid — cannot size capital."]);
  }
  const me = chainState.agent.address;

  // -- 1. authoritative print merge (unchanged from the sponsor-era policy) ---
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
  // corroborate but never anchor strikes, never feed valuation, never count
  // toward freshness.
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
  // mis-contexted credaily page must not set strikes or fair values the book
  // trades against).
  const webPrints = [];
  for (const p of rawWebPrints.filter((p) => p.t !== null).filter(validPrint)) {
    if (latestOracle) {
      const divergenceBps = (Math.abs(p.cents - latestOracle.cents) * BPS) / latestOracle.cents;
      if (divergenceBps > cfg.WEB_PRINT_MAX_DIVERGENCE_BPS) {
        rationale.push(
          `PLAUSIBILITY REJECTION: web print ${p.cents}c diverges ${(divergenceBps / 100).toFixed(1)}% from the latest DKIM-verified oracle observation ${latestOracle.cents}c (> ${(cfg.WEB_PRINT_MAX_DIVERGENCE_BPS / 100).toFixed(0)}% band) — rejected; falling back to oracle prints.`,
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

  // -- 2. Kalshi vacancy stress (sell-side capital modifier only) --------------
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

  // -- 3. market scan split: own book vs the market ----------------------------
  // TWO notions of "own":
  //   own      — created by THIS identity (creator levers: pause/cancel/residual
  //              only make sense here; the contract enforces NotCreator anyway);
  //   ownBook  — created by ANY operator-controlled wallet (config.operatorWallets
  //              ∪ {me}): the buy-side exclusion, the one-live-sale rule and the
  //              obs-window-overlap refusal all treat the operator's wallets as
  //              ONE economic book, so the deployer and Bankr wallets can never
  //              trade against each other (self-dealing prevention).
  const operatorSet = new Set(
    [me, ...(Array.isArray(cfg.operatorWallets) ? cfg.operatorWallets : [])]
      .filter(isAddress)
      .map((a) => a.toLowerCase()),
  );
  const isOperator = (a) => isAddress(a) && operatorSet.has(a.toLowerCase());
  const scan = (chainState.marketScan ?? chainState.series ?? []).map(normSeries);
  const own = scan.filter((s) => sameAddr(s.creator, me));
  const ownBook = scan.filter((s) => isOperator(s.creator));
  const market = scan.filter((s) => !isOperator(s.creator));
  rationale.push(
    `Market scan: ${scan.length} series (${own.length} own, ${ownBook.length} operator-book incl. own, ${market.length} market; operator wallets: ${[...operatorSet].join(", ")}).`,
  );
  for (const s of ownBook) {
    if (!sameAddr(s.creator, me)) {
      rationale.push(
        `OPERATOR-WALLET EXCLUSION: series ${s.id} creator ${s.creator} is an operator wallet (not this run's identity) — never a buy candidate and counted into the one-book guards (self-dealing prevention).`,
      );
    }
  }

  // Fair value per series id (settled series are valued at their ACTUAL ratio).
  const fairSignals = { prints: merged };
  const fairOf = (s) => {
    if (s.settled) return Number((s.payoutRatioWad * BigInt(BPS)) / WAD);
    try {
      const fv = latest ? fairValue(s, fairSignals, now, cfg) : null;
      return fv === null ? null : fv.ratioBps;
    } catch {
      // Malformed scan row (inverted strikes/windows can't exist on-chain, but
      // a bad read must degrade to "unvaluable", never crash the policy).
      return null;
    }
  };

  // -- 4. own-series pauses (blackout rule; own series only — there is no
  //       global pause on the permissionless pool) ------------------------------
  const pauses = [];
  const ownSaleOpen = (s) => !s.settled && !s.cancelled && now <= s.saleEnd;
  if (blackout) {
    for (const s of own.filter((s) => ownSaleOpen(s) && !s.paused)) {
      pauses.push({ seriesId: s.id, paused: true });
      rationale.push(
        `PAUSE: data blackout (no print within ${cfg.BLACKOUT_AFTER_DAYS}d) — setSeriesPaused(${s.id}, true) on own open series.`,
      );
    }
    if (pauses.length === 0) rationale.push("Data blackout — no own open unpaused series to pause.");
  } else {
    const ownPaused = own.filter((s) => ownSaleOpen(s) && s.paused);
    for (const s of ownPaused) {
      // NEVER auto-unpause: the pause may be a deliberate manual action
      // (incident response). Unpausing requires the explicit allowUnpause opt-in.
      if (cfg.allowUnpause === true) {
        pauses.push({ seriesId: s.id, paused: false });
        rationale.push(`Data healthy — setSeriesPaused(${s.id}, false) to resume sales (allowUnpause=true).`);
      } else {
        rationale.push(
          `Own series ${s.id} is paused with healthy data — respecting the existing (possibly manual) pause; auto-unpause is disabled (config.allowUnpause=false).`,
        );
      }
    }
  }
  const pausedThisRun = new Set(pauses.filter((p) => p.paused).map((p) => p.seriesId));

  // -- 5. own residual withdrawals (matured series) -----------------------------
  const withdrawResiduals = [];
  for (const s of own) {
    if (s.cancelled || s.residualWithdrawn) continue;
    if (now > s.redeemEnd) {
      withdrawResiduals.push(s.id);
      rationale.push(`withdrawResidual(${s.id}): own series matured (redeemEnd ${s.redeemEnd} < now).`);
    }
  }

  // -- 5b. REDEEM: realize settled holdings before their redeem window closes ---
  //    Cover is soulbound and redeem is holder-only: without this leg every
  //    buy-side payout expires back to the counterparty's residual. Every
  //    settled holding with payoutRatioWad > 0 is redeemed while now <=
  //    redeemEnd (value = units × settled ratio). Staleness never blocks this:
  //    collecting a fixed settled payout has no valuation dependence.
  const byId = new Map(scan.map((s) => [s.id, s]));
  const redeems = [];
  for (const h of chainState.holdings ?? []) {
    const s = byId.get(Number(h.seriesId));
    const units = BigInt(h.units ?? 0);
    if (!s || units <= 0n) continue;
    if (!s.settled || s.cancelled) continue;
    if (now > s.redeemEnd) {
      rationale.push(
        `REALIZED LOSS: holding on series ${s.id} (${units} units, settled ratio ${s.payoutRatioWad}) expired unredeemed at redeemEnd ${s.redeemEnd} — value 0, payout forgone.`,
      );
      continue;
    }
    if (s.payoutRatioWad <= 0n) {
      rationale.push(`No redeem on series ${s.id}: settled at ratio 0 — nothing to collect.`);
      continue;
    }
    const valueUnits = (units * s.payoutRatioWad) / WAD;
    redeems.push({ seriesId: s.id, units });
    rationale.push(
      `REDEEM series ${s.id}: ${units} units held × settled ratio ${s.payoutRatioWad} wad = ${valueUnits} units payout (redeemEnd ${s.redeemEnd}).`,
    );
  }

  // -- 6. own cancels: unsold series whose shape has gone stale -----------------
  //    cancelSeries refunds the whole escrow but only while sold == 0 and the
  //    series is unsettled/uncancelled. Two deterministic "stale shape" triggers:
  //      a) the sale ended with nothing sold — the escrow is dead until
  //         redeemEnd unless cancelled now;
  //      b) a FRESH authoritative print has drifted >= CANCEL_STRIKE_DRIFT_CENTS
  //         from the series' strikeLow — the offered strikes no longer describe
  //         the market (no drift judgment is made on stale data).
  const cancels = [];
  for (const s of own) {
    if (s.cancelled || s.settled || s.residualWithdrawn || s.soldUnits !== 0n) continue;
    if (withdrawResiduals.includes(s.id)) continue; // matured path already exits
    if (now > s.saleEnd) {
      cancels.push(s.id);
      rationale.push(`cancelSeries(${s.id}): own series' sale ended unsold — reclaiming dead escrow.`);
    } else if (latest && !stale && Math.abs(s.strikeLowCents - latest.cents) >= cfg.CANCEL_STRIKE_DRIFT_CENTS) {
      cancels.push(s.id);
      rationale.push(
        `cancelSeries(${s.id}): own unsold series' strikeLow ${s.strikeLowCents}c drifted >= ${cfg.CANCEL_STRIKE_DRIFT_CENTS}c from the print ${latest.cents}c — stale shape.`,
      );
    }
  }
  const cancelledThisRun = new Set(cancels);

  // -- 7. inventory: net exposure and the lean -----------------------------------
  //    netExposureUnits = Σ own-book SOLD × fairRatio (settled: sold × actual
  //                       ratio − paidOut, floored at 0; extinguished past
  //                       redeemEnd)
  //                     − Σ PURCHASED held cover × fairRatio-of-that-series
  //    UNSOLD capacity is uncommitted (cancellable), not short — counting it
  //    made the book "shorter" the less it sold, which the short lean then
  //    priced UP, discouraging exactly the sales that shrink the imbalance.
  //    Held cover is valued 0 past redeemEnd and 0 for unsettled series whose
  //    obs window closed with no qualifying oracle observation. Only cover the
  //    agent actually BOUGHT counts (chainState.purchasedUnits, from the
  //    cumulative ProtectionBought(buyer=agent) event ledger); outsider-minted
  //    soulbound gifts are reported but never move the lean. When the ledger is
  //    absent (tests/proofs) all holdings count as purchased.
  let netExposureUnits = 0n;
  let inventoryComplete = true;
  for (const s of ownBook) {
    if (s.cancelled || cancelledThisRun.has(s.id)) continue;
    if (s.soldUnits <= 0n) continue;
    if (now > s.redeemEnd) continue; // liability extinguished — residual comes home
    if (s.settled) {
      let liability = (s.soldUnits * s.payoutRatioWad) / WAD - s.paidOutUnits;
      if (liability < 0n) liability = 0n;
      netExposureUnits += liability;
      continue;
    }
    const fair = fairOf(s);
    if (fair === null) {
      inventoryComplete = false;
      continue;
    }
    netExposureUnits += (s.soldUnits * BigInt(fair)) / BigInt(BPS);
  }
  const purchasedLedger =
    chainState.purchasedUnits === undefined || chainState.purchasedUnits === null
      ? null
      : chainState.purchasedUnits;
  const oracleObs = (chainState.oracle?.observations ?? []).map((o) => ({ t: Number(o.t) }));
  const hasQualifyingObs = (s) => oracleObs.some((o) => o.t >= s.obsStart && o.t <= s.obsEnd);
  let giftedUnitsTotal = 0n;
  for (const h of chainState.holdings ?? []) {
    const s = byId.get(Number(h.seriesId));
    const units = BigInt(h.units ?? 0);
    if (!s || units <= 0n) continue;
    let counted = units;
    if (purchasedLedger !== null) {
      const purchased = BigInt(purchasedLedger[String(s.id)] ?? purchasedLedger[s.id] ?? 0);
      counted = units < purchased ? units : purchased;
      const gifted = units - counted;
      if (gifted > 0n) {
        giftedUnitsTotal += gifted;
        rationale.push(
          `GIFTED COVER: ${gifted} of ${units} held units on series ${s.id} have no matching own-buy event — reported only, excluded from the inventory lean (an outsider must not steer the book).`,
        );
      }
    }
    if (counted <= 0n) continue;
    if (now > s.redeemEnd) {
      rationale.push(`Inventory: holding on series ${s.id} valued 0 — redeem window closed (redeemEnd ${s.redeemEnd}).`);
      continue;
    }
    if (!s.settled && now > s.obsEnd && !hasQualifyingObs(s)) {
      rationale.push(
        `Inventory: holding on series ${s.id} valued 0 — obs window closed with no qualifying oracle observation (can no longer settle in the money from live data).`,
      );
      continue;
    }
    const fair = fairOf(s);
    if (fair === null) {
      inventoryComplete = false;
      continue;
    }
    netExposureUnits -= (counted * BigInt(fair)) / BigInt(BPS);
  }

  const leanBand = milliunitsToUnits(cfg.LEAN_BAND_MILLIUNITS, cfg);
  let lean = "balanced";
  let premiumLeanBps = 0;
  let edgeMinBps = cfg.EDGE_MIN_BPS;
  if (netExposureUnits > leanBand) {
    // Net SHORT beyond the band: charge more for the next series (slow the sell
    // side down, get paid for the imbalance) and RELAX the buy edge one step so
    // the arb leg hedges the book faster.
    lean = "short";
    premiumLeanBps = cfg.LEAN_PREMIUM_STEP_BPS;
    edgeMinBps = Math.max(cfg.EDGE_FLOOR_BPS, cfg.EDGE_MIN_BPS - cfg.LEAN_EDGE_STEP_BPS);
  } else if (netExposureUnits < -leanBand) {
    // Net LONG beyond the band: tighten the buy edge one step and cheapen the
    // next series one step so the sell side re-balances the book.
    lean = "long";
    premiumLeanBps = -cfg.LEAN_PREMIUM_STEP_BPS;
    edgeMinBps = cfg.EDGE_MIN_BPS + cfg.LEAN_EDGE_STEP_BPS;
  }
  const inventory = { netExposureUnits, lean, edgeMinBps, premiumLeanBps };
  rationale.push(
    `Inventory: netExposure=${netExposureUnits} units, sold-based (${lean}${inventoryComplete ? "" : "; INCOMPLETE — some series unvaluable"}${giftedUnitsTotal > 0n ? `; ${giftedUnitsTotal} gifted units excluded` : ""}) — edgeMin=${edgeMinBps} bps, premiumLean=${premiumLeanBps >= 0 ? "+" : ""}${premiumLeanBps} bps.`,
  );

  // -- 8. SELL side: at most one new standard series ------------------------------
  // Structural clamp: at most one candidate is ever constructed per run.
  let newSeries = null;
  let sellEscrowUnits = 0n;
  // The one-live-sale and obs-overlap guards run against the whole OPERATOR
  // book (ownBook), not just this identity — series history spanning the
  // deployer and Bankr wallets must never void them.
  const ownUnsettled = ownBook.filter((s) => !s.settled && !s.cancelled && !cancelledThisRun.has(s.id));
  const dust = dustUnits(cfg);
  if (blackout) {
    rationale.push("No new series: data blackout.");
  } else if (stale) {
    rationale.push("No new series: print is stale — strikes cannot be anchored safely.");
  } else if (!latest) {
    rationale.push("No new series: no authoritative print to anchor strikes.");
  } else if (ownUnsettled.some((s) => s.saleEnd > now && !pausedThisRun.has(s.id))) {
    rationale.push(
      "No new series: an operator-book unsettled series is still in its sale window (one own live sale at a time, across all operator wallets).",
    );
  } else {
    const saleEnd = now + cfg.SALE_DURATION_DAYS * DAY;
    const obsStart = saleEnd; // production rule saleEnd <= obsStart, set equal
    const obsEnd = obsStart + cfg.OBS_DURATION_DAYS * DAY;
    const redeemEnd = obsEnd + cfg.REDEEM_DURATION_DAYS * DAY;

    // SAFETY: never overlap the obs window of ANY of our own unsettled series
    // (one exposure window at a time on the underwriting book — the market's
    // other creators are none of our business here).
    const overlapping = ownUnsettled.filter((s) => obsStart <= s.obsEnd && s.obsStart <= obsEnd);
    if (overlapping.length > 0) {
      rationale.push(
        `SAFETY REFUSAL: proposed obs window [${obsStart}, ${obsEnd}] overlaps own unsettled series obs window(s) [${overlapping
          .map((s) => `${s.obsStart}-${s.obsEnd}`)
          .join(", ")}] — no series this run.`,
      );
    } else {
      // Capital clamp: escrow = min(80% × wallet × health, 0.5 currency units).
      const deployable = (walletUnits * BigInt(cfg.DEPLOY_FRACTION_BPS) * BigInt(healthBps)) / (BigInt(BPS) * BigInt(BPS));
      const maxEscrow = milliunitsToUnits(cfg.MAX_SELL_ESCROW_MILLIUNITS, cfg);
      let capacityUnits = deployable;
      if (capacityUnits > maxEscrow) {
        rationale.push(
          `SAFETY CLAMP: deployable ${deployable} units > per-run sell escrow cap ${maxEscrow} — clamped.`,
        );
        capacityUnits = maxEscrow;
      }
      if (capacityUnits < dust) {
        rationale.push(`No new series: deployable capital ${capacityUnits} units is dust (< ${dust}).`);
      } else {
        const strikeLowCents = Math.round(latest.cents);
        const strikeHighCents = strikeLowCents + cfg.BAND_CENTS;
        const candidateWindows = { strikeLowCents, strikeHighCents, obsStart, obsEnd };
        const fv = fairValue(candidateWindows, fairSignals, now, cfg);
        // fv is non-null here: `latest` exists and feeds fairSignals.
        const rawPremium = fv.premiumBps + premiumLeanBps;
        const premiumRateBps = Math.min(cfg.PREMIUM_MAX_BPS, Math.max(cfg.PREMIUM_MIN_BPS, rawPremium));
        rationale.push(
          `Sell pricing: sigmaMonthly=${fv.sigmaMonthlyCents.toFixed(2)}c (${fv.sigmaSource}, n=${fv.sigmaN}), horizon=${fv.horizonMonths.toFixed(2)}mo (to obs midpoint), sigmaHorizon=${fv.sigmaHorizonCents.toFixed(2)}c, fairRatio=${fv.ratioBps} bps, x1.25 loading=${fv.premiumBps} bps, lean ${premiumLeanBps >= 0 ? "+" : ""}${premiumLeanBps} => premium ${premiumRateBps} bps${
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
          capacityUnits,
        };
        const errs = validateSeriesParams(candidate, now, cfg);
        if (errs.length > 0) {
          rationale.push(`SAFETY REFUSAL: series candidate failed validation: ${errs.join("; ")} — no series this run.`);
        } else {
          newSeries = candidate;
          sellEscrowUnits = capacityUnits;
          rationale.push(
            `New series: strikes ${strikeLowCents}/${strikeHighCents}c, ${premiumRateBps} bps, sale->${saleEnd}, obs [${obsStart}, ${obsEnd}], redeem->${redeemEnd}, capacity ${capacityUnits} units (escrowed from the agent wallet).`,
          );
        }
      }
    }
  }

  // -- 9. BUY side: arbitrage any open series priced below fair − edge ------------
  const buys = [];
  if (!latest || stale) {
    // Refuse the WHOLE buy leg on stale fair-value inputs: a fair value computed
    // off an old print is exactly the mispricing an adversary would sell us.
    rationale.push(
      `BUY LEG REFUSED: fair-value inputs are ${latest ? "stale" : "absent"} (latest print age ${latest ? ageDays.toFixed(1) + "d" : "n/a"} > ${cfg.STALE_AFTER_DAYS}d) — no buys this run.`,
    );
  } else {
    let notionalBudget = milliunitsToUnits(cfg.MAX_BUY_NOTIONAL_MILLIUNITS, cfg);
    let premiumBudget = walletUnits - sellEscrowUnits; // buys never eat the sell escrow
    if (premiumBudget < 0n) premiumBudget = 0n;

    // Candidates: NEVER our own series and NEVER any operator wallet's series
    // (market already excludes the whole operator set — structural); skip
    // paused, sale-closed, settled and cancelled series; only unsold capacity
    // counts; series already held at/above their per-series cap are skipped
    // (idempotence: a re-run or the next daily run must not stack unbounded
    // exposure onto one counterparty).
    const heldUnitsBySeries = new Map(
      (chainState.holdings ?? []).map((h) => [Number(h.seriesId), BigInt(h.units ?? 0)]),
    );
    const candidates = [];
    for (const s of market) {
      if (s.settled || s.cancelled || s.paused) continue;
      if (now > s.saleEnd) continue;
      const capacityLeft = s.escrowUnits - s.soldUnits;
      if (capacityLeft <= 0n) continue;
      const fair = fairOf(s);
      if (fair === null) continue;
      const quoted = s.premiumRateBps;
      const edge = fair - quoted;
      if (quoted > fair - edgeMinBps) continue; // not cheap enough
      const held = heldUnitsBySeries.get(s.id) ?? 0n;
      const perSeriesCap = (capacityLeft * BigInt(cfg.BUY_SERIES_CAP_BPS)) / BigInt(BPS);
      if (held >= perSeriesCap) {
        rationale.push(
          `Skip buy on series ${s.id}: already hold ${held} units >= per-series cap ${perSeriesCap} (cumulative exposure bound across runs).`,
        );
        continue;
      }
      candidates.push({ s, capacityLeft, fair, quoted, edge, held, perSeriesCap });
    }
    // Deterministic order: best edge first, series id as tie-break.
    candidates.sort((a, b) => b.edge - a.edge || a.s.id - b.s.id);

    for (const c of candidates) {
      if (notionalBudget <= 0n) {
        rationale.push(
          `SAFETY CLAMP: per-run buy notional budget exhausted — skipping series ${c.s.id} (edge ${c.edge} bps).`,
        );
        continue;
      }
      // Caps, in binding order: per-series 25% cap NET of units already held
      // (cumulative across runs), then the per-run total notional clamp, then
      // premium affordability from the remaining wallet.
      let size = c.perSeriesCap - c.held;
      if (c.held > 0n) {
        rationale.push(
          `Buy on series ${c.s.id} sized net of ${c.held} units already held (cap headroom ${size}).`,
        );
      }
      if (size > notionalBudget) size = notionalBudget;
      const rate = BigInt(c.quoted);
      if (rate > 0n) {
        const affordable = (premiumBudget * BigInt(BPS)) / rate;
        if (size > affordable) {
          size = affordable;
          if (size > 0n)
            rationale.push(`Buy on series ${c.s.id} truncated by wallet premium budget (${premiumBudget} units left).`);
        }
      }
      if (size < dust) {
        rationale.push(`Skip buy on series ${c.s.id}: sized ${size} units is dust (< ${dust}).`);
        continue;
      }
      const premium = (size * rate) / BigInt(BPS); // contract: floor(maxClaim × rate / 1e4)
      if (rate > 0n && premium === 0n) {
        rationale.push(`Skip buy on series ${c.s.id}: premium rounds to zero (contract PremiumRoundsToZero).`);
        continue;
      }
      buys.push({
        seriesId: c.s.id,
        maxClaimUnits: size,
        maxPremiumUnits: premium,
        edgeBps: c.edge,
        fairRatioBps: c.fair,
        quotedPremiumBps: c.quoted,
      });
      notionalBudget -= size;
      premiumBudget -= premium;
      rationale.push(
        `BUY series ${c.s.id}: fair ${c.fair} bps vs quoted ${c.quoted} bps (edge ${c.edge} >= ${edgeMinBps}) — maxClaim ${size} units, maxPremium ${premium} units.`,
      );
    }
    if (buys.length === 0 && candidates.length === 0) {
      rationale.push(`No buys: no open non-own series priced <= fair − ${edgeMinBps} bps.`);
    }
  }

  // -- 10. target stamp: WHERE and AS WHOM this plan was decided ----------------
  // Executors refuse a plan whose stamp mismatches their live chainId / pool /
  // executing wallet — a plan can never replay onto the wrong chain, the wrong
  // pool or from a wallet it was not sized for. Absent fields (test fixtures,
  // hand-crafted plans) leave the stamp null; the executor notes the gap.
  const chainIdNum = Number(chainState.chainId);
  const target =
    Number.isFinite(chainIdNum) && chainIdNum > 0 && isAddress(chainState.pool)
      ? {
          chainId: chainIdNum,
          pool: chainState.pool,
          decidedAtBlock:
            chainState.blockNumber === undefined || chainState.blockNumber === null
              ? null
              : Number(chainState.blockNumber),
          wallet: me,
        }
      : null;

  return {
    refused: false,
    newSeries,
    buys,
    redeems,
    pauses,
    withdrawResiduals,
    cancels,
    inventory,
    target,
    rationale,
  };
}
