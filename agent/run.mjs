#!/usr/bin/env node
/**
 * run.mjs — daily rent-scout runner for NY Rent Cover (Gnosis, chainId 100).
 *
 *   signals (collectors/, real endpoints) ──┐
 *                                           ├─> decide() (policy/decide.mjs, pure)
 *   chain state (viem over GNOSIS_RPC_URL) ─┘        │
 *                                                    ├─> human report (stdout)
 *                                                    ├─> agent/runs/<date>.json
 *                                                    └─> --execute: executors/
 *
 * DRY-RUN BY DEFAULT: without --execute nothing is ever written on-chain and no
 * private key is needed. Network-touching modules stay lazily imported:
 * collector failure is tolerated (the policy then leans on the on-chain oracle
 * prints alone) and executors/index.mjs is only imported under --execute.
 * Shared chain constants/ABIs/env loading come from executors/chain.mjs — the
 * single source of truth for the agent package (vendored there so nothing
 * imports from web/).
 *
 * Flags:
 *   --execute           hand the Plan to executors/index.mjs (needs
 *                       DEPLOYER_PRIVATE_KEY in env / repo-root .env)
 *   --skip-collectors   do not hit collector endpoints (chain-only signals)
 *
 * Env: GNOSIS_RPC_URL (default https://rpc.gnosischain.com),
 *      DEPLOYER_PRIVATE_KEY (only for --execute; NEVER printed),
 *      BANKR_API_KEY (optional; enables the Bankr advisory executor).
 *
 * Exit codes: 0 = ok (nothing to do, or dry-run), 2 = acted (on-chain txs
 * sent), 3 = refused (chain read failed, plan refused, or executor missing),
 * 4 = PARTIAL (some txs landed, then the batch aborted — chain state changed
 * but does not match the plan; check the listed tx hashes), 1 = unexpected
 * error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, formatEther, http } from "viem";
import { gnosis } from "viem/chains";

import { decide, DEFAULT_CONFIG } from "./policy/decide.mjs";
import {
  ADDRESSES,
  CHAIN_ID,
  DEFAULT_RPC_URL,
  ORACLE_ABI,
  POOL_ABI,
  WXDAI_ABI,
  jsonBigint,
  loadEnv,
} from "./executors/chain.mjs";

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(AGENT_DIR, "runs");

// Live deployment (SPEC §8; re-verified on-chain 2026-09-18). Sourced from
// executors/chain.mjs — deliberately decoupled from web/src/deployment.json,
// because another workflow owns web/.
export const DEPLOYMENT = { chainId: CHAIN_ID, ...ADDRESSES };

let stepNo = 0;
const step = (title) => console.log(`\n[${++stepNo}] ${title}`);
const info = (msg) => console.log(`    ${msg}`);
const wx = (wei) => `${formatEther(BigInt(wei))} WXDAI`;

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

function printTable(title, rows) {
  const w = Math.max(...rows.map(([l]) => l.length));
  console.log(`\n  ${title}`);
  console.log("  " + "-".repeat(w + 44));
  for (const [l, v] of rows) console.log(`  ${l.padEnd(w)}  ${v}`);
  console.log("  " + "-".repeat(w + 44));
}

// ---------------------------------------------------------------------------
// 1. signals (collectors/ — lazy, tolerant)
// ---------------------------------------------------------------------------

/**
 * Adapt collector output into the policy signal interface:
 *   { prints: [{t, cents, source}], kalshi: {probVacancyBelow}|null, raw, notes }
 * Collectors are REAL (they hit credaily.com and api.elections.kalshi.com);
 * absence or failure of any collector is tolerated and recorded in notes.
 */
