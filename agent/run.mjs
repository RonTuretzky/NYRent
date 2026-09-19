#!/usr/bin/env node
/**
 * run.mjs — daily two-sided market-maker runner for NY Rent Cover.
 *
 *   signals (collectors/, real endpoints, gathered ONCE) ──┐
 *                                                          ├─> per TARGET:
 *   targets.mjs registry (gnosis WXDAI / arbitrum USDC) ───┘
 *       read chain state (viem):
 *         FULL open-series market scan — seriesCount + per-series struct +
 *         creator + seriesPaused + own CoverToken balances (holdings)
 *       → decide() (policy/decide.mjs, pure: SELL/BUY/manage plan)
 *       → per-target report: two-sided plan + P&L block
 *       → --execute (per target): executors/index.mjs (direct | bankr routing)
 *
 * DRY-RUN BY DEFAULT: without --execute nothing is ever written on-chain and
 * no private key is needed. Collector failure is tolerated (the policy then
 * leans on the on-chain oracle prints alone); a chain-read failure on ONE
 * target refuses THAT target only (per-target isolation) — the other targets
 * still run.
 *
 * P&L block (per target, cumulative, in the target currency's base units):
 *   premiumsEarned      Σ premiumsAccrued over series we created  (chain state)
 *   residualsWithdrawn  Σ withdrawn over series we created        (chain state)
 *                       DECOMPOSED into escrowReturned (capital back) +
 *                       premiumIncome (income realized at withdrawal)
 *   claimsPaid          Σ paidOut over series we created — the sell book's
 *                       realized loss                             (chain state)
 *   premiumsPaid        Σ ProtectionBought.premium where buyer=us (events)
 *   redemptionsReceived Σ Redeemed.payout where holder=us         (events)
 *   redemptionsForgone  settled cover we held but never redeemed before
 *                       redeemEnd, valued units × ratio — the buy book's
 *                       realized loss                             (chain state)
 * Event totals (and the per-series PURCHASED-cover ledger that separates
 * bought cover from outsider-minted gifts) persist cumulatively in
 * runs/state-<chainId>.json (never rescanned from genesis; the scan cursor
 * advances monotonically).
 *
 * RUN LOCK: --execute takes runs/.lock (pid + timestamp, stale after 30 min)
 * and REFUSES to run concurrently with another --execute (exit 3).
 *
 * Flags:
 *   --execute [name[,name]]  act on-chain — all selected targets, or only the
 *                            named ones (others stay dry). Needs the target's
 *                            signer (DEPLOYER_PRIVATE_KEY) / Bankr gates.
 *   --target <name[,name]>   run only these targets (default: all)
 *   --skip-collectors        do not hit collector endpoints (chain-only signals)
 *
 * Env: GNOSIS_RPC_URL / ARBITRUM_RPC_URL (per-target override),
 *      DEPLOYER_PRIVATE_KEY (identity + signing for direct targets; NEVER printed),
 *      AGENT_ADDRESS / AGENT_ADDRESS_<TARGET> (identity without a key, dry runs),
 *      BANKR_WALLET (identity of the Bankr-custodied wallet on bankr targets),
 *      BANKR_API_KEY (optional: advisory + read-only /wallet/me check),
 *      AGENT_PNL_LOOKBACK_BLOCKS / AGENT_PNL_CHUNK_BLOCKS (P&L scan tuning).
 *
 * Exit codes (worst-of across targets): 0 ok/dry-run, 2 acted on-chain,
 * 3 refused, 4 PARTIAL (some txs landed, then the batch aborted — check the
 * listed tx hashes), 1 unexpected error. Severity order: 1 > 4 > 3 > 2 > 0.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { decide, DEFAULT_CONFIG } from "./policy/decide.mjs";
import {
  TARGETS,
  POOL_ABI,
  ERC20_ABI,
  COVER_TOKEN_ABI,
  ORACLE_ABI,
  rpcUrlsFor,
  fmtUnits,
} from "./targets.mjs";
import { jsonBigint, loadEnv } from "./executors/chain.mjs";

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(AGENT_DIR, "runs");

let stepNo = 0;
const step = (title) => console.log(`\n[${++stepNo}] ${title}`);
const info = (msg) => console.log(`    ${msg}`);

// ---------------------------------------------------------------------------
// Small pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Redact an RPC URL for logs and run reports: keep scheme + host only. RPC
 * providers commonly embed API keys in the path or query, and runs/*.json is
 * uploaded as a CI artifact — the full URL must never leave the process env.
 */
export function redactRpcUrl(rpcUrl) {
  try {
    const u = new URL(rpcUrl);
    const hadSecretParts = u.pathname !== "/" || u.search !== "" || u.username !== "" || u.password !== "";
    return `${u.protocol}//${u.host}${hadSecretParts ? " (path/query redacted)" : ""}`;
  } catch {
    return "<unparseable rpc url — redacted>";
  }
}

/** Worst-of across per-target exit codes; severity 1 > 4 > 3 > 2 > 0. */
export function overallExitCode(codes) {
  for (const c of [1, 4, 3, 2]) if (codes.includes(c)) return c;
  return 0;
}

/**
 * CLI parsing. --execute takes an OPTIONAL value naming which targets may act
 * (bare --execute = all selected targets act). --target filters which targets
 * run at all. Unknown names fail loud.
 */
