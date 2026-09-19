/**
 * Unit tests for direct.mjs's pure Plan → tx-diff computation (Option B: the
 * permissionless CoverPool, two-sided plans). Fake chain-state fixtures only —
 * no network, no clients. The real-chain proof lives in fork-proof.mjs.
 *
 * Laws under test:
 *   - ordering: pause(true) FIRST, unpause LAST, money in the middle
 *   - hard per-run caps re-derived from LIVE decimals (escrow / buy notional)
 *   - buy legs narrowed to live capacity, dropped when stale — never widened
 *   - creator levers checked against live creator/flags
 *   - balance refusal: escrow + Σ premiums must fit the wallet
 *   - exact-approve running-allowance simulation (per pulling tx)
 *   - the decimals matrix: identical numbers mean 1e12× different value at
 *     6 vs 18 decimals, and the caps move with the LIVE token decimals
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";
import { computeTxDiff, validatePlan, computeBudget, PlanError } from "./direct.mjs";
import { TARGETS } from "./targets.mjs";
import { DEFAULT_CONFIG } from "../policy/decide.mjs";

const ADDR = TARGETS.gnosis.addresses;
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const NOW = 1_790_000_000;
const DAY = 86_400;

/** A live OPEN market series by OTHER (buyable). */
function marketRow(over = {}) {
  return {
    creator: OTHER,
    premiumRateBps: 1_000, // 10%
    settled: false,
    cancelled: false,
    paused: false,
    saleEnd: NOW + 7 * DAY,
    redeemEnd: NOW + 60 * DAY,
    escrowUnits: parseUnits("1", 18),
    soldUnits: 0n,
    residualWithdrawn: false,
    ...over,
  };
}

/** A live series WE created (levers apply). */
function ownRow(over = {}) {
  return marketRow({ creator: ME, ...over });
}

function mkState(over = {}) {
  return {
    address: ME,
    nowSec: NOW,
    decimals: 18,
    nativeWei: parseUnits("1", 18),
    currencyUnits: parseUnits("10", 18),
    allowanceUnits: 0n,
    seriesCount: Object.keys(over.seriesById ?? {}).length,
    seriesById: {},
    ...over,
  };
}

const VALID_SERIES = {
  strikeLowCents: 9288,
  strikeHighCents: 10088,
  premiumRateBps: 1_133,
  saleEnd: NOW + 14 * DAY,
  obsStart: NOW + 14 * DAY,
  obsEnd: NOW + 44 * DAY,
  redeemEnd: NOW + 74 * DAY,
  capacityUnits: parseUnits("0.4", 18),
};

const names = (d) => d.txs.map((t) => t.functionName);
const diff = (plan, state, config) => computeTxDiff(plan, state, { addresses: ADDR, config });

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

test("validatePlan: refused plan short-circuits to no actions", () => {
  const p = validatePlan({ refused: true, rationale: ["stale"] });
  assert.equal(p.refused, true);
  assert.equal(p.newSeries, null);
  assert.deepEqual(p.buys, []);
});

test("validatePlan: capacity aliases (capacityUnits | capacity | capacityWei) all coerce", () => {
  for (const key of ["capacityUnits", "capacity", "capacityWei"]) {
    const { capacityUnits, ...rest } = VALID_SERIES;
    const p = validatePlan({ newSeries: { ...rest, [key]: "400000000000000000" } });
    assert.equal(p.newSeries.capacity, 400_000_000_000_000_000n, key);
  }
});

test("validatePlan: buy-leg aliases and coercions", () => {
  const p = validatePlan({ buys: [{ seriesId: 3n, maxClaimUnits: "1000", maxPremiumUnits: 100 }] });
  assert.deepEqual(p.buys, [{ seriesId: 3, maxClaim: 1000n, maxPremium: 100n }]);
  const q = validatePlan({ buys: [{ seriesId: 1, maxClaim: 500n, maxPremium: "50" }] });
  assert.equal(q.buys[0].maxClaim, 500n);
});