async function gatherSignals({ skip = false } = {}) {
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
      // KXMANOFFVAC = "Manhattan office vacancy below X%" — yes price ~ P(vacancy below).
      // Selection: ACTIVE + nonzero open interest, nearest expiry — never
      // first-in-API-order (a finalized or never-traded strike is meaningless).
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

async function readChainState(rpcUrl) {
  try {
    const publicClient = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });
    const dep = DEPLOYMENT;
    const read = (address, abi, functionName, args = []) =>
      publicClient.readContract({ address, abi, functionName, args });

    const block = await publicClient.getBlock();
    const [salesPaused, freeCapitalWei, totalReservedWei, seriesCountBig] = await Promise.all([
      read(dep.pool, POOL_ABI, "salesPaused"),
      read(dep.pool, POOL_ABI, "freeCapital"),
      read(dep.pool, POOL_ABI, "totalReserved"),
      read(dep.pool, POOL_ABI, "seriesCount"),
    ]);
    const [poolBalanceWei, sponsorWxdaiWei, sponsorAllowanceWei, sponsorXdaiWei, obsCountBig] =
      await Promise.all([
        read(dep.currency, WXDAI_ABI, "balanceOf", [dep.pool]),
        read(dep.currency, WXDAI_ABI, "balanceOf", [dep.sponsor]),
        read(dep.currency, WXDAI_ABI, "allowance", [dep.sponsor, dep.pool]),
        publicClient.getBalance({ address: dep.sponsor }),
        read(dep.oracle, ORACLE_ABI, "observationCount"),
      ]);

    const seriesCount = Number(seriesCountBig);
    const series = [];
    for (let i = 0; i < seriesCount; i++) {
      const s = await read(dep.pool, POOL_ABI, "series", [BigInt(i)]);
      series.push({
        id: i,
        strikeLowCents: Number(s.strikeLowCents),
        strikeHighCents: Number(s.strikeHighCents),
        premiumRateBps: Number(s.premiumRateBps),
        saleEnd: Number(s.saleEnd),
        obsStart: Number(s.obsStart),
        obsEnd: Number(s.obsEnd),
        redeemEnd: Number(s.redeemEnd),
        capacityWei: s.capacity,
        soldWei: s.sold,
        settled: s.settled,
        payoutRatioWad: s.payoutRatioWad,
      });
    }

    const obsCount = Number(obsCountBig);
    const observations = [];
    for (let i = 0; i < obsCount; i++) {
      const [t, cents, emailId] = await read(dep.oracle, ORACLE_ABI, "observations", [BigInt(i)]);
      observations.push({ t: Number(t), cents: Number(cents), emailId });
    }

    return {
      ok: true,
      nowSec: Number(block.timestamp),
      blockNumber: block.number,
      chainId: gnosis.id,
      ...dep,
      salesPaused,
      freeCapitalWei,
      totalReservedWei,
      poolBalanceWei,
      sponsorWxdaiWei,
      sponsorAllowanceWei,
      sponsorXdaiWei,
      seriesCount,
      series,
      oracle: { count: obsCount, observations, address: dep.oracle },
    };
  } catch (err) {
    return { ok: false, error: err?.shortMessage ?? err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const skipCollectors = argv.includes("--skip-collectors");
  loadEnv();
  const rpcUrl = process.env.GNOSIS_RPC_URL || DEFAULT_RPC_URL;

  const rpcUrlRedacted = redactRpcUrl(rpcUrl);
  // viem error messages embed the transport URL — scrub any accidental echo of
  // the full (possibly keyed) URL from strings that reach stdout or the report.
  const scrub = (s) => (typeof s === "string" ? s.split(rpcUrl).join(rpcUrlRedacted) : s);

  console.log(`nyrent-cover agent — ${execute ? "EXECUTE" : "DRY RUN (default; use --execute to act)"}`);
  console.log(`  pool:    ${DEPLOYMENT.pool}`);
  console.log(`  sponsor: ${DEPLOYMENT.sponsor}`);
  console.log(`  rpc:     ${rpcUrlRedacted}`);

  step("Gather signals (collectors/ — real endpoints, lazily imported)");
  const signals = await gatherSignals({ skip: skipCollectors });
  for (const n of signals.notes) info(n);
  info(`prints: ${signals.prints.length} from web, kalshi: ${signals.kalshi ? "yes" : "absent"}`);

  step("Read chain state (viem, read-only)");
  const chainState = await readChainState(rpcUrl);
  if (!chainState.ok) chainState.error = scrub(chainState.error);
  if (chainState.ok) {
    info(`block ${chainState.blockNumber} t=${chainState.nowSec}`);
    info(
      `pool: freeCapital=${wx(chainState.freeCapitalWei)}, reserved=${wx(chainState.totalReservedWei)}, salesPaused=${chainState.salesPaused}, series=${chainState.seriesCount}`,
    );
    info(
      `sponsor: ${wx(chainState.sponsorWxdaiWei)}, ${formatEther(chainState.sponsorXdaiWei)} xDAI gas, allowance->pool=${wx(chainState.sponsorAllowanceWei)}`,
    );
    info(
      `oracle: ${chainState.oracle.count} observation(s)${
        chainState.oracle.count
          ? `, latest ${chainState.oracle.observations.at(-1).cents} cents @ t=${chainState.oracle.observations.at(-1).t}`
          : ""
      }`,
    );
  } else {
    info(`CHAIN READ FAILED: ${chainState.error}`);
  }

  step("Decide (policy/decide.mjs — pure, deterministic)");
  const plan = decide(signals, chainState, DEFAULT_CONFIG);
  for (const r of plan.rationale) info(r);

  printTable("Plan", [
    ["refused", String(plan.refused)],
    ["targetFreeCapital", plan.targetFreeCapitalWei === null ? "n/a" : wx(plan.targetFreeCapitalWei)],
    [
      "capitalDelta",
      plan.capitalDeltaWei === null
        ? "n/a"
        : `${plan.capitalDeltaWei >= 0n ? "+" : ""}${formatEther(plan.capitalDeltaWei)} WXDAI (${
            plan.capitalDeltaWei > 0n ? "fund" : plan.capitalDeltaWei < 0n ? "withdraw" : "none"
          })`,
    ],
    [
      "newSeries",
      plan.newSeries
        ? `strikes ${plan.newSeries.strikeLowCents}/${plan.newSeries.strikeHighCents}c, ${plan.newSeries.premiumRateBps} bps, capacity ${wx(plan.newSeries.capacityWei)}`
        : "none",
    ],
    ["pause", plan.pause === null ? "leave as-is" : String(plan.pause)],
  ]);

  // -- execution (opt-in) ----------------------------------------------------
  const hasActions =
    !plan.refused && ((plan.capitalDeltaWei ?? 0n) !== 0n || plan.newSeries !== null || plan.pause !== null);
  let execution = { requested: execute, acted: false, partial: false, result: null, error: null };

  if (execute && plan.refused) {
    step("Execute — REFUSED by policy, not touching the chain");
  } else if (execute && !hasActions) {
    step("Execute — plan is a no-op, nothing to do");
  } else if (execute) {
    step("Execute (executors/index.mjs)");
    try {
      const executors = await import("./executors/index.mjs");
      const result = await executors.execute(plan, { dryRun: false, log: (msg) => info(scrub(String(msg))) });
      execution.result = result;
      const direct = result?.direct;
      const landed = direct?.executed ?? [];
      execution.acted = Boolean(direct?.ok && landed.length > 0);
      // PARTIAL: the batch aborted mid-way but earlier txs already landed —
      // chain state changed and does NOT match the plan. Distinct from a
      // clean refusal; reported explicitly and exits 4.
      execution.partial = Boolean(direct && !direct.ok && landed.length > 0);
      if (direct && !direct.ok) execution.error = direct.error ?? "direct executor failed";
      info(
        direct
          ? scrub(`direct: ok=${direct.ok} executed=[${landed.map((t) => t.name).join(", ")}]${direct.error ? ` error=${direct.error}` : ""}`)
          : "executor returned no direct result",
      );
      if (execution.partial) {
        info(
          `PARTIAL — ${landed.length} tx landed, batch aborted at ${direct.failed?.name ?? "unknown step"}`,
        );
        for (const t of landed) info(`  landed: ${t.name} — ${t.hash}`);
      }
    } catch (err) {
      execution.error = `executors/ unavailable: ${err?.code ?? err?.message ?? err}`;
      info(execution.error);
    }
  } else if (hasActions) {
    info("\nDry run: the plan above was NOT executed. Re-run with --execute to act.");
  }

  // -- run report ------------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  let exitCode = 0;
  if (plan.refused) exitCode = 3;
  else if (execute && execution.partial) exitCode = 4; // txs landed, then the batch aborted
  else if (execute && execution.acted) exitCode = 2;
  else if (execute && hasActions && !execution.acted) exitCode = execution.error ? 3 : 0;

  step("Write run report");
  mkdirSync(RUNS_DIR, { recursive: true });
  const reportPath = path.join(RUNS_DIR, `${date}.json`);
  const report = {
    date,
    generatedAt: new Date().toISOString(),
    mode: execute ? "execute" : "dry-run",
    deployment: DEPLOYMENT,
    rpcUrl: rpcUrlRedacted, // host only — keyed RPC URLs must never reach the CI artifact
    signals: { prints: signals.prints, kalshi: signals.kalshi, notes: signals.notes, raw: signals.raw },
    chainState,
    plan,
    execution,
    exitCode,
  };
  writeFileSync(reportPath, scrub(JSON.stringify(report, jsonBigint, 2)) + "\n");
  info(`wrote ${reportPath}`);

  console.log(
    `\nexit ${exitCode} (${exitCode === 0 ? "ok" : exitCode === 2 ? "acted" : exitCode === 3 ? "refused" : exitCode === 4 ? "PARTIAL — txs landed, batch aborted" : "error"})`,
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`\nERROR: ${err?.stack ?? err}`);
  process.exit(1);
});
