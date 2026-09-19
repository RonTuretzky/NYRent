/**
 * Unit tests for direct.mjs's pure Plan → tx-diff computation.
 * Fake chain-state fixtures only — no network, no clients. The real-chain proof
 * lives in fork-proof.mjs (anvil fork of Gnosis mainnet).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { computeTxDiff, validatePlan, PlanError } from "./direct.mjs";
import { ADDRESSES } from "./chain.mjs";

// Mirrors live mainnet state 2026-09-18 (freeCapital 3.35e14, sponsor ~1.3497 WXDAI
// + ~0.001 xDAI, allowance 0, salesPaused false, 1 settled series).
const LIVE_STATE = {
  xdaiWei: parseEther("0.001"),
  wxdaiWei: parseEther("1.3497"),
  allowanceWei: 0n,
  freeCapitalWei: 335_000_000_000_000n, // 3.35e14
  salesPaused: false,
  seriesCount: 1n,
};

const NOW = 1_789_700_000n; // fixture "now" (unix seconds)
const VALID_SERIES = {
  strikeLowCents: 8900,
  strikeHighCents: 9700,
  premiumRateBps: 2500,
  saleEnd: NOW + 7n * 86400n,
  obsStart: NOW + 7n * 86400n,
  obsEnd: NOW + 14n * 86400n,
  redeemEnd: NOW + 21n * 86400n,
  capacity: parseEther("0.5"),
};

const names = (d) => d.txs.map((t) => t.functionName);

test("fund: wxdai sufficient -> approve(exact) + fundPool, no wrap", () => {
  const target = LIVE_STATE.freeCapitalWei + parseEther("0.1");
  const d = computeTxDiff({ targetFreeCapitalWei: target, newSeries: null, pause: null, rationale: [] }, LIVE_STATE);
  assert.deepEqual(names(d), ["approve", "fundPool"]);
  assert.deepEqual(d.txs[0].args, [ADDRESSES.pool, parseEther("0.1")]); // approve EXACTLY the fund amount
  assert.deepEqual(d.txs[1].args, [parseEther("0.1")]);
  assert.equal(d.txs[0].address, ADDRESSES.currency);
  assert.equal(d.txs[1].address, ADDRESSES.pool);
});

test("fund: zero WXDAI -> wrap full amount first", () => {
  const state = { ...LIVE_STATE, wxdaiWei: 0n, xdaiWei: parseEther("1") };
  const d = computeTxDiff({ targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1") }, state);
  assert.deepEqual(names(d), ["deposit", "approve", "fundPool"]);
  assert.equal(d.txs[0].value, parseEther("0.1")); // deposit() payable carries the wrap as value
  assert.deepEqual(d.txs[0].args, []);
});

test("fund: partial WXDAI -> wrap only the shortfall", () => {
  const state = { ...LIVE_STATE, wxdaiWei: parseEther("0.04"), xdaiWei: parseEther("1") };
  const d = computeTxDiff({ targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1") }, state);
  assert.deepEqual(names(d), ["deposit", "approve", "fundPool"]);
  assert.equal(d.txs[0].value, parseEther("0.06")); // 0.1 needed − 0.04 held
  assert.deepEqual(d.txs[1].args, [ADDRESSES.pool, parseEther("0.1")]);
  assert.deepEqual(d.txs[2].args, [parseEther("0.1")]);
});

test("fund: existing allowance covers the amount -> no approve", () => {
  const state = { ...LIVE_STATE, allowanceWei: parseEther("1") };
  const d = computeTxDiff({ targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1") }, state);
  assert.deepEqual(names(d), ["fundPool"]);
});

test("fund: wrap needed but xDAI insufficient -> PlanError, no txs", () => {
  const state = { ...LIVE_STATE, wxdaiWei: 0n, xdaiWei: parseEther("0.01") };
  assert.throws(
    () => computeTxDiff({ targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1") }, state),
    PlanError,
  );
});

test("withdraw: target below current freeCapital -> withdrawExcess(delta)", () => {
  const target = LIVE_STATE.freeCapitalWei - 100_000_000_000_000n; // −1e14
  const d = computeTxDiff({ targetFreeCapitalWei: target }, LIVE_STATE);
  assert.deepEqual(names(d), ["withdrawExcess"]);
  assert.deepEqual(d.txs[0].args, [100_000_000_000_000n]);
});

test("withdraw: never exceeds freeCapital (target 0 withdraws exactly freeCapital)", () => {
  const d = computeTxDiff({ targetFreeCapitalWei: 0n }, LIVE_STATE);
  assert.deepEqual(d.txs[0].args, [LIVE_STATE.freeCapitalWei]);
});

test("capital no-op: target == freeCapital -> no tx, explanatory note", () => {
  const d = computeTxDiff({ targetFreeCapitalWei: LIVE_STATE.freeCapitalWei }, LIVE_STATE);
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("already at target")));
});

test("targetFreeCapitalWei null -> capital untouched", () => {
  const d = computeTxDiff({ targetFreeCapitalWei: null, newSeries: null, pause: null }, LIVE_STATE);
  assert.equal(d.txs.length, 0);
});

test("createSeries: args in exact contract order", () => {
  const d = computeTxDiff({ newSeries: VALID_SERIES }, LIVE_STATE);
  assert.deepEqual(names(d), ["createSeries"]);
  const s = VALID_SERIES;
  assert.deepEqual(d.txs[0].args, [
    BigInt(s.strikeLowCents),
    BigInt(s.strikeHighCents),
    BigInt(s.premiumRateBps),
    s.saleEnd,
    s.obsStart,
    s.obsEnd,
    s.redeemEnd,
    s.capacity,
  ]);
});

test("createSeries: decide.mjs's capacityWei field name is accepted", () => {
  const { capacity, ...rest } = VALID_SERIES;
  const d = computeTxDiff({ newSeries: { ...rest, capacityWei: capacity } }, LIVE_STATE);
  assert.equal(d.txs[0].args[7], capacity);
});

test("createSeries: contract invariants rejected locally", () => {
  const bad = [
    { ...VALID_SERIES, strikeLowCents: 9700, strikeHighCents: 8900 }, // strikes inverted
    { ...VALID_SERIES, strikeLowCents: 9700 }, // strikes equal
    { ...VALID_SERIES, saleEnd: VALID_SERIES.obsEnd + 1n }, // saleEnd > obsEnd
    { ...VALID_SERIES, redeemEnd: VALID_SERIES.obsEnd }, // obsEnd !< redeemEnd
    { ...VALID_SERIES, obsStart: VALID_SERIES.obsEnd }, // obsStart !< obsEnd
    { ...VALID_SERIES, capacity: 0n }, // zero capacity
    { ...VALID_SERIES, premiumRateBps: 10_001 }, // >100% premium
  ];
  for (const s of bad) assert.throws(() => computeTxDiff({ newSeries: s }, LIVE_STATE), PlanError, JSON.stringify(s, (_, v) => String(v)));
});

test("createSeries: sales overlapping the observation window earns a warning note", () => {
  const d = computeTxDiff({ newSeries: { ...VALID_SERIES, saleEnd: VALID_SERIES.obsStart + 3600n } }, LIVE_STATE);
  assert.ok(d.notes.some((n) => n.includes("informed-trading")));
});

test("pause: only emits setSalesPaused when it changes the current state", () => {
  const on = computeTxDiff({ pause: true }, LIVE_STATE);
  assert.deepEqual(names(on), ["setSalesPaused"]);
  assert.deepEqual(on.txs[0].args, [true]);
  const noop = computeTxDiff({ pause: false }, LIVE_STATE); // already false
  assert.equal(noop.txs.length, 0);
  const off = computeTxDiff({ pause: false }, { ...LIVE_STATE, salesPaused: true });
  assert.deepEqual(off.txs[0].args, [false]);
  const leave = computeTxDiff({ pause: null }, { ...LIVE_STATE, salesPaused: true });
  assert.equal(leave.txs.length, 0);
});

test("full plan ordering: setSalesPaused(true) FIRST, then wrap -> approve -> fundPool -> createSeries", () => {
  const state = { ...LIVE_STATE, wxdaiWei: 0n, xdaiWei: parseEther("1") };
  const d = computeTxDiff(
    {
      targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1"),
      newSeries: VALID_SERIES,
      pause: true,
      rationale: ["test"],
    },
    state,
  );
  // safety before capital moves: a failing capital tx must never starve the pause
  assert.deepEqual(names(d), ["setSalesPaused", "deposit", "approve", "fundPool", "createSeries"]);
  assert.deepEqual(d.txs[0].args, [true]);
});

test("unpause (pause:false) stays LAST — never resume sales before the rest landed", () => {
  const state = { ...LIVE_STATE, salesPaused: true };
  const d = computeTxDiff(
    {
      targetFreeCapitalWei: state.freeCapitalWei + parseEther("0.1"),
      newSeries: VALID_SERIES,
      pause: false,
      rationale: ["test"],
    },
    state,
  );
  assert.deepEqual(names(d), ["approve", "fundPool", "createSeries", "setSalesPaused"]);
  assert.deepEqual(d.txs.at(-1).args, [false]);
});

// ---------------------------------------------------------------------------
// execution-time capital clamp — live-state drift must never widen the plan
// ---------------------------------------------------------------------------

test("live delta beyond the ±0.5 WXDAI per-run cap is refused outright (fund + withdraw + no plan delta)", () => {
  const rich = { ...LIVE_STATE, xdaiWei: parseEther("5"), wxdaiWei: parseEther("5") };
  // fund side: plan clamped to +0.5 at decide time, but freeCapital dropped since
  assert.throws(
    () =>
      computeTxDiff(
        { targetFreeCapitalWei: rich.freeCapitalWei + parseEther("1.3"), capitalDeltaWei: parseEther("0.5") },
        rich,
      ),
    PlanError,
  );
  // withdraw side: reserves released since decide -> live delta -4.5
  const fat = { ...LIVE_STATE, freeCapitalWei: parseEther("5") };
  assert.throws(
    () =>
      computeTxDiff({ targetFreeCapitalWei: parseEther("0.5"), capitalDeltaWei: -parseEther("0.5") }, fat),
    PlanError,
  );
  // even a plan WITHOUT capitalDeltaWei can never move more than the hard cap
  assert.throws(
    () => computeTxDiff({ targetFreeCapitalWei: rich.freeCapitalWei + parseEther("0.6") }, rich),
    PlanError,
  );
});

test("live delta wider than the plan's clamped delta is narrowed to the plan delta", () => {
  // the policy authorized +0.1; freeCapital moved so the live gap to target is +0.3
  const d = computeTxDiff(
    { targetFreeCapitalWei: LIVE_STATE.freeCapitalWei + parseEther("0.3"), capitalDeltaWei: parseEther("0.1") },
    LIVE_STATE,
  );
  assert.deepEqual(names(d), ["approve", "fundPool"]);
  assert.deepEqual(d.txs[1].args, [parseEther("0.1")], "executes the plan's 0.1, not the live 0.3");
  assert.ok(d.notes.some((n) => n.includes("EXECUTION CLAMP")));
});

test("plan-zeroed dust delta (capitalDeltaWei 0) never re-introduces a capital tx", () => {
  // policy zeroed the delta as dust but the plan still carries target = its own free_T0;
  // live freeCapital drifted 2e13 -> without the execution clamp this would fund 2e13
  const state = { ...LIVE_STATE, freeCapitalWei: LIVE_STATE.freeCapitalWei - 20_000_000_000_000n };
  const d = computeTxDiff({ targetFreeCapitalWei: LIVE_STATE.freeCapitalWei, capitalDeltaWei: 0n }, state);
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("EXECUTION CLAMP")));
});

test("sub-dust live delta is a no-op even without a plan delta", () => {
  const d = computeTxDiff(
    { targetFreeCapitalWei: LIVE_STATE.freeCapitalWei + 5_000_000_000_000n },
    LIVE_STATE,
  );
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("dust")));
});

test("refused plan (decide.mjs refusal) -> zero txs", () => {
  const d = computeTxDiff({ refused: true, targetFreeCapitalWei: null, newSeries: null, pause: null, rationale: ["stale data"] }, LIVE_STATE);
  assert.equal(d.txs.length, 0);
  assert.ok(d.notes.some((n) => n.includes("refused")));
});

test("validatePlan: coercions and rejections", () => {
  // string/number coercion into bigints
  const p = validatePlan({ targetFreeCapitalWei: "1000", newSeries: { ...VALID_SERIES, strikeLowCents: "8900", saleEnd: Number(VALID_SERIES.saleEnd) }, pause: null });
  assert.equal(p.targetFreeCapitalWei, 1000n);
  assert.equal(p.newSeries.strikeLowCents, 8900n);
  // capitalDeltaWei: coerced (may be negative), null when absent, non-integer rejected
  assert.equal(validatePlan({ targetFreeCapitalWei: "1000", capitalDeltaWei: "-500" }).capitalDeltaWei, -500n);
  assert.equal(validatePlan({ targetFreeCapitalWei: "1000" }).capitalDeltaWei, null);
  assert.throws(() => validatePlan({ capitalDeltaWei: 1.5 }), PlanError);
  assert.throws(() => validatePlan({ targetFreeCapitalWei: -1n }), PlanError);
  assert.throws(() => validatePlan({ targetFreeCapitalWei: 1.5 }), PlanError);
  assert.throws(() => validatePlan({ pause: "yes" }), PlanError);
  assert.throws(() => validatePlan(null), PlanError);
  assert.throws(() => validatePlan({ newSeries: { strikeLowCents: 1 } }), PlanError); // missing fields
  assert.throws(() => validatePlan({ newSeries: { ...VALID_SERIES, strikeLowCents: 2n ** 32n } }), PlanError); // uint32 overflow
});

test("state fixture validation: malformed state rejected", () => {
  assert.throws(() => computeTxDiff({ pause: true }, { ...LIVE_STATE, wxdaiWei: 5 }), PlanError);
  assert.throws(() => computeTxDiff({ pause: true }, { ...LIVE_STATE, salesPaused: "no" }), PlanError);
});