test("validatePlan: contract invariants rejected locally (never on-chain)", () => {
  const bad = [
    { ...VALID_SERIES, strikeLowCents: 10088, strikeHighCents: 9288 }, // inverted
    { ...VALID_SERIES, strikeLowCents: 0 }, // zero strike
    { ...VALID_SERIES, saleEnd: VALID_SERIES.obsStart + 1 }, // saleEnd > obsStart (contract rule!)
    { ...VALID_SERIES, obsStart: VALID_SERIES.obsEnd }, // obsStart !< obsEnd
    { ...VALID_SERIES, redeemEnd: VALID_SERIES.obsEnd + 6 * DAY }, // < 7d claim window
    { ...VALID_SERIES, capacityUnits: 0n }, // zero capacity
    { ...VALID_SERIES, premiumRateBps: 10_001 }, // >100% premium
  ];
  for (const s of bad) assert.throws(() => validatePlan({ newSeries: s }), PlanError, JSON.stringify(s, (_, v) => String(v)));
  assert.throws(() => validatePlan({ buys: [{ seriesId: 0, maxClaimUnits: 0n, maxPremiumUnits: 0n }] }), PlanError);
  assert.throws(() => validatePlan({ pauses: [{ seriesId: 0, paused: "yes" }] }), PlanError);
  assert.throws(() => validatePlan(null), PlanError);
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test("full two-sided plan ordering: pause(true) FIRST → cancel → residual → approve+create → approve+buy → unpause LAST", () => {
  const state = mkState({
    seriesById: {
      0: ownRow({ paused: false }), // to pause
      1: ownRow({ paused: true, saleEnd: NOW - DAY }), // to unpause
      2: ownRow({ soldUnits: 0n }), // to cancel
      3: ownRow({ redeemEnd: NOW - 1 }), // matured — residual
      4: marketRow(), // to buy
    },
  });
  const d = diff(
    {
      newSeries: VALID_SERIES,
      buys: [{ seriesId: 4, maxClaimUnits: parseUnits("0.2", 18), maxPremiumUnits: parseUnits("0.02", 18) }],
      pauses: [
        { seriesId: 0, paused: true },
        { seriesId: 1, paused: false },
      ],
      cancels: [2],
      withdrawResiduals: [3],
      rationale: ["test"],
    },
    state,
  );
  assert.deepEqual(names(d), [
    "setSeriesPaused", // (0, true) — safety first
    "cancelSeries",
    "withdrawResidual",
    "approve", // exact escrow
    "createSeries",
    "approve", // exact premium
    "buyProtection",
    "setSeriesPaused", // (1, false) — unpause very last
  ]);
  assert.deepEqual(d.txs[0].args, [0n, true]);
  assert.deepEqual(d.txs.at(-1).args, [1n, false]);
  // escrow!: createSeries pulls the capacity; the approve directly before it is exact
  assert.deepEqual(d.txs[3].args, [ADDR.pool, VALID_SERIES.capacityUnits]);
  assert.equal(d.txs[4].args[7], VALID_SERIES.capacityUnits);
  // buy leg: maxPremium arg = exact live quote (0.2 × 10%)
  assert.deepEqual(d.txs[6].args, [4n, parseUnits("0.2", 18), parseUnits("0.02", 18)]);
  assert.deepEqual(d.budget, {
    escrowUnits: VALID_SERIES.capacityUnits,
    premiumUnits: parseUnits("0.02", 18),
    totalPullUnits: VALID_SERIES.capacityUnits + parseUnits("0.02", 18),
  });
});

// ---------------------------------------------------------------------------
// hard per-run caps (re-derived from LIVE decimals — refuse, never trim)
// ---------------------------------------------------------------------------

test("sell-escrow cap: capacity beyond 0.5 units refuses the whole batch (18 and 6 decimals)", () => {
  // 18 decimals: 0.6 WXDAI > 0.5 cap
  assert.throws(
    () => diff({ newSeries: { ...VALID_SERIES, capacityUnits: parseUnits("0.6", 18) } }, mkState()),
    /sell-escrow cap/,
  );
  // 6 decimals: 0.6 USDC (600000) > 500000 cap — SAME economics, 1e12 smaller number
  assert.throws(
    () =>
      diff(
        { newSeries: { ...VALID_SERIES, capacityUnits: 600_000n } },
        mkState({ decimals: 6, currencyUnits: 2_000_000n }),
      ),
    /sell-escrow cap/,
  );
  // and 600000 base units at 18 decimals is DUST — dropped, not refused
  const d = diff({ newSeries: { ...VALID_SERIES, capacityUnits: 600_000n } }, mkState());
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("dust")));
});

