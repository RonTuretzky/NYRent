/**
 * direct.mjs — THE local-key writer for the permissionless CoverPool (Option B:
 * no roles, no sponsor, no handoff — the agent is just one underwriter wallet
 * among any number; src/CoverPool.sol is the source of truth).
 *
 * Consumes the two-sided market-maker Plan from policy/decide.mjs:
 *   {
 *     refused:   boolean,                    // true => no-op
 *     newSeries: null | { strikeLowCents, strikeHighCents, premiumRateBps,
 *                saleEnd, obsStart, obsEnd, redeemEnd,
 *                capacityUnits },            // SELL: capacity is ESCROWED from
 *                                            // the executing wallet at creation
 *     buys: [{ seriesId, maxClaimUnits, maxPremiumUnits }],  // BUY legs
 *     redeems: [{ seriesId, units }],              // REDEEM settled holdings
 *     pauses:            [{ seriesId, paused }],  // own series only
 *     cancels:           [seriesId, ...],         // own UNSOLD series only
 *     withdrawResiduals: [seriesId, ...],         // own series past redeemEnd
 *     target: { chainId, pool, decidedAtBlock, wallet } | null,  // plan stamp
 *     rationale: string[]
 *   }
 *   (field aliases tolerated: capacity/capacityWei, maxClaim/maxClaimWei,
 *   maxPremium/maxPremiumWei — everything is BigInt-coerced and validated.)
 *
 * Tx builders (this file's whole vocabulary — nothing else is ever sent):
 *   approve + createSeries   (escrow! createSeries pulls capacity 1:1)
 *   approve + buyProtection  (per buy item — premium pulled from msg.sender,
 *                            cover minted to msg.sender; SOULBOUND thereafter)
 *   redeem                   (per redeem item — burns held cover, collects
 *                            units × settled ratio from the series escrow)
 *   setSeriesPaused / cancelSeries / withdrawResidual (creator levers, checked
 *                            against LIVE creator/flags before building)
 *
 * ORDER (safety first, collections next, money last, unpause very last):
 *   setSeriesPaused(true)… → cancelSeries… → withdrawResidual… → redeem… →
 *   [approve] createSeries → per buy: [approve] buyProtection →
 *   setSeriesPaused(false)…
 *
 * PLAN STAMP: a plan stamped { chainId, pool, wallet } (decide() emits it) is
 * REFUSED when any stamped field mismatches the live chain id, the configured
 * pool or the executing wallet — a plan can never replay onto the wrong chain
 * or pool, and a plan sized for one wallet can never execute from another.
 * Unstamped plans (hand-crafted / tests) pass with a note.
 *
 * EXECUTION-TIME CLAMPS — re-derived from LIVE chain state (the drift lesson:
 * decide() ran against an older block; drift must never widen an action):
 *   - newSeries.capacityUnits  > per-run sell-escrow cap (0.5 currency units,
 *     policy MAX_SELL_ESCROW_MILLIUNITS scaled by LIVE token decimals) => the
 *     whole batch is REFUSED (PlanError);
 *   - Σ authorized buys.maxClaimUnits > per-run buy-notional cap (0.5 units,
 *     MAX_BUY_NOTIONAL_MILLIUNITS) => REFUSED outright;
 *   - each buy leg is NARROWED to the series' live unsold capacity and DROPPED
 *     (with a note) when the series went settled/cancelled/paused/sale-closed,
 *     when it is the agent's own series, when the live premium would exceed the
 *     plan's authorized maxPremium, or when the narrowed size is dust;
 *   - creator levers are dropped (with a note) when live state says they would
 *     revert (not creator / already cancelled / sold since decide / residual
 *     already taken / redeem window still open);
 *   - REFUSE the whole batch when wallet currency balance < escrow + Σ buy
 *     premiums, and (live mode) when native gas balance < 3× estimated fees.
 *
 * Pipeline: readState() → computeTxDiff() (pure, unit-tested) → per-tx gas
 * estimate + gas sanity → dry-run returns the tx list without sending;
 * otherwise each tx is simulateContract()'d immediately before sending, sent
 * sequentially with receipt waits + explorer links, and the batch ABORTS on
 * the first failure (later txs are never attempted — PARTIAL upstream).
 */
import { createPublicClient, createWalletClient, http, formatUnits, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POOL_ABI, ERC20_ABI, COVER_TOKEN_ABI, TARGETS, targetRpcUrl } from "./targets.mjs";
import { loadEnv } from "./chain.mjs";
import { DEFAULT_CONFIG, milliunitsToUnits, dustUnits } from "../policy/decide.mjs";

export class PlanError extends Error {}

const UINT16_MAX = (1n << 16n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

function asBigInt(v, what) {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error("non-integer");
    return BigInt(v);
  } catch {
    throw new PlanError(`plan.${what} is not an integer: ${String(v)}`);
  }
}

function boundedUint(v, what, max) {
  const b = asBigInt(v, what);
  if (b < 0n || b > max) throw new PlanError(`plan.${what} out of range: ${b}`);
  return b;
}

function seriesIdOf(v, what) {
  const b = asBigInt(v, what);
  if (b < 0n || b > 1_000_000_000n) throw new PlanError(`plan.${what} is not a plausible seriesId: ${b}`);
  return Number(b);
}

