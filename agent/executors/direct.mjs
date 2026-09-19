/**
 * direct.mjs — THE Gnosis writer. The only executor that actually moves the CoverPool.
 *
 * Consumes a Plan (shared shape with the policy agent's decide.mjs):
 *   {
 *     targetFreeCapitalWei: bigint|string|null,   // desired pool freeCapital; null = leave as-is
 *     newSeries: {                                 // or null
 *       strikeLowCents, strikeHighCents, premiumRateBps,
 *       saleEnd, obsStart, obsEnd, redeemEnd, capacity   // capacityWei accepted as alias
 *     },
 *     pause: boolean|null,                         // desired salesPaused; null = leave as-is
 *     rationale: string[]
 *   }
 * plus decide.mjs extras: refused:true short-circuits to a no-op; capitalDeltaWei
 * (when present) is an execution-time BOUND: the diff is recomputed from live
 * chain state, but the executed delta is re-clamped to min(|capitalDeltaWei|,
 * MAX_CAPITAL_DELTA_WEI) and the batch REFUSES outright when the live delta
 * exceeds the 0.5 WXDAI per-run hard cap (freeCapital drift between decide()
 * and execution must never widen the move).
 *
 * Pipeline: readState() → computeTxDiff() (pure, unit-tested) → per-tx gas estimate +
 * gas sanity (refuse if xDAI < wrap value + 3× estimated total fees) → dry-run returns
 * the tx list without sending; otherwise each tx is simulateContract()'d immediately
 * before sending, sent sequentially with receipt waits + Blockscout links, and the
 * batch ABORTS on the first failure (later txs are never attempted).
 *
 * Sponsor levers (fundPool / withdrawExcess / createSeries / setSalesPaused) are all
 * onlySponsor and the sponsor is immutable, so execute() refuses up front when the
 * signing account is not the on-chain sponsor.
 */