test("buy-notional cap: Σ authorized maxClaim beyond 0.5 units refuses outright", () => {
  const state = mkState({ seriesById: { 0: marketRow(), 1: marketRow() } });
  const legs = [
    { seriesId: 0, maxClaimUnits: parseUnits("0.3", 18), maxPremiumUnits: parseUnits("0.03", 18) },
    { seriesId: 1, maxClaimUnits: parseUnits("0.21", 18), maxPremiumUnits: parseUnits("0.021", 18) },
  ];
  assert.throws(() => diff({ buys: legs }, state), /buy-notional cap/);
  // at 6 decimals the cap is 500000 base units
  const state6 = mkState({
    decimals: 6,
    currencyUnits: 2_000_000n,
    seriesById: { 0: marketRow({ escrowUnits: 1_000_000n }) },
  });
  assert.throws(
    () => diff({ buys: [{ seriesId: 0, maxClaimUnits: 600_000n, maxPremiumUnits: 60_000n }] }, state6),
    /buy-notional cap/,
  );
  const ok6 = diff({ buys: [{ seriesId: 0, maxClaimUnits: 400_000n, maxPremiumUnits: 40_000n }] }, state6);
  assert.deepEqual(names(ok6), ["approve", "buyProtection"]);
  assert.deepEqual(ok6.txs[1].args, [0n, 400_000n, 40_000n]);
});

// ---------------------------------------------------------------------------
// buy-leg live re-checks: narrow / drop, never widen
// ---------------------------------------------------------------------------

test("buy leg narrows to live unsold capacity with an EXECUTION CLAMP note; premium recomputed", () => {
  const state = mkState({
    seriesById: { 0: marketRow({ escrowUnits: parseUnits("0.5", 18), soldUnits: parseUnits("0.4", 18) }) },
  });
  const d = diff(
    { buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.3", 18), maxPremiumUnits: parseUnits("0.03", 18) }] },
    state,
  );
  assert.deepEqual(names(d), ["approve", "buyProtection"]);
  // narrowed to 0.1 live capacity; premium = 0.1 × 10% = 0.01
  assert.deepEqual(d.txs[1].args, [0n, parseUnits("0.1", 18), parseUnits("0.01", 18)]);
  assert.ok(d.notes.some((n) => n.includes("EXECUTION CLAMP")));
});

test("buy legs dropped when the series went stale (settled/cancelled/paused/sale-closed/unknown/own)", () => {
  const buys = (id) => [{ seriesId: id, maxClaimUnits: parseUnits("0.1", 18), maxPremiumUnits: parseUnits("0.01", 18) }];
  const cases = [
    [marketRow({ settled: true }), /settled/],
    [marketRow({ cancelled: true }), /settled\/cancelled/],
    [marketRow({ paused: true }), /paused/],
    [marketRow({ saleEnd: NOW - 1 }), /SaleClosed/],
    [ownRow(), /own series/],
  ];
  for (const [row, re] of cases) {
    const d = diff({ buys: buys(0) }, mkState({ seriesById: { 0: row } }));
    assert.equal(d.txs.length, 0, re);
    assert.ok(d.notes.some((n) => re.test(n)), `${re} in ${d.notes}`);
  }
  // unknown id
  const d = diff({ buys: buys(9) }, mkState({ seriesById: {} }));
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("not in live state")));
});

test("buy leg dropped when the live premium exceeds the plan's authorized maxPremium (never pay more)", () => {
  // policy authorized 1% but the live series rate is 10%
  const d = diff(
    { buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.1", 18), maxPremiumUnits: parseUnits("0.001", 18) }] },
    mkState({ seriesById: { 0: marketRow({ premiumRateBps: 1_000 }) } }),
  );
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("exceeds the plan's authorized maxPremium")));
});