export const SERIES_FIELDS = [
  "strikeLowCents",
  "strikeHighCents",
  "premiumRateBps",
  "saleEnd",
  "obsStart",
  "obsEnd",
  "redeemEnd",
  "capacity",
];

const DAY = 86_400n;

/**
 * Validate + normalize a Plan into bigints. Throws PlanError on shape/invariant
 * violations (mirrors CoverPool's own reverts so bad plans die locally, never
 * on-chain). Unknown plan keys are ignored; missing action arrays mean "none".
 */
export function validatePlan(plan) {
  if (plan === null || typeof plan !== "object") throw new PlanError("plan must be an object");
  const rationale = Array.isArray(plan.rationale) ? plan.rationale.map(String) : [];

  // decide.mjs sets refused:true when the policy wants NOTHING done on-chain.
  if (plan.refused === true) {
    return { refused: true, newSeries: null, buys: [], redeems: [], pauses: [], cancels: [], withdrawResiduals: [], target: null, rationale };
  }

  // Plan stamp (optional): { chainId, pool, decidedAtBlock, wallet } — carried
  // through for the execution-time cross-target/identity refusal.
  let target = null;
  if (plan.target !== null && plan.target !== undefined) {
    if (typeof plan.target !== "object") throw new PlanError("plan.target must be an object or null");
    const chainId = plan.target.chainId === undefined || plan.target.chainId === null ? null : Number(plan.target.chainId);
    if (chainId !== null && (!Number.isInteger(chainId) || chainId <= 0))
      throw new PlanError(`plan.target.chainId invalid: ${plan.target.chainId}`);
    const addr = (v, what) => {
      if (v === undefined || v === null) return null;
      if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new PlanError(`plan.target.${what} is not an address`);
      return v;
    };
    target = {
      chainId,
      pool: addr(plan.target.pool, "pool"),
      wallet: addr(plan.target.wallet, "wallet"),
      decidedAtBlock:
        plan.target.decidedAtBlock === undefined || plan.target.decidedAtBlock === null
          ? null
          : Number(plan.target.decidedAtBlock),
    };
  }

  let newSeries = null;
  if (plan.newSeries !== null && plan.newSeries !== undefined) {
    // decide.mjs names the escrow capacityUnits; the contract arg is capacity.
    const s = {
      ...plan.newSeries,
      capacity: plan.newSeries.capacity ?? plan.newSeries.capacityUnits ?? plan.newSeries.capacityWei,
    };
    for (const f of SERIES_FIELDS) {
      if (s[f] === undefined || s[f] === null) throw new PlanError(`plan.newSeries.${f} missing`);
    }
    newSeries = {
      strikeLowCents: boundedUint(s.strikeLowCents, "newSeries.strikeLowCents", UINT32_MAX),
      strikeHighCents: boundedUint(s.strikeHighCents, "newSeries.strikeHighCents", UINT32_MAX),
      premiumRateBps: boundedUint(s.premiumRateBps, "newSeries.premiumRateBps", UINT16_MAX),
      saleEnd: boundedUint(s.saleEnd, "newSeries.saleEnd", UINT64_MAX),
      obsStart: boundedUint(s.obsStart, "newSeries.obsStart", UINT64_MAX),
      obsEnd: boundedUint(s.obsEnd, "newSeries.obsEnd", UINT64_MAX),
      redeemEnd: boundedUint(s.redeemEnd, "newSeries.redeemEnd", UINT64_MAX),
      capacity: boundedUint(s.capacity, "newSeries.capacity", UINT128_MAX),
    };
    // CoverPool.createSeries invariants — fail here, not on-chain:
    if (newSeries.strikeLowCents === 0n) throw new PlanError("newSeries: strikeLowCents must be > 0");
    if (!(newSeries.strikeLowCents < newSeries.strikeHighCents))
      throw new PlanError("newSeries: strikeLowCents must be < strikeHighCents");
    if (!(newSeries.saleEnd <= newSeries.obsStart))
      throw new PlanError("newSeries: saleEnd must be <= obsStart (contract informed-trading rule)");
    if (!(newSeries.obsStart < newSeries.obsEnd && newSeries.obsEnd < newSeries.redeemEnd))
      throw new PlanError("newSeries: need obsStart < obsEnd < redeemEnd");
    if (newSeries.redeemEnd < newSeries.obsEnd + 7n * DAY)
      throw new PlanError("newSeries: redeemEnd must be >= obsEnd + 7d (contract MIN_REDEEM_WINDOW)");
    if (newSeries.capacity === 0n) throw new PlanError("newSeries: capacity must be > 0");
    if (newSeries.premiumRateBps > 10_000n) throw new PlanError("newSeries: premiumRateBps > 10000");
  }

  const buys = [];
  if (plan.buys !== null && plan.buys !== undefined) {
    if (!Array.isArray(plan.buys)) throw new PlanError("plan.buys must be an array");
    for (const [i, b] of plan.buys.entries()) {
      if (b === null || typeof b !== "object") throw new PlanError(`plan.buys[${i}] must be an object`);
      const maxClaim = boundedUint(b.maxClaimUnits ?? b.maxClaim ?? b.maxClaimWei, `buys[${i}].maxClaim`, UINT128_MAX);
      const maxPremium = boundedUint(
        b.maxPremiumUnits ?? b.maxPremium ?? b.maxPremiumWei,
        `buys[${i}].maxPremium`,
        UINT128_MAX,
      );
      if (maxClaim === 0n) throw new PlanError(`plan.buys[${i}].maxClaim must be > 0`);
      buys.push({ seriesId: seriesIdOf(b.seriesId, `buys[${i}].seriesId`), maxClaim, maxPremium });
    }
  }

  const pauses = [];
  if (plan.pauses !== null && plan.pauses !== undefined) {
    if (!Array.isArray(plan.pauses)) throw new PlanError("plan.pauses must be an array");
    for (const [i, p] of plan.pauses.entries()) {
      if (p === null || typeof p !== "object" || typeof p.paused !== "boolean")
        throw new PlanError(`plan.pauses[${i}] must be { seriesId, paused:boolean }`);
      pauses.push({ seriesId: seriesIdOf(p.seriesId, `pauses[${i}].seriesId`), paused: p.paused });
    }
  }

  const redeems = [];
  if (plan.redeems !== null && plan.redeems !== undefined) {
    if (!Array.isArray(plan.redeems)) throw new PlanError("plan.redeems must be an array");
    for (const [i, r] of plan.redeems.entries()) {
      if (r === null || typeof r !== "object") throw new PlanError(`plan.redeems[${i}] must be an object`);
      const units = boundedUint(r.units ?? r.unitsWei ?? r.amount, `redeems[${i}].units`, UINT128_MAX);
      if (units === 0n) throw new PlanError(`plan.redeems[${i}].units must be > 0`);
      redeems.push({ seriesId: seriesIdOf(r.seriesId, `redeems[${i}].seriesId`), units });
    }
  }

  const cancels = (plan.cancels ?? []).map((id, i) => seriesIdOf(id, `cancels[${i}]`));
  const withdrawResiduals = (plan.withdrawResiduals ?? []).map((id, i) =>
    seriesIdOf(id, `withdrawResiduals[${i}]`),
  );

  return { refused: false, newSeries, buys, redeems, pauses, cancels, withdrawResiduals, target, rationale };
}