import { createPublicClient, createWalletClient, http, formatEther, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import {
  ADDRESSES,
  POOL_ABI,
  WXDAI_ABI,
  DEFAULT_RPC_URL,
  BLOCKSCOUT_TX,
  loadEnv,
} from "./chain.mjs";
import { DEFAULT_CONFIG } from "../policy/decide.mjs";

export class PlanError extends Error {}

// Safety caps shared with the policy (single source of truth: DEFAULT_CONFIG).
// Re-enforced HERE because computeTxDiff re-derives the delta from LIVE state.
export const MAX_CAPITAL_DELTA_WEI = DEFAULT_CONFIG.MAX_CAPITAL_DELTA_WEI;
export const MIN_ACTION_DELTA_WEI = DEFAULT_CONFIG.MIN_ACTION_DELTA_WEI;

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

/**
 * Validate + normalize a Plan into bigints. Throws PlanError on shape/invariant
 * violations (mirrors CoverPool.createSeries's own reverts so bad plans die locally,
 * never on-chain).
 */
export function validatePlan(plan) {
  if (plan === null || typeof plan !== "object") throw new PlanError("plan must be an object");

  // decide.mjs sets refused:true when the policy wants NOTHING done on-chain.
  if (plan.refused === true) {
    return { refused: true, targetFreeCapitalWei: null, capitalDeltaWei: null, newSeries: null, pause: null, rationale: Array.isArray(plan.rationale) ? plan.rationale.map(String) : [] };
  }

  let target = null;
  if (plan.targetFreeCapitalWei !== null && plan.targetFreeCapitalWei !== undefined) {
    target = asBigInt(plan.targetFreeCapitalWei, "targetFreeCapitalWei");
    if (target < 0n) throw new PlanError("plan.targetFreeCapitalWei must be >= 0");
  }

  // The policy's post-clamp delta (may be negative). When present it BOUNDS the
  // delta the executor may derive from live state — the executor never widens.
  let capitalDeltaWei = null;
  if (plan.capitalDeltaWei !== null && plan.capitalDeltaWei !== undefined) {
    capitalDeltaWei = asBigInt(plan.capitalDeltaWei, "capitalDeltaWei");
  }

  let newSeries = null;
  if (plan.newSeries !== null && plan.newSeries !== undefined) {
    // decide.mjs names the last field capacityWei; the contract arg is capacity.
    const s = { ...plan.newSeries, capacity: plan.newSeries.capacity ?? plan.newSeries.capacityWei };
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
    if (!(newSeries.strikeLowCents < newSeries.strikeHighCents))
      throw new PlanError("newSeries: strikeLowCents must be < strikeHighCents");
    if (newSeries.saleEnd > newSeries.obsEnd) throw new PlanError("newSeries: saleEnd must be <= obsEnd");
    if (!(newSeries.obsStart < newSeries.obsEnd && newSeries.obsEnd < newSeries.redeemEnd))
      throw new PlanError("newSeries: need obsStart < obsEnd < redeemEnd");
    if (newSeries.capacity === 0n) throw new PlanError("newSeries: capacity must be > 0");
    // Policy sanity (not a contract rule): premium above 100% is nonsense.
    if (newSeries.premiumRateBps > 10_000n) throw new PlanError("newSeries: premiumRateBps > 10000");
  }

  let pause = null;
  if (plan.pause !== null && plan.pause !== undefined) {
    if (typeof plan.pause !== "boolean") throw new PlanError("plan.pause must be boolean or null");
    pause = plan.pause;
  }

  const rationale = Array.isArray(plan.rationale) ? plan.rationale.map(String) : [];
  return { targetFreeCapitalWei: target, capitalDeltaWei, newSeries, pause, rationale };
}

/**
 * Pure diff: Plan × chain state → ordered tx descriptors. No I/O, unit-tested with
 * fake state fixtures. State shape:
 *   { xdaiWei, wxdaiWei, allowanceWei, freeCapitalWei, salesPaused, seriesCount }
 *
 * Order: setSalesPaused(true) FIRST (safety before capital moves — a failing
 * capital tx must never starve a pause) → wrap → approve → fundPool |
 * withdrawExcess → createSeries → setSalesPaused(false) LAST (only ever
 * unpause after everything else landed).
 */
export function computeTxDiff(plan, state, { addresses = ADDRESSES } = {}) {
  const p = validatePlan(plan);
  for (const k of ["xdaiWei", "wxdaiWei", "allowanceWei", "freeCapitalWei"]) {
    if (typeof state?.[k] !== "bigint") throw new PlanError(`state.${k} must be a bigint`);
  }
  if (typeof state.salesPaused !== "boolean") throw new PlanError("state.salesPaused must be boolean");

  const txs = [];
  const notes = [];

  if (p.refused) {
    notes.push("plan refused by policy (refused:true) — no on-chain action");
    return { txs, notes, plan: p };
  }

  // pause:true goes FIRST: it is the safety action and must not be starved by
  // an earlier failing capital/series tx (the batch aborts on first failure).
  // Only buyProtection checks salesPaused on-chain, so the later capital moves
  // and createSeries are unaffected by pausing up front.
  const pauseTx =
    p.pause !== null && p.pause !== state.salesPaused
      ? {
          name: `setSalesPaused(${p.pause}) [GLOBAL switch — never blocks settle/redeem]`,
          address: addresses.pool,
          abi: POOL_ABI,
          functionName: "setSalesPaused",
          args: [p.pause],
          value: 0n,
          fallbackGas: 50_000n,
        }
      : null;
  if (p.pause !== null && pauseTx === null) {
    notes.push(`pause: salesPaused already ${state.salesPaused} — no tx`);
  }
  if (pauseTx && p.pause === true) txs.push(pauseTx);

  if (p.targetFreeCapitalWei !== null) {
    // EXECUTION-TIME SAFETY CLAMP: the delta is re-derived from LIVE freeCapital,
    // which may have drifted since decide() ran (open sale windows let anyone
    // move freeCapital between the two reads). Enforce the caps on the delta
    // actually executed:
    //   1. |live delta| > MAX_CAPITAL_DELTA_WEI (0.5 WXDAI hard per-run cap)
    //      => REFUSE the whole batch — the next run re-decides from fresh state;
    //   2. |live delta| > |plan.capitalDeltaWei| (the policy's clamped intent)
    //      => narrow to the plan's magnitude — the executor never widens a plan;
    //   3. |live delta| < MIN_ACTION_DELTA_WEI => dust, no capital tx.
    let delta = p.targetFreeCapitalWei - state.freeCapitalWei;
    const abs = (x) => (x < 0n ? -x : x);
    if (abs(delta) > MAX_CAPITAL_DELTA_WEI) {
      throw new PlanError(
        `live capital delta ${formatEther(delta)} WXDAI exceeds the ±${formatEther(MAX_CAPITAL_DELTA_WEI)} per-run cap — freeCapital drifted since the plan was decided; refusing (re-run to re-decide from fresh state)`,
      );
    }
    if (p.capitalDeltaWei !== null && abs(delta) > abs(p.capitalDeltaWei)) {
      const clamped = delta > 0n ? abs(p.capitalDeltaWei) : -abs(p.capitalDeltaWei);
      notes.push(
        `EXECUTION CLAMP: live capital delta ${formatEther(delta)} WXDAI narrowed to the plan's clamped delta ${formatEther(clamped)} WXDAI (freeCapital drifted since decide; the executor never widens a plan)`,
      );
      delta = clamped;
    }
    if (delta !== 0n && abs(delta) < MIN_ACTION_DELTA_WEI) {
      notes.push(`capital: live delta ${delta} wei is dust (< ${MIN_ACTION_DELTA_WEI}) — no capital tx`);
      delta = 0n;
    }
    if (delta > 0n) {
      const fund = delta;
      const wrap = fund > state.wxdaiWei ? fund - state.wxdaiWei : 0n;
      if (wrap > 0n) {
        if (wrap > state.xdaiWei)
          throw new PlanError(
            `cannot reach targetFreeCapital: need to wrap ${formatEther(wrap)} xDAI but sponsor only holds ${formatEther(state.xdaiWei)}`,
          );
        txs.push({
          name: `wrap ${formatEther(wrap)} xDAI -> WXDAI (deposit)`,
          address: addresses.currency,
          abi: WXDAI_ABI,
          functionName: "deposit",
          args: [],
          value: wrap,
          fallbackGas: 45_000n,
        });
      }
      if (state.allowanceWei < fund) {
        // Approve the EXACT amount fundPool will pull; fundPool consumes it back to 0.
        txs.push({
          name: `approve pool for exactly ${formatEther(fund)} WXDAI`,
          address: addresses.currency,
          abi: WXDAI_ABI,
          functionName: "approve",
          args: [addresses.pool, fund],
          value: 0n,
          fallbackGas: 55_000n,
        });
      }
      txs.push({
        name: `fundPool(${formatEther(fund)})`,
        address: addresses.pool,
        abi: POOL_ABI,
        functionName: "fundPool",
        args: [fund],
        value: 0n,
        fallbackGas: 90_000n,
      });
    } else if (delta < 0n) {
      const out = -delta; // <= freeCapital by construction (target >= 0)
      txs.push({
        name: `withdrawExcess(${formatEther(out)})`,
        address: addresses.pool,
        abi: POOL_ABI,
        functionName: "withdrawExcess",
        args: [out],
        value: 0n,
        fallbackGas: 80_000n,
      });
    } else {
      notes.push("capital: freeCapital already at target — no fund/withdraw tx");
    }
  }

  if (p.newSeries) {
    const s = p.newSeries;
    if (s.saleEnd > s.obsStart)
      notes.push(
        "WARNING newSeries: saleEnd > obsStart — sales overlap the observation window (informed-trading caveat, docs/PROTOCOL.md)",
      );
    txs.push({
      name: `createSeries(strikes ${s.strikeLowCents}/${s.strikeHighCents} cents, ${s.premiumRateBps} bps, capacity ${formatEther(s.capacity)})`,
      address: addresses.pool,
      abi: POOL_ABI,
      functionName: "createSeries",
      args: [s.strikeLowCents, s.strikeHighCents, s.premiumRateBps, s.saleEnd, s.obsStart, s.obsEnd, s.redeemEnd, s.capacity],
      value: 0n,
      fallbackGas: 200_000n,
    });
  }

  // pause:false (unpause) stays LAST: never resume sales until every other
  // action in the batch has landed.
  if (pauseTx && p.pause === false) txs.push(pauseTx);

  return { txs, notes, plan: p };
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
 *   rpcUrl       default env GNOSIS_RPC_URL, then https://rpc.gnosischain.com
 *   privateKey   default env DEPLOYER_PRIVATE_KEY (repo-root .env is auto-loaded;
 *                the key is NEVER logged)
 *   impersonate  address string — JSON-RPC account for anvil fork tests
 *                (anvil_impersonateAccount must have been called by the test)
 *   addresses    override contract addresses (defaults: live Gnosis deployment)
 *   log          line logger (default console.log)
 */
export function createDirectExecutor({
  rpcUrl,
  privateKey,
  impersonate,
  addresses = ADDRESSES,
  chain = gnosis,
  log = console.log,
} = {}) {
  loadEnv();
  rpcUrl ??= process.env.GNOSIS_RPC_URL ?? DEFAULT_RPC_URL;
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

  async function readState() {
    const [xdaiWei, wxdaiWei, allowanceWei, poolBalanceWei, totalReservedWei, salesPaused, seriesCount, sponsor] =
      await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ address: addresses.currency, abi: WXDAI_ABI, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({
          address: addresses.currency,
          abi: WXDAI_ABI,
          functionName: "allowance",
          args: [address, addresses.pool],
        }),
        publicClient.readContract({ address: addresses.currency, abi: WXDAI_ABI, functionName: "balanceOf", args: [addresses.pool] }),
        publicClient.readContract({ address: addresses.pool, abi: POOL_ABI, functionName: "totalReserved" }),
        publicClient.readContract({ address: addresses.pool, abi: POOL_ABI, functionName: "salesPaused" }),
        publicClient.readContract({ address: addresses.pool, abi: POOL_ABI, functionName: "seriesCount" }),
        publicClient.readContract({ address: addresses.pool, abi: POOL_ABI, functionName: "sponsor" }),
      ]);
    // freeCapital = pool currency balance − Σ reservedOf (matches CoverPool.freeCapital()).
    const freeCapitalWei = poolBalanceWei > totalReservedWei ? poolBalanceWei - totalReservedWei : 0n;
    return { xdaiWei, wxdaiWei, allowanceWei, poolBalanceWei, totalReservedWei, freeCapitalWei, salesPaused, seriesCount, sponsor };
  }

  /**
   * Execute a Plan. { dryRun: true } computes + gas-estimates the tx list and returns
   * it WITHOUT sending anything. Live mode sends sequentially, waits for each receipt,
   * prints Blockscout links, and aborts the batch on the first failure.
   */
  async function execute(plan, { dryRun = false } = {}) {
    const state = await readState();

    let diff;
    try {
      diff = computeTxDiff(plan, state, { addresses });
    } catch (err) {
      if (err instanceof PlanError) return { ok: false, dryRun, error: `invalid plan: ${err.message}`, executed: [] };
      throw err;
    }
    const { txs, notes } = diff;
    for (const n of notes) log(`  note: ${n}`);
    if (txs.length === 0) return { ok: true, dryRun, txs: [], notes, executed: [], summary: "no-op: chain already matches plan" };

    // Every pool write below is onlySponsor and the sponsor is immutable — refuse early.
    if (state.sponsor.toLowerCase() !== address.toLowerCase()) {
      return {
        ok: false,
        dryRun,
        error: `account ${address} is not the pool sponsor ${state.sponsor} — sponsor levers would revert NotSponsor()`,
        executed: [],
      };
    }

    // Gas plan: estimate each tx (later txs may legitimately fail estimation because they
    // depend on earlier ones landing, e.g. fundPool before approve is mined — fall back).
    const gasPriceWei = await publicClient.getGasPrice();
    let totalGas = 0n;
    let wrapValueWei = 0n;
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
      wrapValueWei += tx.value;
      planned.push({ ...tx, gas, gasSource });
    }
    const estFeeWei = totalGas * gasPriceWei;

    // Gas sanity: refuse to SEND unless the sponsor holds the wrapped value PLUS
    // 3× estimated fees. A dry run still returns the tx list, with the shortfall reported.
    const requiredWei = wrapValueWei + 3n * estFeeWei;
    const gasSanity = {
      ok: state.xdaiWei >= requiredWei,
      xdaiWei: state.xdaiWei,
      requiredWei,
      detail: `wrap ${formatEther(wrapValueWei)} xDAI + 3x estimated fees ${formatEther(estFeeWei)} = ${formatEther(requiredWei)} required, sponsor holds ${formatEther(state.xdaiWei)}`,
    };

    if (dryRun) {
      log(`  DRY RUN — ${planned.length} tx(s), est total gas ${totalGas} (~${formatEther(estFeeWei)} xDAI); nothing sent`);
      for (const t of planned) log(`    - ${t.name} [${t.gas} gas, ${t.gasSource}]`);
      if (!gasSanity.ok) log(`  NOTE gas sanity would refuse a live run: ${gasSanity.detail}`);
      return {
        ok: true,
        dryRun: true,
        txs: planned.map(({ abi, ...t }) => t), // strip abi objects from the report
        notes,
        totalGas,
        gasPriceWei,
        estFeeWei,
        gasSanity,
        executed: [],
      };
    }

    if (!gasSanity.ok) {
      return { ok: false, dryRun: false, error: `gas sanity: refusing to send — ${gasSanity.detail}. Top up sponsor xDAI first.`, gasSanity, txs: planned.map(({ abi, ...t }) => t), executed: [] };
    }

    // Send sequentially: simulate immediately before each send, wait for the receipt,
    // abort the whole batch on the first failure.
    const executed = [];
    for (const tx of planned) {
      const req = { address: tx.address, abi: tx.abi, functionName: tx.functionName, args: tx.args, value: tx.value, account };
      try {
        const { request } = await publicClient.simulateContract(req);
        log(`  sending: ${tx.name}`);
        const hash = await walletClient.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const link = BLOCKSCOUT_TX(hash);
        if (receipt.status !== "success") {
          log(`  REVERTED: ${tx.name} — ${link}`);
          return { ok: false, dryRun: false, error: `${tx.name} reverted on-chain`, failed: { name: tx.name, hash, link }, executed, notes };
        }
        const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
        log(`  OK ${tx.name}: block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}, fee ${formatEther(feeWei)} xDAI`);
        log(`     ${link}`);
        executed.push({ name: tx.name, functionName: tx.functionName, hash, link, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, feeWei });
      } catch (err) {
        const why = explainRevert(err);
        log(`  ABORT batch at "${tx.name}": ${why}`);
        return { ok: false, dryRun: false, error: `${tx.name} failed: ${why}`, failed: { name: tx.name }, executed, notes };
      }
    }
    return { ok: true, dryRun: false, executed, notes };
  }

  return { name: "direct", enabled: true, address, addresses, publicClient, walletClient, readState, execute };
}