test("buy leg dropped when the premium rounds to zero (PremiumRoundsToZero) or narrows to dust", () => {
  // 6 decimals: dust floor is 10 base units; claim 10 at 900 bps → premium 0
  const state6 = mkState({
    decimals: 6,
    currencyUnits: 1_000_000n,
    seriesById: { 0: marketRow({ escrowUnits: 1_000_000n, premiumRateBps: 900 }) },
  });
  const d = diff({ buys: [{ seriesId: 0, maxClaimUnits: 10n, maxPremiumUnits: 10n }] }, state6);
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("PremiumRoundsToZero")));
  // narrow-to-dust: live capacity 5 base units < dust 10
  const d2 = diff(
    { buys: [{ seriesId: 0, maxClaimUnits: 1_000n, maxPremiumUnits: 100n }] },
    mkState({ decimals: 6, currencyUnits: 1_000_000n, seriesById: { 0: marketRow({ escrowUnits: 5n }) } }),
  );
  assert.equal(d2.txs.length, 0);
  assert.ok(d2.notes.some((n) => n.includes("dust")));
});

// ---------------------------------------------------------------------------
// balance refusal — escrow + Σ premiums must fit the wallet
// ---------------------------------------------------------------------------

test("REFUSE when wallet balance < escrow + Σ buy premiums", () => {
  const state = mkState({
    currencyUnits: parseUnits("0.41", 18), // escrow 0.4 + premium 0.02 = 0.42 needed
    seriesById: { 0: marketRow() },
  });
  assert.throws(
    () =>
      diff(
        {
          newSeries: VALID_SERIES,
          buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.2", 18), maxPremiumUnits: parseUnits("0.02", 18) }],
        },
        state,
      ),
    /balance .* < escrow/,
  );
  // exactly enough passes
  const ok = diff(
    {
      newSeries: VALID_SERIES,
      buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.2", 18), maxPremiumUnits: parseUnits("0.02", 18) }],
    },
    mkState({ currencyUnits: parseUnits("0.42", 18), seriesById: { 0: marketRow() } }),
  );
  assert.equal(ok.budget.totalPullUnits, parseUnits("0.42", 18));
});

// ---------------------------------------------------------------------------
// exact approvals — running-allowance simulation
// ---------------------------------------------------------------------------

test("allowance covering ALL pulls -> zero approvals; covering only the escrow -> approve before the buy only", () => {
  const escrow = VALID_SERIES.capacityUnits; // 0.4
  const premium = parseUnits("0.02", 18);
  const base = { newSeries: VALID_SERIES, buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.2", 18), maxPremiumUnits: premium }] };
  const full = diff(base, mkState({ allowanceUnits: escrow + premium, seriesById: { 0: marketRow() } }));
  assert.deepEqual(names(full), ["createSeries", "buyProtection"]);
  const partial = diff(base, mkState({ allowanceUnits: escrow, seriesById: { 0: marketRow() } }));
  assert.deepEqual(names(partial), ["createSeries", "approve", "buyProtection"]);
  assert.deepEqual(partial.txs[1].args, [ADDR.pool, premium]); // exact premium approve
});

test("each approve is EXACT for its pull (escrow, then each buy premium)", () => {
  const state = mkState({ seriesById: { 0: marketRow(), 1: marketRow({ premiumRateBps: 2_000 }) } });
  const d = diff(
    {
      newSeries: VALID_SERIES,
      buys: [
        { seriesId: 0, maxClaimUnits: parseUnits("0.2", 18), maxPremiumUnits: parseUnits("0.02", 18) },
        { seriesId: 1, maxClaimUnits: parseUnits("0.1", 18), maxPremiumUnits: parseUnits("0.02", 18) },
      ],
    },
    state,
  );
  assert.deepEqual(names(d), ["approve", "createSeries", "approve", "buyProtection", "approve", "buyProtection"]);
  assert.deepEqual(d.txs[0].args, [ADDR.pool, VALID_SERIES.capacityUnits]);
  assert.deepEqual(d.txs[2].args, [ADDR.pool, parseUnits("0.02", 18)]); // 0.2 × 10%
  assert.deepEqual(d.txs[4].args, [ADDR.pool, parseUnits("0.02", 18)]); // 0.1 × 20%
});

// ---------------------------------------------------------------------------
// creator levers — live creator/flag checks
// ---------------------------------------------------------------------------

test("creator levers dropped when live state says they'd revert", () => {
  const state = mkState({
    seriesById: {
      0: marketRow(), // NOT ours — every lever drops
      1: ownRow({ soldUnits: 1_000n }), // sold since decide — cancel drops
      2: ownRow({ redeemEnd: NOW + DAY }), // window open — residual drops
      3: ownRow({ paused: true }), // already paused — pause(true) no-ops
      4: ownRow({ residualWithdrawn: true, redeemEnd: NOW - 1 }), // one-shot spent
    },
  });
  const d = diff(
    {
      pauses: [
        { seriesId: 0, paused: true },
        { seriesId: 3, paused: true },
      ],
      cancels: [0, 1],
      withdrawResiduals: [0, 2, 4],
    },
    state,
  );
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("setSeriesPaused(0) dropped: live creator")));
  assert.ok(d.notes.some((n) => n.includes("cancelSeries(1) dropped") && n.includes("AlreadySold")));
  assert.ok(d.notes.some((n) => n.includes("withdrawResidual(2) dropped") && n.includes("RedeemWindowOpen")));
  assert.ok(d.notes.some((n) => n.includes("withdrawResidual(4) dropped")));
  assert.ok(d.notes.some((n) => n.includes("setSeriesPaused(3) dropped: already paused=true")));
});