/**
 * Escrow + premium the FINAL tx list will pull from the wallet, plus per-kind
 * subtotals (pure; used for the balance refusal and the report).
 */
export function computeBudget(txs) {
  let escrowUnits = 0n;
  let premiumUnits = 0n;
  for (const tx of txs) {
    if (tx.functionName === "createSeries") escrowUnits += BigInt(tx.args[7]);
    if (tx.functionName === "buyProtection") premiumUnits += BigInt(tx.args[2]);
    if (tx.functionName === "buyProtectionFor") premiumUnits += BigInt(tx.args[2]);
  }
  return { escrowUnits, premiumUnits, totalPullUnits: escrowUnits + premiumUnits };
}

/**
 * Pure diff: Plan × LIVE chain state → ordered tx descriptors. No I/O,
 * unit-tested with fake state fixtures. State shape (readState() produces it):
 *   {
 *     address,                       // executing wallet
 *     chainId,                       // LIVE chain id (plan-stamp refusal)
 *     nowSec,                        // latest block timestamp (Number)
 *     decimals,                      // LIVE currency decimals (drives the caps)
 *     nativeWei,                     // gas balance (BigInt)
 *     currencyUnits, allowanceUnits, // wallet balance / allowance→pool (BigInt)
 *     seriesCount,                   // Number | BigInt
 *     seriesById: { [id]: { creator, strikeLowCents, strikeHighCents,
 *                premiumRateBps, settled, cancelled, paused, saleEnd,
 *                obsStart, obsEnd, redeemEnd, escrowUnits, soldUnits,
 *                residualWithdrawn, payoutRatioWad, holdingUnits } },
 *   }
 *   (chainId / strikes / windows / payoutRatioWad / holdingUnits are optional
 *   in hand-built fixtures — the checks that need them are skipped when absent)
 *
 * opts.config overrides the policy config (tests); the caps ALWAYS re-derive
 * from state.decimals so an 18-dec plan can never smuggle 1e12× too much value
 * through a 6-dec deployment (the decimals matrix law).
 */