export function parseArgs(argv, knownNames) {
  const out = { execute: false, executeTargets: null, skipCollectors: false, targets: null };
  const addNames = (bucket, v) => {
    const names = String(v).split(",").filter(Boolean);
    for (const n of names) {
      if (!knownNames.includes(n)) throw new Error(`unknown target "${n}" — known: ${knownNames.join(", ")}`);
    }
    return (bucket ?? []).concat(names);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-collectors") out.skipCollectors = true;
    else if (a === "--target") out.targets = addNames(out.targets, argv[++i]);
    else if (a.startsWith("--target=")) out.targets = addNames(out.targets, a.slice("--target=".length));
    else if (a === "--execute" || a.startsWith("--execute=")) {
      out.execute = true;
      if (a.includes("=")) out.executeTargets = addNames(out.executeTargets, a.slice("--execute=".length));
      else if (knownNames.includes(argv[i + 1])) out.executeTargets = addNames(out.executeTargets, argv[++i]);
    } else {
      throw new Error(`unknown flag "${a}" (flags: --execute [target], --target <name>, --skip-collectors)`);
    }
  }
  return out;
}

const isAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * Resolve the agent's identity for a target WITHOUT ever printing key material.
 * The identity FOLLOWS THE ACTIVE RAIL — the Bankr custody rail is dormant (on
 * hold), so bankr-capable targets resolve the custody identity ONLY under the
 * explicit BANKR_EXECUTE=1 opt-in; otherwise every target resolves the direct
 * (deployer) identity. decide() stamps this identity into the plan and the
 * executors refuse a plan whose identity is not the executing wallet, so a
 * plan can never be sized for one wallet and executed from another.
 *   custody opt-in (BANKR_EXECUTE=1, bankr target):
 *                   BANKR_WALLET → AGENT_ADDRESS_<NAME> → AGENT_ADDRESS → key-derived
 *   everything else: AGENT_ADDRESS_<NAME> → key-derived → AGENT_ADDRESS
 * Returns { address, source } or null (decide() then refuses, honestly).
 */
export function resolveWallet(target, env = process.env) {
  const fromKey = () => {
    let pk = env.DEPLOYER_PRIVATE_KEY;
    if (!pk) return null;
    try {
      if (!pk.startsWith("0x")) pk = "0x" + pk;
      return privateKeyToAccount(pk).address;
    } catch {
      return null;
    }
  };
  const specific = env[`AGENT_ADDRESS_${target.name.toUpperCase()}`];
  const custodyOptIn = target.executor === "bankr" && env.BANKR_EXECUTE === "1";
  const candidates = custodyOptIn
    ? [
        [env.BANKR_WALLET, "BANKR_WALLET"],
        [specific, `AGENT_ADDRESS_${target.name.toUpperCase()}`],
        [env.AGENT_ADDRESS, "AGENT_ADDRESS"],
        [fromKey, "DEPLOYER_PRIVATE_KEY (derived address)"],
      ]
    : [
        [specific, `AGENT_ADDRESS_${target.name.toUpperCase()}`],
        [fromKey, "DEPLOYER_PRIVATE_KEY (derived address)"],
        [env.AGENT_ADDRESS, "AGENT_ADDRESS"],
      ];
  for (const [c, source] of candidates) {
    const a = typeof c === "function" ? c() : c;
    if (isAddr(a)) return { address: a, source };
  }
  return null;
}

/**
 * Merge freshly scanned event totals into the persisted cumulative P&L state.
 * `purchasedUnitsBySeries` is the cumulative PURCHASED-cover ledger (units the
 * agent actually bought, per series, from ProtectionBought(buyer=agent)) — it
 * separates bought cover from outsider-minted soulbound gifts, which must
 * never steer the inventory lean.
 */