test("stale createSeries (saleEnd behind the live block) is dropped, not sent", () => {
  const d = diff({ newSeries: { ...VALID_SERIES, saleEnd: NOW - 1, obsStart: NOW - 1 } }, mkState());
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("stale plan")));
});

test("refused plan and malformed state fail safe", () => {
  const d = diff({ refused: true, rationale: ["chain read failed"] }, mkState());
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("refused")));
  assert.throws(() => diff({ pauses: [] }, { ...mkState(), currencyUnits: 5 }), PlanError);
  assert.throws(() => diff({ pauses: [] }, { ...mkState(), decimals: "18" }), PlanError);
  assert.throws(() => diff({ pauses: [] }, { ...mkState(), address: "not-an-address" }), PlanError);
});

// ---------------------------------------------------------------------------
// plan stamp — cross-target / cross-identity refusal
// ---------------------------------------------------------------------------

test("plan stamp: chainId / pool / wallet mismatches each REFUSE the batch; a matching stamp passes", () => {
  const stamped = (target) => ({ pauses: [], target });
  const state = mkState({ chainId: 100 });
  // full match passes
  const ok = diff(stamped({ chainId: 100, pool: ADDR.pool, wallet: ME, decidedAtBlock: 5 }), state);
  assert.equal(ok.txs.length, 0);
  // wrong chain
  assert.throws(() => diff(stamped({ chainId: 42161 }), state), /cross-target/);
  // wrong pool
  assert.throws(() => diff(stamped({ pool: "0x9999999999999999999999999999999999999999" }), state), /cross-pool/);
  // wrong wallet — a plan sized for one wallet must never execute from another
  assert.throws(() => diff(stamped({ wallet: OTHER }), state), /decided for wallet/);
  // pool match is case-insensitive
  const okCase = diff(stamped({ pool: ADDR.pool.toLowerCase(), wallet: ME.toLowerCase() }), state);
  assert.equal(okCase.txs.length, 0);
});

test("plan stamp: unstamped plans pass with a note; stamp checks skip when live state lacks chainId", () => {
  const d = diff({ pauses: [] }, mkState());
  assert.ok(d.notes.some((n) => n.includes("no target stamp")));
  // stamped chainId but fixture state has none -> the chainId check is skipped, pool/wallet still checked
  const d2 = diff({ pauses: [], target: { chainId: 42161, pool: ADDR.pool, wallet: ME } }, mkState());
  assert.equal(d2.txs.length, 0);
});

// ---------------------------------------------------------------------------
// redeem — the profit-realization leg
// ---------------------------------------------------------------------------