export function computeTxDiff(plan, state, { addresses, config = {} } = {}) {
  if (!addresses?.pool || !addresses?.currency) throw new PlanError("addresses.pool/currency required");
  const p = validatePlan(plan);

  if (typeof state?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(state.address))
    throw new PlanError("state.address must be the executing wallet address");
  const nowSec = Number(state.nowSec);
  if (!Number.isFinite(nowSec) || nowSec <= 0) throw new PlanError("state.nowSec must be a positive number");
  if (!Number.isInteger(state.decimals) || state.decimals < 0 || state.decimals > 36)
    throw new PlanError(`state.decimals invalid: ${state.decimals}`);
  for (const k of ["currencyUnits", "allowanceUnits", "nativeWei"]) {
    if (typeof state[k] !== "bigint") throw new PlanError(`state.${k} must be a bigint`);
  }
  const seriesById = state.seriesById ?? {};
  const me = state.address.toLowerCase();
  const mine = (row) => typeof row?.creator === "string" && row.creator.toLowerCase() === me;

  const cfg = { ...DEFAULT_CONFIG, ...config, decimals: state.decimals };
  const operatorSet = new Set(
    [state.address, ...(Array.isArray(cfg.operatorWallets) ? cfg.operatorWallets : [])]
      .filter((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase()),
  );
  const operatorOwned = (row) => typeof row?.creator === "string" && operatorSet.has(row.creator.toLowerCase());
  const maxSellEscrow = milliunitsToUnits(cfg.MAX_SELL_ESCROW_MILLIUNITS, cfg);
  const maxBuyNotional = milliunitsToUnits(cfg.MAX_BUY_NOTIONAL_MILLIUNITS, cfg);
  const dust = dustUnits(cfg);

  const txs = [];
  const notes = [];
  const fmt = (u) => formatUnits(u, state.decimals);

  if (p.refused) {
    notes.push("plan refused by policy (refused:true) — no on-chain action");
    return { txs, notes, plan: p, budget: computeBudget(txs) };
  }

  // ---- PLAN STAMP: refuse cross-target / cross-identity execution ------------
  // A stamped plan must match the live chain id, the configured pool and the
  // executing wallet EXACTLY — never execute a plan decided for another chain,
  // another pool, or sized for another wallet's balance.
  if (p.target) {
    const liveChainId = state.chainId === undefined || state.chainId === null ? null : Number(state.chainId);
    if (p.target.chainId !== null && liveChainId !== null && p.target.chainId !== liveChainId) {
      throw new PlanError(
        `plan stamped for chainId ${p.target.chainId} but the live chain is ${liveChainId} — refusing cross-target execution`,
      );
    }
    if (p.target.pool !== null && p.target.pool.toLowerCase() !== String(addresses.pool).toLowerCase()) {
      throw new PlanError(
        `plan stamped for pool ${p.target.pool} but this executor targets ${addresses.pool} — refusing cross-pool execution`,
      );
    }
    if (p.target.wallet !== null && p.target.wallet.toLowerCase() !== me) {
      throw new PlanError(
        `plan was decided for wallet ${p.target.wallet} but the executing wallet is ${state.address} — refusing: re-decide with this identity (a plan sized for one wallet must never execute from another)`,
      );
    }
  } else {
    notes.push("plan carries no target stamp — cross-target/identity refusal checks skipped (hand-crafted plan?)");
  }

  // ---- HARD PER-RUN CAPS on what the plan AUTHORIZES (refuse, never trim:
  // a plan beyond the caps means policy and executor disagree about the law,
  // and the next run re-decides from fresh state) -----------------------------
  if (p.newSeries && p.newSeries.capacity > maxSellEscrow) {
    throw new PlanError(
      `newSeries escrow ${fmt(p.newSeries.capacity)} exceeds the per-run sell-escrow cap ${fmt(maxSellEscrow)} (MAX_SELL_ESCROW_MILLIUNITS at ${state.decimals} decimals) — refusing the batch`,
    );
  }
  const authorizedNotional = p.buys.reduce((a, b) => a + b.maxClaim, 0n);
  if (authorizedNotional > maxBuyNotional) {
    throw new PlanError(
      `plan buy notional ${fmt(authorizedNotional)} exceeds the per-run buy-notional cap ${fmt(maxBuyNotional)} (MAX_BUY_NOTIONAL_MILLIUNITS at ${state.decimals} decimals) — refusing the batch`,
    );
  }

  const liveRow = (id, what) => {
    const row = seriesById[id];
    if (!row) {
      notes.push(`${what}(${id}) dropped: series not in live state (unknown or unreadable id)`);
      return null;
    }
    return row;
  };

  // ---- 1. pause:true legs FIRST — the safety action must never be starved by
  // a later failing money tx (the batch aborts on first failure) --------------
  const unpauses = [];
  for (const { seriesId, paused } of p.pauses) {
    const row = liveRow(seriesId, "setSeriesPaused");
    if (!row) continue;
    if (!mine(row)) {
      notes.push(`setSeriesPaused(${seriesId}) dropped: live creator ${row.creator} is not us (NotCreator)`);
      continue;
    }
    if (row.cancelled) {
      notes.push(`setSeriesPaused(${seriesId}) dropped: series is cancelled — nothing to pause`);
      continue;
    }
    if (Boolean(row.paused) === paused) {
      notes.push(`setSeriesPaused(${seriesId}) dropped: already paused=${paused} on-chain`);
      continue;
    }
    const tx = {
      name: `setSeriesPaused(${seriesId}, ${paused}) [own series — never blocks settle/redeem]`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "setSeriesPaused",
      args: [BigInt(seriesId), paused],
      value: 0n,
      fallbackGas: 60_000n,
    };
    if (paused) txs.push(tx);
    else unpauses.push(tx); // unpause goes LAST — never resume sales early
  }

  // ---- 2. cancels: own UNSOLD series — reclaim escrow ------------------------
  for (const seriesId of p.cancels) {
    const row = liveRow(seriesId, "cancelSeries");
    if (!row) continue;
    if (!mine(row)) {
      notes.push(`cancelSeries(${seriesId}) dropped: live creator ${row.creator} is not us (NotCreator)`);
      continue;
    }
    if (row.cancelled || row.settled || row.residualWithdrawn) {
      notes.push(`cancelSeries(${seriesId}) dropped: series already closed (cancelled/settled/residual taken)`);
      continue;
    }
    if (BigInt(row.soldUnits) !== 0n) {
      notes.push(
        `cancelSeries(${seriesId}) dropped: ${fmt(BigInt(row.soldUnits))} sold since decide — cancel would revert AlreadySold; escrow rides to redeemEnd`,
      );
      continue;
    }
    txs.push({
      name: `cancelSeries(${seriesId}) [unsold — full escrow refund]`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "cancelSeries",
      args: [BigInt(seriesId)],
      value: 0n,
      fallbackGas: 90_000n,
    });
  }

  // ---- 3. withdrawResiduals: own matured series ------------------------------
  for (const seriesId of p.withdrawResiduals) {
    const row = liveRow(seriesId, "withdrawResidual");
    if (!row) continue;
    if (!mine(row)) {
      notes.push(`withdrawResidual(${seriesId}) dropped: live creator ${row.creator} is not us (NotCreator)`);
      continue;
    }
    if (row.cancelled || row.residualWithdrawn) {
      notes.push(`withdrawResidual(${seriesId}) dropped: residual already taken (or series cancelled)`);
      continue;
    }
    if (nowSec <= Number(row.redeemEnd)) {
      notes.push(
        `withdrawResidual(${seriesId}) dropped: redeem window still open until ${row.redeemEnd} (RedeemWindowOpen)`,
      );
      continue;
    }
    txs.push({
      name: `withdrawResidual(${seriesId}) [escrow + premiums − payouts, one-shot]`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "withdrawResidual",
      args: [BigInt(seriesId)],
      value: 0n,
      fallbackGas: 90_000n,
    });
  }

  // ---- 3b. REDEEM: collect settled holdings (units × ratio from escrow) ------
  // Collections before money-out legs; narrowed to LIVE holdings and dropped
  // when live state says redeem would revert (NotSettled / RedeemWindowClosed)
  // or collect nothing (ratio 0). Pause never blocks redeem (contract law).
  for (const r of p.redeems) {
    const row = liveRow(r.seriesId, "redeem");
    if (!row) continue;
    if (row.cancelled) {
      notes.push(`redeem(${r.seriesId}) dropped: series cancelled — nothing escrowed to redeem against`);
      continue;
    }
    if (!row.settled) {
      notes.push(`redeem(${r.seriesId}) dropped: series not settled on-chain (NotSettled)`);
      continue;
    }
    if (nowSec > Number(row.redeemEnd)) {
      notes.push(`redeem(${r.seriesId}) dropped: redeem window closed at ${row.redeemEnd} (RedeemWindowClosed) — payout forgone`);
      continue;
    }
    const ratio = BigInt(row.payoutRatioWad ?? 0);
    if (ratio <= 0n) {
      notes.push(`redeem(${r.seriesId}) dropped: settled at ratio 0 — nothing to collect`);
      continue;
    }
    let units = r.units;
    if (row.holdingUnits !== undefined && row.holdingUnits !== null) {
      const held = BigInt(row.holdingUnits);
      if (units > held) {
        notes.push(
          `EXECUTION CLAMP: redeem(${r.seriesId}) narrowed ${fmt(units)} -> ${fmt(held < 0n ? 0n : held)} (live CoverToken holdings — the executor never widens)`,
        );
        units = held;
      }
    }
    if (units <= 0n) {
      notes.push(`redeem(${r.seriesId}) dropped: no live holdings to redeem`);
      continue;
    }
    const payout = (units * ratio) / 10n ** 18n;
    txs.push({
      name: `redeem(${r.seriesId}, ${fmt(units)}) [burns cover, collects ~${fmt(payout)} at ratio ${ratio}]`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "redeem",
      args: [BigInt(r.seriesId), units],
      value: 0n,
      fallbackGas: 120_000n,
    });
  }

  // ---- 4. SELL: createSeries (escrow!) ---------------------------------------
  let escrowNeed = 0n;
  let createTx = null;
  if (p.newSeries) {
    const s = p.newSeries;
    // RE-RUN IDEMPOTENCE: when live state already shows an operator-book OPEN
    // series with the SAME strikes and obs window, this createSeries is a
    // replay of an already-landed leg (partial re-run) — drop it, never
    // double-escrow.
    const duplicate = Object.entries(seriesById).find(([, row]) => {
      if (!row || !operatorOwned(row)) return false;
      if (row.settled || row.cancelled) return false;
      if (Number(row.saleEnd) <= nowSec) return false; // sale not open
      if (row.strikeLowCents === undefined || row.obsStart === undefined || row.obsEnd === undefined) return false;
      return (
        BigInt(row.strikeLowCents) === s.strikeLowCents &&
        BigInt(row.strikeHighCents) === s.strikeHighCents &&
        BigInt(row.obsStart) === s.obsStart &&
        BigInt(row.obsEnd) === s.obsEnd
      );
    });
    if (duplicate) {
      notes.push(
        `createSeries dropped: live series ${duplicate[0]} (creator ${duplicate[1].creator}) already OPEN with the same strikes ${s.strikeLowCents}/${s.strikeHighCents}c and obs window [${s.obsStart}, ${s.obsEnd}] — re-run protection, never double-escrow`,
      );
    } else if (s.saleEnd <= BigInt(Math.floor(nowSec))) {
      notes.push(`createSeries dropped: plan saleEnd ${s.saleEnd} is not in the future of the live block ${nowSec} (stale plan)`);
    } else if (s.capacity < dust) {
      notes.push(`createSeries dropped: capacity ${fmt(s.capacity)} is dust (< ${fmt(dust)})`);
    } else {
      escrowNeed = s.capacity;
      createTx = {
        name: `createSeries(strikes ${s.strikeLowCents}/${s.strikeHighCents}c, ${s.premiumRateBps} bps, capacity ${fmt(s.capacity)} ESCROWED)`,
        address: addresses.pool,
        abi: POOL_ABI,
        functionName: "createSeries",
        args: [
          Number(s.strikeLowCents),
          Number(s.strikeHighCents),
          Number(s.premiumRateBps),
          s.saleEnd,
          s.obsStart,
          s.obsEnd,
          s.redeemEnd,
          s.capacity,
        ],
        value: 0n,
        fallbackGas: 260_000n,
      };
    }
  }

  // ---- 5. BUY legs: narrow to live capacity, drop what went stale -------------
  const buyTxs = [];
  for (const b of p.buys) {
    const row = liveRow(b.seriesId, "buyProtection");
    if (!row) continue;
    if (mine(row)) {
      notes.push(`buyProtection(${b.seriesId}) dropped: our own series — the book never buys from itself`);
      continue;
    }
    if (operatorOwned(row)) {
      notes.push(
        `buyProtection(${b.seriesId}) dropped: creator ${row.creator} is an operator wallet — never buy any operator wallet's series (self-dealing prevention)`,
      );
      continue;
    }
    if (row.settled || row.cancelled) {
      notes.push(`buyProtection(${b.seriesId}) dropped: series settled/cancelled since decide`);
      continue;
    }
    if (row.paused) {
      notes.push(`buyProtection(${b.seriesId}) dropped: series paused since decide (SalesArePaused)`);
      continue;
    }
    if (nowSec > Number(row.saleEnd)) {
      notes.push(`buyProtection(${b.seriesId}) dropped: sale closed at ${row.saleEnd} (SaleClosed)`);
      continue;
    }
    const capacityLeft = BigInt(row.escrowUnits) - BigInt(row.soldUnits);
    let claim = b.maxClaim;
    // RE-RUN IDEMPOTENCE: live holdings count against the per-series cap. A
    // wallet already holding cover on this series (a landed buy from a prior
    // partial run) may only buy up to the cap headroom — a verbatim re-run of
    // an executed plan drops to nothing instead of doubling exposure.
    if (row.holdingUnits !== undefined && row.holdingUnits !== null && BigInt(row.holdingUnits) > 0n) {
      const held = BigInt(row.holdingUnits);
      const capLive = (capacityLeft * BigInt(cfg.BUY_SERIES_CAP_BPS)) / 10_000n;
      if (held >= capLive) {
        notes.push(
          `buyProtection(${b.seriesId}) dropped: already hold ${fmt(held)} >= live per-series cap ${fmt(capLive)} — re-run/idempotence guard`,
        );
        continue;
      }
      if (claim > capLive - held) {
        notes.push(
          `EXECUTION CLAMP: buy(${b.seriesId}) narrowed ${fmt(claim)} -> ${fmt(capLive - held)} (per-series cap net of ${fmt(held)} already held)`,
        );
        claim = capLive - held;
      }
    }
    if (claim > capacityLeft) {
      notes.push(
        `EXECUTION CLAMP: buy(${b.seriesId}) narrowed ${fmt(claim)} -> ${fmt(capacityLeft < 0n ? 0n : capacityLeft)} (live unsold capacity; others bought since decide — the executor never widens)`,
      );
      claim = capacityLeft;
    }
    if (claim < dust) {
      notes.push(`buyProtection(${b.seriesId}) dropped: live size ${fmt(claim < 0n ? 0n : claim)} is dust (< ${fmt(dust)})`);
      continue;
    }
    const rate = BigInt(row.premiumRateBps);
    const premium = (claim * rate) / 10_000n; // contract: floor(maxClaim × rate / 1e4)
    if (premium === 0n && rate > 0n) {
      notes.push(`buyProtection(${b.seriesId}) dropped: premium rounds to zero (PremiumRoundsToZero)`);
      continue;
    }
    if (premium > b.maxPremium) {
      notes.push(
        `buyProtection(${b.seriesId}) dropped: live premium ${fmt(premium)} exceeds the plan's authorized maxPremium ${fmt(b.maxPremium)} — never pay more than the policy priced`,
      );
      continue;
    }
    buyTxs.push({
      name: `buyProtection(${b.seriesId}, maxClaim ${fmt(claim)}, maxPremium ${fmt(premium)})`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "buyProtection",
      args: [BigInt(b.seriesId), claim, premium],
      value: 0n,
      fallbackGas: 160_000n,
      premiumUnits: premium,
    });
  }

  // ---- 6. balance refusal: escrow + Σ premiums must fit the wallet -----------
  const premiumsNeed = buyTxs.reduce((a, t) => a + t.premiumUnits, 0n);
  const totalPull = escrowNeed + premiumsNeed;
  if (totalPull > state.currencyUnits) {
    throw new PlanError(
      `wallet balance ${fmt(state.currencyUnits)} < escrow ${fmt(escrowNeed)} + Σ buy premiums ${fmt(premiumsNeed)} — refusing the batch (top up or shrink the plan)`,
    );
  }

  // ---- 7. exact approvals, running-allowance simulation -----------------------
  // Each pulling tx gets an EXACT absolute approve when the projected allowance
  // is short; the pull consumes it back down. At most one dangling exact
  // approval can survive an aborted batch, and the next run re-reads it.
  let projected = state.allowanceUnits;
  const withApprovals = [];
  const pulls = [];
  if (createTx) pulls.push({ tx: createTx, need: escrowNeed, what: "createSeries escrow" });
  for (const t of buyTxs) pulls.push({ tx: t, need: t.premiumUnits, what: `buy #${t.args[0]} premium` });
  for (const { tx, need, what } of pulls) {
    if (projected < need) {
      withApprovals.push({
        name: `approve pool for exactly ${fmt(need)} (${what})`,
        address: addresses.currency,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [addresses.pool, need],
        value: 0n,
        fallbackGas: 60_000n,
      });
      projected = need;
    }
    withApprovals.push(tx);
    projected -= need;
  }
  txs.push(...withApprovals);

  // ---- 8. unpause (pause:false) stays LAST ------------------------------------
  txs.push(...unpauses);

  const clean = txs.map(({ premiumUnits, ...t }) => t);
  return { txs: clean, notes, plan: p, budget: computeBudget(clean) };
}

function explainRevert(err) {
  const data =
    err?.cause?.data ?? err?.data ?? (typeof err?.cause?.cause?.data === "string" ? err.cause.cause.data : undefined);
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: POOL_ABI, data });
      return `custom error ${decoded.errorName}(${(decoded.args ?? []).join(", ")})`;
    } catch {
      /* not one of ours */
    }
  }
  return err?.shortMessage ?? err?.message ?? String(err);
}