export function mergePnlState(
  prev,
  { premiumsPaidUnits = 0n, redemptionsReceivedUnits = 0n, purchasedUnitsBySeries = {}, scannedThrough },
) {
  const purchased = { ...(prev?.purchasedUnitsBySeries ?? {}) };
  for (const [id, units] of Object.entries(purchasedUnitsBySeries)) {
    purchased[id] = (BigInt(purchased[id] ?? 0n) + BigInt(units)).toString();
  }
  return {
    ...prev,
    premiumsPaidUnits: (BigInt(prev?.premiumsPaidUnits ?? 0n) + premiumsPaidUnits).toString(),
    redemptionsReceivedUnits: (
      BigInt(prev?.redemptionsReceivedUnits ?? 0n) + redemptionsReceivedUnits
    ).toString(),
    purchasedUnitsBySeries: purchased,
    lastScannedBlock: Number(scannedThrough),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * State-derived P&L legs from OUR series rows. Beyond the raw sums this
 * DECOMPOSES the opaque residualsWithdrawn (on-chain: escrow + premiumsAccrued
 * − paidOut, one-shot) into capital return vs income, and surfaces the sell
 * book's realized loss:
 *   premiumsEarnedUnits    Σ premiumsAccrued            (accrued income)
 *   residualsWithdrawnUnits Σ withdrawn                 (raw, kept for audit)
 *   escrowReturnedUnits    Σ max(0, withdrawn − premiumsAccrued)  (capital back)
 *   premiumIncomeUnits     Σ min(withdrawn, premiumsAccrued)      (income realized
 *                          at withdrawal — never double-count vs premiumsEarned)
 *   claimsPaidUnits        Σ paidOut                    (realized loss: claims
 *                          paid out of our escrow to holders)
 */
export function computeStatePnl(seriesRows, wallet) {
  let premiumsEarnedUnits = 0n;
  let residualsWithdrawnUnits = 0n;
  let escrowReturnedUnits = 0n;
  let premiumIncomeUnits = 0n;
  let claimsPaidUnits = 0n;
  if (isAddr(wallet)) {
    for (const s of seriesRows ?? []) {
      if (typeof s?.creator !== "string" || s.creator.toLowerCase() !== wallet.toLowerCase()) continue;
      const premiums = BigInt(s.premiumsAccruedUnits ?? 0n);
      const withdrawn = BigInt(s.withdrawnUnits ?? 0n);
      premiumsEarnedUnits += premiums;
      residualsWithdrawnUnits += withdrawn;
      claimsPaidUnits += BigInt(s.paidOutUnits ?? 0n);
      if (withdrawn > 0n) {
        const income = withdrawn < premiums ? withdrawn : premiums;
        premiumIncomeUnits += income;
        escrowReturnedUnits += withdrawn - income;
      }
    }
  }
  return { premiumsEarnedUnits, residualsWithdrawnUnits, escrowReturnedUnits, premiumIncomeUnits, claimsPaidUnits };
}

/**
 * Realized-loss leg of the BUY book: settled cover the agent held but never
 * redeemed before redeemEnd is worth 0 forever — the forgone payout
 * (units × settled ratio) is surfaced as its own P&L line instead of silently
 * riding in "holdings".
 */
export function computeForgoneRedemptions(seriesRows, holdings, nowSec) {
  const WAD = 10n ** 18n;
  const byId = new Map((seriesRows ?? []).map((s) => [Number(s.id), s]));
  let forgoneUnits = 0n;
  for (const h of holdings ?? []) {
    const s = byId.get(Number(h.seriesId));
    const units = BigInt(h.units ?? 0);
    if (!s || units <= 0n) continue;
    if (!s.settled || s.cancelled) continue;
    if (Number(nowSec) <= Number(s.redeemEnd)) continue; // still collectable
    forgoneUnits += (units * BigInt(s.payoutRatioWad ?? 0)) / WAD;
  }
  return forgoneUnits;
}

// ---------------------------------------------------------------------------
// 1. signals (collectors/ — lazy, tolerant, gathered ONCE for all targets)
// ---------------------------------------------------------------------------

/**
 * Adapt collector output into the policy signal interface:
 *   { prints: [{t, cents, source}], kalshi: {probVacancyBelow}|null, raw, notes }
 * Collectors are REAL (they hit credaily.com and api.elections.kalshi.com);
 * absence or failure of any collector is tolerated and recorded in notes. The
 * settlement metric is chain-agnostic, so signals are gathered exactly once.
 */
export async function gatherSignals({ skip = false } = {}) {
  const signals = { prints: [], kalshi: null, raw: {}, notes: [] };
  if (skip) {
    signals.notes.push("collectors skipped (--skip-collectors)");
    return signals;
  }

  // CRE Daily web archive — the settlement metric itself.
  try {
    const { collectCredaily } = await import("./collectors/credaily.mjs");
    const res = await collectCredaily();
    signals.raw.credaily = res;
    if (res.ok) {
      for (const s of res.signals) {
        if (!(Number.isFinite(s.value) && s.value > 0)) continue;
        const t = s.asOf ? Math.floor(Date.parse(s.asOf) / 1000) : NaN;
        if (Number.isFinite(t) && t > 0) {
          signals.prints.push({ t, cents: s.value, source: "credaily-web" });
        } else {
          // unknown publish time — pass through with t:null; decide.mjs treats
          // unknown-age prints as stale (corroboration only, never anchoring)
          signals.prints.push({ t: null, cents: s.value, source: "credaily-web" });
          signals.notes.push(`credaily: print ${s.value}c has no publish timestamp — passed as unknown-age`);
        }
      }
      signals.notes.push(`credaily: ${res.signals.length} print(s) collected`);
    } else {
      signals.notes.push(`credaily collector failed: ${res.error}`);
    }
  } catch (err) {
    signals.notes.push(`credaily collector unavailable: ${err?.code ?? err?.message ?? err}`);
  }

  // Kalshi public market data — vacancy-stress modifier only.
  try {
    const { collectKalshi, pickVacancyMarket } = await import("./collectors/kalshi.mjs");
    const res = await collectKalshi();
    signals.raw.kalshi = res;
    if (res.ok) {
      const vac = pickVacancyMarket(res.signals);
      if (vac) {
        signals.kalshi = { probVacancyBelow: vac.value, detail: vac.detail, asOf: vac.asOf, market: vac.market };
        signals.notes.push(
          `kalshi: P(vacancy below strike) = ${vac.value} (${vac.market.ticker}, active, oi=${vac.market.openInterest}, expires ${vac.market.expirationTime})`,
        );
      } else {
        signals.notes.push("kalshi: no active KXMANOFFVAC market with open interest — vacancy signal absent");
      }
    } else {
      signals.notes.push(`kalshi collector failed: ${res.error}`);
    }
  } catch (err) {
    signals.notes.push(`kalshi collector unavailable: ${err?.code ?? err?.message ?? err}`);
  }

  return signals;
}

// ---------------------------------------------------------------------------
// 2. chain state (viem; read-only, no key)
// ---------------------------------------------------------------------------

/**
 * FULL market scan: every series struct + creator + seriesPaused + (when the
 * wallet is known) the agent's CoverToken balance per series. ROBUSTNESS LAW:
 * one undecodable series skips THAT series (recorded in scanSkipped), never
 * the run — a single hostile/corrupt row must not blind the whole book.
 */
export async function scanSeries(publicClient, target, seriesCount, wallet) {
  const read = (address, abi, functionName, args = []) =>
    publicClient.readContract({ address, abi, functionName, args });
  const series = [];
  const holdings = [];
  const scanSkipped = [];
  const results = await Promise.allSettled(
    Array.from({ length: seriesCount }, (_, i) =>
      Promise.all([
        read(target.pool, POOL_ABI, "series", [BigInt(i)]),
        read(target.pool, POOL_ABI, "seriesPaused", [BigInt(i)]),
        isAddr(wallet) ? read(target.token, COVER_TOKEN_ABI, "balanceOf", [wallet, BigInt(i)]) : 0n,
      ]),
    ),
  );
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      scanSkipped.push({ id: i, error: r.reason?.shortMessage ?? String(r.reason) });
      return;
    }
    const [s, paused, ownCover] = r.value;
    series.push({
      id: i,
      creator: s.creator,
      strikeLowCents: Number(s.strikeLowCents),
      strikeHighCents: Number(s.strikeHighCents),
      premiumRateBps: Number(s.premiumRateBps),
      saleEnd: Number(s.saleEnd),
      obsStart: Number(s.obsStart),
      obsEnd: Number(s.obsEnd),
      redeemEnd: Number(s.redeemEnd),
      escrowUnits: s.escrow,
      soldUnits: s.sold,
      premiumsAccruedUnits: s.premiumsAccrued,
      paidOutUnits: s.paidOut,
      withdrawnUnits: s.withdrawn,
      settled: s.settled,
      cancelled: s.cancelled,
      paused,
      residualWithdrawn: s.residualWithdrawn,
      payoutRatioWad: s.payoutRatioWad,
      observationT: Number(s.observationT),
      ownCoverUnits: BigInt(ownCover),
    });
    if (BigInt(ownCover) > 0n) holdings.push({ seriesId: i, units: BigInt(ownCover) });
  });
  return { series, holdings, scanSkipped };
}