test("redeem: builds redeem(seriesId, units) for settled holdings, ordered before the money legs", () => {
  const WAD = 10n ** 18n;
  const state = mkState({
    seriesById: {
      0: marketRow({ settled: true, payoutRatioWad: WAD / 2n, redeemEnd: NOW + 5 * DAY, holdingUnits: parseUnits("0.2", 18) }),
      1: marketRow(), // to buy
    },
  });
  const d = diff(
    {
      newSeries: VALID_SERIES,
      redeems: [{ seriesId: 0, units: parseUnits("0.2", 18) }],
      buys: [{ seriesId: 1, maxClaimUnits: parseUnits("0.1", 18), maxPremiumUnits: parseUnits("0.01", 18) }],
    },
    state,
  );
  assert.deepEqual(names(d), ["redeem", "approve", "createSeries", "approve", "buyProtection"]);
  assert.deepEqual(d.txs[0].args, [0n, parseUnits("0.2", 18)]);
});

test("redeem: dropped when unsettled (NotSettled), window closed (RedeemWindowClosed), ratio 0, or cancelled", () => {
  const WAD = 10n ** 18n;
  const state = mkState({
    seriesById: {
      0: marketRow({ settled: false }),
      1: marketRow({ settled: true, payoutRatioWad: WAD, redeemEnd: NOW - 1 }),
      2: marketRow({ settled: true, payoutRatioWad: 0n, redeemEnd: NOW + DAY }),
      3: marketRow({ settled: true, cancelled: true, payoutRatioWad: WAD, redeemEnd: NOW + DAY }),
    },
  });
  const units = parseUnits("0.1", 18);
  const d = diff({ redeems: [0, 1, 2, 3].map((seriesId) => ({ seriesId, units })) }, state);
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("NotSettled")));
  assert.ok(d.notes.some((n) => n.includes("RedeemWindowClosed")));
  assert.ok(d.notes.some((n) => n.includes("ratio 0")));
  assert.ok(d.notes.some((n) => n.includes("cancelled")));
});

test("redeem: narrowed to LIVE holdings (never widened); dropped when nothing is held", () => {
  const WAD = 10n ** 18n;
  const row = (holdingUnits) => marketRow({ settled: true, payoutRatioWad: WAD, redeemEnd: NOW + DAY, holdingUnits });
  const d = diff(
    { redeems: [{ seriesId: 0, units: parseUnits("0.5", 18) }] },
    mkState({ seriesById: { 0: row(parseUnits("0.2", 18)) } }),
  );
  assert.deepEqual(names(d), ["redeem"]);
  assert.deepEqual(d.txs[0].args, [0n, parseUnits("0.2", 18)]);
  assert.ok(d.notes.some((n) => n.includes("EXECUTION CLAMP")));
  const empty = diff({ redeems: [{ seriesId: 0, units: parseUnits("0.5", 18) }] }, mkState({ seriesById: { 0: row(0n) } }));
  assert.equal(empty.txs.length, 0);
  assert.ok(empty.notes.some((n) => n.includes("no live holdings")));
});

test("validatePlan: redeems parse with alias coercion and reject zero units", () => {
  const p = validatePlan({ redeems: [{ seriesId: 2n, units: "1000" }, { seriesId: 3, amount: 5 }] });
  assert.deepEqual(p.redeems, [
    { seriesId: 2, units: 1000n },
    { seriesId: 3, units: 5n },
  ]);
  assert.throws(() => validatePlan({ redeems: [{ seriesId: 0, units: 0n }] }), PlanError);
  assert.throws(() => validatePlan({ redeems: "nope" }), PlanError);
});

// ---------------------------------------------------------------------------
// re-run idempotence — sell-leg duplicate guard + buy-leg holdings guard
// ---------------------------------------------------------------------------