/**
 * Build the Direct executor.
 *
 * opts:
 *   addresses    contract addresses { pool, currency, token, oracle, router }
 *                (default: the Gnosis target — executors/targets.mjs)
 *   chain        viem chain object (default gnosis)
 *   rpcUrl       default: the target env override, then the chain default
 *   privateKey   default env DEPLOYER_PRIVATE_KEY (repo-root .env auto-loaded;
 *                the key is NEVER logged)
 *   impersonate  address string — JSON-RPC account (anvil fork tests, or the
 *                read-only probe the Bankr rail uses for state + simulation)
 *   explorerTx   hash -> url (default: the target's explorer when resolvable)
 *   log          line logger (default console.log)
 */
export function createDirectExecutor({
  rpcUrl,
  privateKey,
  impersonate,
  addresses = TARGETS.gnosis.addresses,
  chain = TARGETS.gnosis.chain,
  explorerTx,
  config = {},
  log = console.log,
} = {}) {
  loadEnv();
  const targetLike = Object.values(TARGETS).find((t) => t.chainId === chain?.id);
  rpcUrl ??= targetLike ? targetRpcUrl(targetLike) : undefined;
  if (!rpcUrl) throw new Error("createDirectExecutor: rpcUrl required (no registry default for this chain)");
  explorerTx ??= targetLike?.explorerTx ?? ((hash) => hash);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  let account;
  if (impersonate) {
    account = impersonate; // viem json-rpc account: txs go out as eth_sendTransaction
  } else {
    let pk = privateKey ?? process.env.DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set (env or repo-root .env)");
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    account = privateKeyToAccount(pk);
  }
  const walletClient = createWalletClient({ chain, transport, account });
  const address = typeof account === "string" ? account : account.address;

  /**
   * LIVE state read AS the executing wallet: balances, allowance, decimals
   * (drives the caps), and the FULL series map (any plan leg may reference any
   * id). A single undecodable series is skipped with a note-able marker — it
   * must never kill the whole read (market-scan robustness law).
   */
  async function readState() {
    const read = (addr, abi, functionName, args = []) =>
      publicClient.readContract({ address: addr, abi, functionName, args });
    const [block, chainId, nativeWei, currencyUnits, allowanceUnits, decimals, seriesCountBig] = await Promise.all([
      publicClient.getBlock(),
      publicClient.getChainId(),
      publicClient.getBalance({ address }),
      read(addresses.currency, ERC20_ABI, "balanceOf", [address]),
      read(addresses.currency, ERC20_ABI, "allowance", [address, addresses.pool]),
      read(addresses.currency, ERC20_ABI, "decimals"),
      read(addresses.pool, POOL_ABI, "seriesCount"),
    ]);
    const seriesCount = Number(seriesCountBig);
    const seriesById = {};
    const unreadable = [];
    const rows = await Promise.allSettled(
      Array.from({ length: seriesCount }, (_, i) =>
        Promise.all([
          read(addresses.pool, POOL_ABI, "series", [BigInt(i)]),
          read(addresses.pool, POOL_ABI, "seriesPaused", [BigInt(i)]),
          // The executing wallet's CoverToken balance per series (soulbound):
          // drives the redeem narrowing and the buy-side idempotence guard.
          addresses.token ? read(addresses.token, COVER_TOKEN_ABI, "balanceOf", [address, BigInt(i)]) : 0n,
        ]),
      ),
    );
    rows.forEach((r, i) => {
      if (r.status !== "fulfilled") {
        unreadable.push({ id: i, error: r.reason?.shortMessage ?? String(r.reason) });
        return;
      }
      const [s, paused, holding] = r.value;
      seriesById[i] = {
        creator: s.creator,
        strikeLowCents: Number(s.strikeLowCents),
        strikeHighCents: Number(s.strikeHighCents),
        premiumRateBps: Number(s.premiumRateBps),
        settled: s.settled,
        cancelled: s.cancelled,
        paused,
        saleEnd: Number(s.saleEnd),
        obsStart: Number(s.obsStart),
        obsEnd: Number(s.obsEnd),
        redeemEnd: Number(s.redeemEnd),
        escrowUnits: s.escrow,
        soldUnits: s.sold,
        residualWithdrawn: s.residualWithdrawn,
        payoutRatioWad: s.payoutRatioWad,
        holdingUnits: BigInt(holding),
      };
    });
    return {
      address,
      chainId: Number(chainId),
      nowSec: Number(block.timestamp),
      decimals: Number(decimals),
      nativeWei,
      currencyUnits,
      allowanceUnits,
      seriesCount,
      seriesById,
      unreadable,
    };
  }

  /**
   * Execute a Plan. { dryRun: true } computes + gas-estimates the tx list and
   * returns it WITHOUT sending anything. Live mode sends sequentially, waits
   * for each receipt, prints explorer links, and aborts the batch on the first
   * failure (PARTIAL upstream: ok:false with executed.length > 0).
   */
  async function execute(plan, { dryRun = false } = {}) {
    const state = await readState();
    for (const u of state.unreadable) log(`  note: series ${u.id} unreadable (${u.error}) — excluded from live checks`);

    let diff;
    try {
      diff = computeTxDiff(plan, state, { addresses, config });
    } catch (err) {
      if (err instanceof PlanError) return { ok: false, dryRun, error: `invalid plan: ${err.message}`, executed: [] };
      throw err;
    }
    const { txs, notes, budget } = diff;
    for (const n of notes) log(`  note: ${n}`);
    if (txs.length === 0) return { ok: true, dryRun, txs: [], notes, executed: [], summary: "no-op: chain already matches plan" };

    // Gas plan: estimate each tx (later txs may legitimately fail estimation
    // because they depend on earlier ones landing, e.g. buy before its approve
    // is mined — fall back to the per-builder default).
    const gasPriceWei = await publicClient.getGasPrice();
    let totalGas = 0n;
    const planned = [];
    for (const tx of txs) {
      const req = { address: tx.address, abi: tx.abi, functionName: tx.functionName, args: tx.args, value: tx.value, account };
      let gas;
      let gasSource = "estimated";
      try {
        gas = await publicClient.estimateContractGas(req);
      } catch (err) {
        gas = tx.fallbackGas;
        gasSource = `fallback (${explainRevert(err).slice(0, 80)})`;
      }
      totalGas += gas;
      planned.push({ ...tx, gas, gasSource });
    }
    const estFeeWei = totalGas * gasPriceWei;

    // Gas margin: refuse to SEND unless the wallet holds 3× estimated fees in
    // the native token. A dry run still returns the tx list, with the shortfall
    // reported. (Currency sufficiency — escrow + Σ premiums — was already
    // enforced inside computeTxDiff against the same live state.)
    const requiredWei = 3n * estFeeWei;
    const gasSanity = {
      ok: state.nativeWei >= requiredWei,
      nativeWei: state.nativeWei,
      requiredWei,
      detail: `3x estimated fees = ${formatUnits(requiredWei, 18)} native required, wallet holds ${formatUnits(state.nativeWei, 18)}`,
    };

    if (dryRun) {
      log(`  DRY RUN — ${planned.length} tx(s), est total gas ${totalGas} (~${formatUnits(estFeeWei, 18)} native); nothing sent`);
      for (const t of planned) log(`    - ${t.name} [${t.gas} gas, ${t.gasSource}]`);
      if (!gasSanity.ok) log(`  NOTE gas sanity would refuse a live run: ${gasSanity.detail}`);
      return {
        ok: true,
        dryRun: true,
        txs: planned.map(({ abi, ...t }) => t), // strip abi objects from the report
        notes,
        budget,
        totalGas,
        gasPriceWei,
        estFeeWei,
        gasSanity,
        executed: [],
      };
    }

    if (!gasSanity.ok) {
      return {
        ok: false,
        dryRun: false,
        error: `gas sanity: refusing to send — ${gasSanity.detail}. Top up the wallet's native balance first.`,
        gasSanity,
        txs: planned.map(({ abi, ...t }) => t),
        executed: [],
      };
    }

    // Send sequentially: simulate immediately before each send, wait for the
    // receipt, abort the whole batch on the first failure.
    const executed = [];
    for (const tx of planned) {
      const req = { address: tx.address, abi: tx.abi, functionName: tx.functionName, args: tx.args, value: tx.value, account };
      try {
        const { request } = await publicClient.simulateContract(req);
        log(`  sending: ${tx.name}`);
        const hash = await walletClient.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const link = explorerTx(hash);
        if (receipt.status !== "success") {
          log(`  REVERTED: ${tx.name} — ${link}`);
          return { ok: false, dryRun: false, error: `${tx.name} reverted on-chain`, failed: { name: tx.name, hash, link }, executed, notes };
        }
        const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
        log(`  OK ${tx.name}: block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}, fee ${formatUnits(feeWei, 18)} native`);
        log(`     ${link}`);
        executed.push({ name: tx.name, functionName: tx.functionName, hash, link, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, feeWei });
      } catch (err) {
        const why = explainRevert(err);
        log(`  ABORT batch at "${tx.name}": ${why}`);
        return { ok: false, dryRun: false, error: `${tx.name} failed: ${why}`, failed: { name: tx.name }, executed, notes };
      }
    }
    return { ok: true, dryRun: false, executed, notes, budget };
  }

  return { name: "direct", enabled: true, address, addresses, chain, publicClient, walletClient, readState, execute };
}