/** Read one target's full chain state. Any top-level failure => { ok:false }. */
export async function readChainState(publicClient, target, wallet) {
  try {
    const read = (address, abi, functionName, args = []) =>
      publicClient.readContract({ address, abi, functionName, args });

    const [block, seriesCountBig, obsCountBig] = await Promise.all([
      publicClient.getBlock(),
      read(target.pool, POOL_ABI, "seriesCount"),
      read(target.oracle, ORACLE_ABI, "observationCount"),
    ]);

    const seriesCount = Number(seriesCountBig);
    const { series, holdings, scanSkipped } = await scanSeries(publicClient, target, seriesCount, wallet);

    const obsCount = Number(obsCountBig);
    const observations = [];
    for (let i = 0; i < obsCount; i++) {
      const [t, cents, emailId] = await read(target.oracle, ORACLE_ABI, "observations", [BigInt(i)]);
      observations.push({ t: Number(t), cents: Number(cents), emailId });
    }

    let agent = null;
    if (isAddr(wallet)) {
      const [currencyUnits, allowanceUnits, nativeWei] = await Promise.all([
        read(target.currency.address, ERC20_ABI, "balanceOf", [wallet]),
        read(target.currency.address, ERC20_ABI, "allowance", [wallet, target.pool]),
        publicClient.getBalance({ address: wallet }),
      ]);
      agent = { address: wallet, currencyUnits, allowanceUnits, nativeWei };
    }

    return {
      ok: true,
      nowSec: Number(block.timestamp),
      blockNumber: block.number,
      chainId: target.chainId,
      pool: target.pool, // stamped into the plan (cross-target refusal)
      currency: target.currency,
      agent,
      seriesCount,
      series,
      holdings,
      scanSkipped,
      oracle: { count: obsCount, observations, address: target.oracle },
    };
  } catch (err) {
    return { ok: false, error: err?.shortMessage ?? err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// 3. P&L — chain-state legs + cumulative event legs (runs/state-<chainId>.json)
// ---------------------------------------------------------------------------

const eventAbi = (name) => POOL_ABI.find((e) => e.type === "event" && e.name === name);

/**
 * Scan ProtectionBought(buyer=us) and Redeemed(holder=us) in bounded chunks.
 * Both event args are indexed, so the RPC does the filtering. On a chunk
 * failure the scan stops at the last good block (the cursor never skips).
 */
export async function scanPnlEvents(publicClient, target, wallet, fromBlock, toBlock, opts = {}) {
  const chunk = BigInt(opts.chunkBlocks ?? Number(process.env.AGENT_PNL_CHUNK_BLOCKS ?? 20_000));
  const maxChunks = opts.maxChunks ?? 50;
  let premiumsPaidUnits = 0n;
  let redemptionsReceivedUnits = 0n;
  const purchasedUnitsBySeries = {};
  let cursor = BigInt(fromBlock);
  const end = BigInt(toBlock);
  const notes = [];
  let chunks = 0;
  while (cursor <= end && chunks < maxChunks) {
    const upper = cursor + chunk - 1n > end ? end : cursor + chunk - 1n;
    try {
      const [bought, redeemed] = await Promise.all([
        publicClient.getLogs({
          address: target.pool,
          event: eventAbi("ProtectionBought"),
          args: { buyer: wallet },
          fromBlock: cursor,
          toBlock: upper,
        }),
        publicClient.getLogs({
          address: target.pool,
          event: eventAbi("Redeemed"),
          args: { holder: wallet },
          fromBlock: cursor,
          toBlock: upper,
        }),
      ]);
      for (const l of bought) {
        premiumsPaidUnits += BigInt(l.args.premium);
        // Purchased-cover ledger: maxClaim units the agent actually BOUGHT on
        // this series (gifts arrive via someone else's buyProtectionFor and
        // never appear under buyer=agent).
        const id = String(l.args.seriesId);
        purchasedUnitsBySeries[id] = (BigInt(purchasedUnitsBySeries[id] ?? 0n) + BigInt(l.args.maxClaim)).toString();
      }
      for (const l of redeemed) redemptionsReceivedUnits += BigInt(l.args.payout);
      cursor = upper + 1n;
      chunks++;
    } catch (err) {
      notes.push(
        `event scan stopped at block ${cursor} (${err?.shortMessage ?? err?.message ?? err}) — cursor holds, next run retries`,
      );
      break;
    }
  }
  if (cursor <= end && chunks >= maxChunks) {
    notes.push(`event scan budget reached (${maxChunks} chunks) — resuming from block ${cursor} next run`);
  }
  return { premiumsPaidUnits, redemptionsReceivedUnits, purchasedUnitsBySeries, scannedThrough: cursor - 1n, notes };
}

export function pnlStatePath(chainId) {
  return path.join(RUNS_DIR, `state-${chainId}.json`);
}

export function loadPnlState(chainId, wallet) {
  const p = pnlStatePath(chainId);
  try {
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (isAddr(wallet) && isAddr(s?.wallet) && s.wallet.toLowerCase() !== wallet.toLowerCase()) {
      return { ...s, _walletChanged: true };
    }
    return s;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3b. run lock — one --execute run at a time (cron overlap / operator retry
// while a slow run waits on receipts must never double-create/double-buy)
// ---------------------------------------------------------------------------

export const RUN_LOCK_STALE_MS = 30 * 60 * 1000; // a lock older than 30 min is stale

export function runLockPath(dir = RUNS_DIR) {
  return path.join(dir, ".lock");
}

/**
 * Take the exclusive execute-lock (O_EXCL create of runs/.lock with
 * { pid, timestamp }). A live lock refuses ({ ok:false, holder }); a stale one
 * (> staleMs old) is broken with a note. Returns { ok:true, path } on success.
 */
export function acquireRunLock({ dir = RUNS_DIR, staleMs = RUN_LOCK_STALE_MS, nowMs = Date.now(), pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true });
  const p = runLockPath(dir);
  const payload = JSON.stringify({ pid, timestamp: nowMs, startedAt: new Date(nowMs).toISOString() }) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(p, payload, { flag: "wx" }); // O_EXCL — fails if the lock exists
      return { ok: true, path: p };
    } catch (err) {
      if (err?.code !== "EEXIST") return { ok: false, error: String(err?.message ?? err) };
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        holder = null; // unreadable lock: treat as stale garbage
      }
      const age = holder && Number.isFinite(Number(holder.timestamp)) ? nowMs - Number(holder.timestamp) : Infinity;
      if (age > staleMs) {
        try {
          rmSync(p, { force: true }); // break the stale lock, then retry the O_EXCL create once
        } catch {
          /* raced — the retry's wx will decide */
        }
        continue;
      }
      return {
        ok: false,
        holder,
        error: `another --execute run holds ${p} (pid ${holder?.pid ?? "?"}, started ${holder?.startedAt ?? "?"}, age ${Math.round(age / 1000)}s < stale ${Math.round(staleMs / 1000)}s) — refusing concurrent execution`,
      };
    }
  }
  return { ok: false, error: `could not acquire ${p} after breaking a stale lock (raced by another run)` };
}

/** Release the execute-lock (idempotent). */
export function releaseRunLock({ dir = RUNS_DIR } = {}) {
  try {
    rmSync(runLockPath(dir), { force: true });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// 4. one target, end to end (isolated: any throw is THIS target's failure)
// ---------------------------------------------------------------------------

async function connect(target) {
  const errors = [];
  for (const rpcUrl of rpcUrlsFor(target)) {
    const client = createPublicClient({ chain: target.chain, transport: http(rpcUrl) });
    try {
      await client.getChainId();
      return { client, rpcUrl };
    } catch (err) {
      errors.push(`${redactRpcUrl(rpcUrl)}: ${err?.shortMessage ?? err?.message ?? err}`);
    }
  }
  throw new Error(`no reachable RPC for ${target.name} — ${errors.join("; ")}`);
}

async function bankrWalletMeCheck(target, wallet) {
  if (target.executor !== "bankr" || !process.env.BANKR_API_KEY) return null;
  try {
    const { buildWalletMeRequest } = await import("./executors/bankr.mjs");
    const { url, init } = buildWalletMeRequest({ apiKey: process.env.BANKR_API_KEY });
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { ok: false, error: `GET /wallet/me -> HTTP ${res.status}` };
    const body = await res.json();
    const evm = (body.wallets ?? []).find((w) => w.chain === "evm");
    if (!body.success || !evm?.address) return { ok: false, error: "no EVM wallet in /wallet/me response" };
    return {
      ok: true,
      evmAddress: evm.address,
      matchesResolvedWallet: isAddr(wallet) ? evm.address.toLowerCase() === wallet.toLowerCase() : null,
    };
  } catch (err) {
    return { ok: false, error: `walletMe: ${err?.message ?? err}` };
  }
}

export function planHasActions(plan) {
  return (
    !plan.refused &&
    (plan.newSeries !== null ||
      (plan.buys?.length ?? 0) > 0 ||
      (plan.redeems?.length ?? 0) > 0 ||
      (plan.pauses?.length ?? 0) > 0 ||
      (plan.cancels?.length ?? 0) > 0 ||
      (plan.withdrawResiduals?.length ?? 0) > 0)
  );
}

async function runTarget(target, signals, { execute, dryReason }) {
  const cur = target.currency;
  const fmt = (u) => fmtUnits(BigInt(u), cur);
  step(`[${target.name}] chainId ${target.chainId} — pool ${target.pool} (${cur.symbol}, ${cur.decimals} decimals, executor ${target.executor})`);

  const walletInfo = resolveWallet(target);
  const wallet = walletInfo?.address ?? null;
  info(wallet ? `agent wallet: ${wallet} (via ${walletInfo.source})` : "agent wallet: UNRESOLVED — observation-only");

  const { client, rpcUrl } = await connect(target);
  const rpcUrlRedacted = redactRpcUrl(rpcUrl);
  // viem error messages embed the transport URL — scrub any accidental echo of
  // the full (possibly keyed) URL from strings that reach stdout or the report.
  const scrub = (s) => (typeof s === "string" ? s.split(rpcUrl).join(rpcUrlRedacted) : s);
  info(`rpc: ${rpcUrlRedacted}`);

  const chainState = await readChainState(client, target, wallet);
  if (!chainState.ok) {
    chainState.error = scrub(chainState.error);
    info(`CHAIN READ FAILED: ${chainState.error}`);
  } else {
    info(`block ${chainState.blockNumber} t=${chainState.nowSec}; series=${chainState.seriesCount} (skipped ${chainState.scanSkipped.length}); oracle obs=${chainState.oracle.count}`);
    if (chainState.agent) {
      info(`wallet: ${fmt(chainState.agent.currencyUnits)}, allowance→pool ${fmt(chainState.agent.allowanceUnits)}, native ${formatUnits(chainState.agent.nativeWei, 18)}`);
    }
  }

  // Read-only Bankr identity check (free tier /wallet/me — never a secret echo).
  const walletMe = await bankrWalletMeCheck(target, wallet);
  if (walletMe) {
    info(
      walletMe.ok
        ? `bankr /wallet/me: ${walletMe.evmAddress}${walletMe.matchesResolvedWallet === false ? "  MISMATCH vs resolved wallet!" : " (matches)"}`
        : `bankr /wallet/me unavailable: ${walletMe.error}`,
    );
  }

  // -- P&L scan FIRST (the purchased-cover ledger feeds decide's inventory) ----
  const pnlNotes = [];
  const statePnl = computeStatePnl(chainState.ok ? chainState.series : [], wallet);
  let pnlState = loadPnlState(target.chainId, wallet) ?? {
    chainId: target.chainId,
    wallet,
    premiumsPaidUnits: "0",
    redemptionsReceivedUnits: "0",
    purchasedUnitsBySeries: {},
    lastScannedBlock: null,
  };
  if (pnlState._walletChanged) {
    pnlNotes.push(`wallet changed (${pnlState.wallet} -> ${wallet}) — cumulative event totals reset`);
    pnlState = { chainId: target.chainId, wallet, premiumsPaidUnits: "0", redemptionsReceivedUnits: "0", purchasedUnitsBySeries: {}, lastScannedBlock: null };
  }
  if (chainState.ok && isAddr(wallet)) {
    const lookback = Number(process.env.AGENT_PNL_LOOKBACK_BLOCKS ?? 120_000);
    const from =
      pnlState.lastScannedBlock !== null && pnlState.lastScannedBlock !== undefined
        ? BigInt(pnlState.lastScannedBlock) + 1n
        : chainState.blockNumber > BigInt(lookback)
          ? chainState.blockNumber - BigInt(lookback)
          : 0n;
    if (from <= chainState.blockNumber) {
      const scan = await scanPnlEvents(client, target, wallet, from, chainState.blockNumber);
      pnlNotes.push(...scan.notes.map(scrub));
      if (scan.scannedThrough >= from) {
        pnlState = mergePnlState(pnlState, scan);
      }
    }
    writeFileSync(pnlStatePath(target.chainId), JSON.stringify({ ...pnlState, wallet, chainId: target.chainId }, null, 2) + "\n");
  } else {
    pnlNotes.push("event scan skipped (no verified chain read or no wallet identity)");
  }
  if (chainState.ok) {
    // Purchased-vs-gifted: only cover the agent actually BOUGHT may move the
    // inventory lean (outsider-minted soulbound gifts are reported instead).
    chainState.purchasedUnits = pnlState.purchasedUnitsBySeries ?? {};
  }

  // -- decide (pure) ----------------------------------------------------------
  const config = { ...DEFAULT_CONFIG, decimals: cur.decimals };
  const plan = decide(signals, chainState, config);
  for (const r of plan.rationale) info(scrub(String(r)));

  info("");
  info(`PLAN[${target.name}]  refused=${plan.refused}${plan.target ? `  [stamp chainId ${plan.target.chainId}, block ${plan.target.decidedAtBlock}, wallet ${plan.target.wallet}]` : ""}`);
  info(
    `  SELL:   ${plan.newSeries ? `strikes ${plan.newSeries.strikeLowCents}/${plan.newSeries.strikeHighCents}c @ ${plan.newSeries.premiumRateBps} bps, escrow ${fmt(plan.newSeries.capacityUnits)}` : "none"}`,
  );
  info(
    `  BUY:    ${plan.buys.length ? plan.buys.map((b) => `#${b.seriesId} claim ${fmt(b.maxClaimUnits)} (edge ${b.edgeBps} bps)`).join("; ") : "none"}`,
  );
  info(
    `  REDEEM: ${(plan.redeems?.length ?? 0) ? plan.redeems.map((r) => `#${r.seriesId} ${fmt(r.units)}`).join("; ") : "none"}`,
  );
  info(
    `  MANAGE: pauses=[${plan.pauses.map((p) => `${p.seriesId}:${p.paused}`).join(",")}] cancels=[${plan.cancels.join(",")}] residuals=[${plan.withdrawResiduals.join(",")}]`,
  );

  // -- P&L block ---------------------------------------------------------------
  const redemptionsForgoneUnits = chainState.ok
    ? computeForgoneRedemptions(chainState.series, chainState.holdings, chainState.nowSec)
    : 0n;
  const pnl = {
    currency: cur.symbol,
    decimals: cur.decimals,
    premiumsEarnedUnits: statePnl.premiumsEarnedUnits,
    residualsWithdrawnUnits: statePnl.residualsWithdrawnUnits,
    escrowReturnedUnits: statePnl.escrowReturnedUnits,
    premiumIncomeUnits: statePnl.premiumIncomeUnits,
    claimsPaidUnits: statePnl.claimsPaidUnits,
    premiumsPaidUnits: BigInt(pnlState.premiumsPaidUnits ?? 0),
    redemptionsReceivedUnits: BigInt(pnlState.redemptionsReceivedUnits ?? 0),
    redemptionsForgoneUnits,
    scannedThroughBlock: pnlState.lastScannedBlock,
    notes: pnlNotes,
  };
  pnl.netPremiumFlowUnits = pnl.premiumsEarnedUnits - pnl.premiumsPaidUnits;
  info("");
  info(`P&L[${target.name}] (cumulative, ${cur.symbol}):`);
  info(`  premiums earned (own series):   ${fmt(pnl.premiumsEarnedUnits)}`);
  info(`  premiums paid (buy legs):       ${fmt(pnl.premiumsPaidUnits)}`);
  info(`  redemptions received:           ${fmt(pnl.redemptionsReceivedUnits)}`);
  info(`  redemptions FORGONE (expired):  ${fmt(pnl.redemptionsForgoneUnits)}  [realized loss: settled cover unredeemed past redeemEnd]`);
  info(`  claims paid (own escrow out):   ${fmt(pnl.claimsPaidUnits)}  [realized loss of the sell book]`);
  info(`  residuals withdrawn:            ${fmt(pnl.residualsWithdrawnUnits)}  = escrow returned ${fmt(pnl.escrowReturnedUnits)} + premium income ${fmt(pnl.premiumIncomeUnits)}`);
  info(`  net premium flow:               ${fmt(pnl.netPremiumFlowUnits)}`);
  for (const n of pnlNotes) info(`  note: ${n}`);

  // -- execution (per-target opt-in) --------------------------------------------
  const hasActions = planHasActions(plan);
  const execution = { requested: execute, acted: false, partial: false, route: null, result: null, error: null };
  let exitCode = 0;
  if (plan.refused) exitCode = 3;

  if (execute && plan.refused) {
    info("\nExecute — REFUSED by policy, not touching the chain");
  } else if (execute && !hasActions) {
    info("\nExecute — plan is a no-op, nothing to do");
  } else if (execute) {
    info("\nExecute (executors/index.mjs)");
    try {
      const executors = await import("./executors/index.mjs");
      const result = await executors.execute(plan, {
        target: target.name,
        dryRun: false,
        signalsSummary: signals.notes,
        log: (msg) => info(scrub(String(msg))),
      });
      execution.result = result;
      execution.route = result.route;
      const ex = result.direct; // back-compat alias of result.execution
      const landed = ex?.executed ?? [];
      execution.acted = Boolean(ex?.ok && landed.length > 0);
      // PARTIAL: the batch aborted mid-way but earlier txs already landed —
      // chain state changed and does NOT match the plan. Exit 4.
      execution.partial = Boolean(ex && !ex.ok && landed.length > 0);
      if (ex && !ex.ok) execution.error = scrub(ex.error ?? "executor failed");
      info(
        ex
          ? scrub(`${result.route}: ok=${ex.ok} executed=[${landed.map((t) => t.name).join(", ")}]${ex.error ? ` error=${ex.error}` : ""}`)
          : "executor returned no execution result",
      );
      if (execution.partial) {
        info(`PARTIAL — ${landed.length} tx landed, batch aborted at ${ex.failed?.name ?? "unknown step"}`);
        for (const t of landed) info(`  landed: ${t.name} — ${t.hash}`);
      }
      exitCode = execution.partial ? 4 : execution.acted ? 2 : execution.error ? 3 : 0;
    } catch (err) {
      execution.error = scrub(`executors/ unavailable: ${err?.code ?? err?.message ?? err}`);
      info(execution.error);
      exitCode = 3;
    }
  } else if (hasActions) {
    info(`\nDry run: the plan above was NOT executed${dryReason ? ` (${dryReason})` : ""}. Re-run with --execute${execute ? "" : ` ${target.name}`} to act.`);
  }

  return {
    report: {
      name: target.name,
      chainId: target.chainId,
      executor: target.executor,
      deployment: { pool: target.pool, token: target.token, oracle: target.oracle, router: target.router, currency: cur },
      rpcUrl: rpcUrlRedacted, // host only — keyed RPC URLs must never reach the CI artifact
      wallet,
      walletSource: walletInfo?.source ?? null,
      bankrWalletMe: walletMe,
      chainState,
      plan,
      pnl,
      execution,
      exitCode,
    },
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();
  const knownNames = TARGETS.map((t) => t.name);
  let args;
  try {
    args = parseArgs(process.argv.slice(2), knownNames);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
  const selected = args.targets ? TARGETS.filter((t) => args.targets.includes(t.name)) : TARGETS;

  // RUN LOCK: at most one --execute run at a time (two overlapping executors
  // would each pass the one-own-live-sale and budget checks against the same
  // pre-action state and double-create/double-buy). Dry runs never lock.
  let lockHeld = false;
  if (args.execute) {
    const lock = acquireRunLock();
    if (!lock.ok) {
      console.error(`REFUSED: ${lock.error}`);
      process.exit(3);
    }
    lockHeld = true;
    process.on("exit", () => {
      if (lockHeld) releaseRunLock();
    });
  }
  const releaseLock = () => {
    if (lockHeld) {
      releaseRunLock();
      lockHeld = false;
    }
  };

  console.log(
    `nyrent-cover market-maker agent — ${args.execute ? `EXECUTE [${(args.executeTargets ?? knownNames).join(", ")}]` : "DRY RUN (default; use --execute to act)"}`,
  );
  console.log(`  targets: ${selected.map((t) => `${t.name}(${t.currency.symbol})`).join(", ")}`);

  step("Gather signals ONCE (collectors/ — real endpoints, lazily imported)");
  const signals = await gatherSignals({ skip: args.skipCollectors });
  for (const n of signals.notes) info(n);
  info(`prints: ${signals.prints.length} from web, kalshi: ${signals.kalshi ? "yes" : "absent"}`);

  const targetReports = [];
  const codes = [];
  for (const target of selected) {
    const executeThis = args.execute && (args.executeTargets === null || args.executeTargets.includes(target.name));
    try {
      const { report, exitCode } = await runTarget(target, signals, {
        execute: executeThis,
        dryReason: args.execute && !executeThis ? `--execute limited to [${args.executeTargets.join(", ")}]` : null,
      });
      targetReports.push(report);
      codes.push(exitCode);
    } catch (err) {
      // PER-TARGET ISOLATION: one target's failure never stops the others.
      const msg = `${target.name} failed: ${err?.stack ?? err}`;
      console.error(`\nERROR (isolated to ${target.name}): ${msg}`);
      targetReports.push({ name: target.name, chainId: target.chainId, error: String(err?.message ?? err), exitCode: 1 });
      codes.push(1);
    }
  }

  const exitCode = overallExitCode(codes);

  step("Write run report");
  mkdirSync(RUNS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(RUNS_DIR, `${date}.json`);
  const report = {
    date,
    generatedAt: new Date().toISOString(),
    mode: args.execute ? "execute" : "dry-run",
    executeTargets: args.execute ? (args.executeTargets ?? TARGETS.map((t) => t.name)) : [],
    signals: { prints: signals.prints, kalshi: signals.kalshi, notes: signals.notes, raw: signals.raw },
    targets: targetReports,
    exitCodes: codes,
    exitCode,
  };
  writeFileSync(reportPath, JSON.stringify(report, jsonBigint, 2) + "\n");
  info(`wrote ${reportPath}`);

  console.log(
    `\nexit ${exitCode} (worst-of [${codes.join(", ")}]: ${exitCode === 0 ? "ok" : exitCode === 2 ? "acted" : exitCode === 3 ? "refused" : exitCode === 4 ? "PARTIAL — txs landed, batch aborted" : "error"})`,
  );
  releaseLock();
  process.exit(exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nERROR: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