test("createSeries dropped when an own OPEN series with the SAME strikes+obs window already exists live", () => {
  const dupRow = ownRow({
    strikeLowCents: Number(VALID_SERIES.strikeLowCents),
    strikeHighCents: Number(VALID_SERIES.strikeHighCents),
    saleEnd: Number(VALID_SERIES.saleEnd),
    obsStart: Number(VALID_SERIES.obsStart),
    obsEnd: Number(VALID_SERIES.obsEnd),
  });
  const d = diff({ newSeries: VALID_SERIES }, mkState({ seriesById: { 0: dupRow } }));
  assert.equal(d.txs.length, 0, "a partial re-run must never double-escrow");
  assert.ok(d.notes.some((n) => n.includes("re-run protection")));
  // different obs window (a genuinely new series) still creates
  const other = { ...dupRow, obsStart: Number(VALID_SERIES.obsStart) + DAY, obsEnd: Number(VALID_SERIES.obsEnd) + DAY };
  const d2 = diff({ newSeries: VALID_SERIES }, mkState({ seriesById: { 0: other } }));
  assert.deepEqual(names(d2), ["approve", "createSeries"]);
  // an OTHER OPERATOR WALLET's identical open series blocks too (one book)
  const opRow = { ...dupRow, creator: DEFAULT_CONFIG.operatorWallets[0] };
  const d3 = diff({ newSeries: VALID_SERIES }, mkState({ seriesById: { 0: opRow } }));
  assert.equal(d3.txs.length, 0);
  // closed-sale / settled duplicates do not block a fresh series
  const closed = { ...dupRow, saleEnd: NOW - 1 };
  const d4 = diff({ newSeries: VALID_SERIES }, mkState({ seriesById: { 0: closed } }));
  assert.deepEqual(names(d4), ["approve", "createSeries"]);
});

test("buy leg: live holdings count against the per-series cap (re-run drops or narrows, never doubles)", () => {
  const escrow = parseUnits("1", 18); // capLeft 1 => live cap 0.25
  const buys = (claim) => [{ seriesId: 0, maxClaimUnits: claim, maxPremiumUnits: (claim * 1000n) / 10_000n }];
  // already at/above the cap: dropped
  const atCap = diff(
    { buys: buys(parseUnits("0.2", 18)) },
    mkState({ seriesById: { 0: marketRow({ escrowUnits: escrow, holdingUnits: parseUnits("0.25", 18) }) } }),
  );
  assert.equal(atCap.txs.length, 0);
  assert.ok(atCap.notes.some((n) => n.includes("re-run/idempotence guard")));
  // below the cap: narrowed to the headroom
  const below = diff(
    { buys: buys(parseUnits("0.2", 18)) },
    mkState({ seriesById: { 0: marketRow({ escrowUnits: escrow, holdingUnits: parseUnits("0.15", 18) }) } }),
  );
  assert.deepEqual(names(below), ["approve", "buyProtection"]);
  assert.deepEqual(below.txs[1].args, [0n, parseUnits("0.1", 18), parseUnits("0.01", 18)]);
  // zero holdings: untouched (hand-crafted fork plans keep working)
  const fresh = diff(
    { buys: buys(parseUnits("0.2", 18)) },
    mkState({ seriesById: { 0: marketRow({ escrowUnits: escrow, holdingUnits: 0n }) } }),
  );
  assert.deepEqual(fresh.txs[1].args, [0n, parseUnits("0.2", 18), parseUnits("0.02", 18)]);
});

test("buy leg: a series created by ANY operator wallet is dropped (cross-wallet self-dealing)", () => {
  for (const opWallet of DEFAULT_CONFIG.operatorWallets) {
    const d = diff(
      { buys: [{ seriesId: 0, maxClaimUnits: parseUnits("0.1", 18), maxPremiumUnits: parseUnits("0.01", 18) }] },
      mkState({ seriesById: { 0: marketRow({ creator: opWallet }) } }),
    );
    assert.equal(d.txs.length, 0, opWallet);
    assert.ok(d.notes.some((n) => n.includes("operator wallet")), opWallet);
  }
});

test("computeBudget sums escrow and premiums from the final tx list only", () => {
  const b = computeBudget([
    { functionName: "approve", args: [ADDR.pool, 999n] },
    { functionName: "createSeries", args: [1, 2, 3, 4n, 5n, 6n, 7n, 100n] },
    { functionName: "buyProtection", args: [0n, 50n, 5n] },
    { functionName: "buyProtectionFor", args: [1n, 50n, 7n, ME] },
    { functionName: "withdrawResidual", args: [0n] },
  ]);
  assert.deepEqual(b, { escrowUnits: 100n, premiumUnits: 12n, totalPullUnits: 112n });
});
