/**
 * run.test.mjs — unit tests for the runner's pure/injectable pieces: CLI
 * parsing, worst-of exit codes, wallet resolution, market-scan robustness
 * (one undecodable series skips THAT series, never the run), P&L accounting
 * (state legs + cumulative event legs), and RPC redaction. Fake viem clients
 * only — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "viem";

import path from "node:path";

import {
  redactRpcUrl,
  overallExitCode,
  parseArgs,
  resolveWallet,
  mergePnlState,
  computeStatePnl,
  computeForgoneRedemptions,
  scanSeries,
  readChainState,
  scanPnlEvents,
  planHasActions,
  acquireRunLock,
  releaseRunLock,
  RUN_LOCK_STALE_MS,
} from "./run.mjs";
import { getTarget } from "./targets.mjs";

const GNOSIS = getTarget("gnosis");
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const KNOWN = ["gnosis", "arbitrum"];

// ---------------------------------------------------------------------------
// CLI + exit codes
// ---------------------------------------------------------------------------

test("parseArgs: dry-run default; --execute alone acts on all; --execute <name> only on that target", () => {
  assert.deepEqual(parseArgs([], KNOWN), { execute: false, executeTargets: null, skipCollectors: false, targets: null });
  assert.deepEqual(parseArgs(["--execute"], KNOWN).executeTargets, null);
  assert.equal(parseArgs(["--execute"], KNOWN).execute, true);
  assert.deepEqual(parseArgs(["--execute", "gnosis"], KNOWN).executeTargets, ["gnosis"]);
  assert.deepEqual(parseArgs(["--execute=arbitrum"], KNOWN).executeTargets, ["arbitrum"]);
  assert.deepEqual(parseArgs(["--target", "gnosis", "--skip-collectors"], KNOWN), {
    execute: false,
    executeTargets: null,
    skipCollectors: true,
    targets: ["gnosis"],
  });
  assert.deepEqual(parseArgs(["--target=gnosis,arbitrum"], KNOWN).targets, ["gnosis", "arbitrum"]);
  assert.throws(() => parseArgs(["--target", "base"], KNOWN), /unknown target/);
  assert.throws(() => parseArgs(["--execute=base"], KNOWN), /unknown target/);
  assert.throws(() => parseArgs(["--frobnicate"], KNOWN), /unknown flag/);
});

test("overallExitCode: worst-of severity 1 > 4 > 3 > 2 > 0 (exit codes unchanged)", () => {
  assert.equal(overallExitCode([]), 0);
  assert.equal(overallExitCode([0, 0]), 0);
  assert.equal(overallExitCode([0, 2]), 2);
  assert.equal(overallExitCode([2, 3]), 3);
  assert.equal(overallExitCode([3, 4]), 4);
  assert.equal(overallExitCode([4, 1]), 1);
  assert.equal(overallExitCode([2, 0, 4]), 4);
});

test("redactRpcUrl: keyed paths/queries never survive", () => {
  assert.equal(redactRpcUrl("https://rpc.gnosischain.com"), "https://rpc.gnosischain.com");
  assert.equal(redactRpcUrl("https://rpc.example.com/v2/SECRETKEY"), "https://rpc.example.com (path/query redacted)");
  assert.equal(redactRpcUrl("https://a.b/?key=SECRET"), "https://a.b (path/query redacted)");
  assert.equal(redactRpcUrl("not a url"), "<unparseable rpc url — redacted>");
});

// ---------------------------------------------------------------------------
// wallet resolution (identity only — never key material)
// ---------------------------------------------------------------------------

// anvil dev key #0 — publicly known, used ONLY to test address derivation
const DEV_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEV_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

test("resolveWallet: direct targets prefer AGENT_ADDRESS_<NAME>, then the key-derived address", () => {
  const t = getTarget("gnosis");
  assert.deepEqual(resolveWallet(t, { AGENT_ADDRESS_GNOSIS: ME, DEPLOYER_PRIVATE_KEY: DEV_PK }), {
    address: ME,
    source: "AGENT_ADDRESS_GNOSIS",
  });
  assert.equal(resolveWallet(t, { DEPLOYER_PRIVATE_KEY: DEV_PK }).address, DEV_ADDR);
  assert.equal(resolveWallet(t, { AGENT_ADDRESS: OTHER }).address, OTHER);
  assert.equal(resolveWallet(t, {}), null);
  assert.equal(resolveWallet(t, { AGENT_ADDRESS: "0xnope" }), null);
});

test("resolveWallet: bankr-capable targets use the DIRECT identity while custody is dormant (no BANKR_EXECUTE)", () => {
  const t = getTarget("arbitrum");
  // Bankr rail on hold: without the explicit opt-in the deployer key IS the identity
  assert.deepEqual(resolveWallet(t, { BANKR_WALLET: OTHER, DEPLOYER_PRIVATE_KEY: DEV_PK }), {
    address: DEV_ADDR,
    source: "DEPLOYER_PRIVATE_KEY (derived address)",
  });
  assert.equal(resolveWallet(t, { BANKR_WALLET: OTHER, AGENT_ADDRESS_ARBITRUM: ME }).address, ME);
});

test("resolveWallet: BANKR_EXECUTE=1 flips the identity to BANKR_WALLET (plan follows the active rail)", () => {
  const t = getTarget("arbitrum");
  assert.deepEqual(
    resolveWallet(t, { BANKR_EXECUTE: "1", BANKR_WALLET: OTHER, DEPLOYER_PRIVATE_KEY: DEV_PK, AGENT_ADDRESS: ME }),
    { address: OTHER, source: "BANKR_WALLET" },
  );
  // opted in but no BANKR_WALLET: falls down the chain, never silently invents one
  assert.equal(resolveWallet(t, { BANKR_EXECUTE: "1", DEPLOYER_PRIVATE_KEY: DEV_PK }).address, DEV_ADDR);
  // gnosis is never custody
  assert.equal(
    resolveWallet(getTarget("gnosis"), { BANKR_EXECUTE: "1", BANKR_WALLET: OTHER, DEPLOYER_PRIVATE_KEY: DEV_PK }).address,
    DEV_ADDR,
  );
});

// ---------------------------------------------------------------------------
// fake viem client
// ---------------------------------------------------------------------------

function seriesStruct(over = {}) {
  return {
    creator: OTHER,
    strikeLowCents: 9288,
    strikeHighCents: 10088,
    premiumRateBps: 1000,
    settled: false,
    cancelled: false,
    saleEnd: 1_790_000_000n,
    obsStart: 1_790_000_000n,
    obsEnd: 1_791_000_000n,
    redeemEnd: 1_792_000_000n,
    escrow: parseUnits("1", 18),
    sold: 0n,
    premiumsAccrued: 0n,
    paidOut: 0n,
    withdrawn: 0n,
    residualWithdrawn: false,
    payoutRatioWad: 0n,
    observationT: 0n,
    emailId: "0x" + "00".repeat(32),
    ...over,
  };
}

function fakeClient({
  seriesCount = 0,
  rows = {},
  failIds = [],
  failSeriesCount = false,
  covers = {},
  observations = [],
  logs = { ProtectionBought: [], Redeemed: [] },
  failLogsFrom = null,
  balances = { currency: 0n, allowance: 0n, native: 0n },
  block = { timestamp: 1_790_000_000n, number: 1_000_000n },
} = {}) {
  const calls = { getLogs: [] };
  return {
    calls,
    async getChainId() {
      return GNOSIS.chainId;
    },
    async getBlock() {
      return block;
    },
    async getBalance() {
      return balances.native;
    },
    async readContract({ address, functionName, args }) {
      if (functionName === "seriesCount") {
        if (failSeriesCount) throw new Error("seriesCount read failed");
        return BigInt(seriesCount);
      }
      if (functionName === "series") {
        const id = Number(args[0]);
        if (failIds.includes(id)) throw new Error(`undecodable series ${id}`);
        return rows[id] ?? seriesStruct();
      }
      if (functionName === "seriesPaused") return false;
      if (functionName === "observationCount") return BigInt(observations.length);
      if (functionName === "observations") {
        const o = observations[Number(args[0])];
        return [BigInt(o.t), o.cents, o.emailId ?? "0x" + "00".repeat(32)];
      }
      if (functionName === "balanceOf" && address === GNOSIS.token) return covers[Number(args[1])] ?? 0n;
      if (functionName === "balanceOf") return balances.currency;
      if (functionName === "allowance") return balances.allowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    async getLogs({ event, fromBlock, toBlock }) {
      calls.getLogs.push({ event: event.name, fromBlock, toBlock });
      if (failLogsFrom !== null && fromBlock >= failLogsFrom) throw new Error("getLogs range too large");
      return (logs[event.name] ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
}

// ---------------------------------------------------------------------------
// market-scan robustness — the law: one bad series skips that series, not the run
// ---------------------------------------------------------------------------

test("scanSeries: an undecodable series is SKIPPED (recorded), the rest of the book survives", async () => {
  const client = fakeClient({
    seriesCount: 3,
    rows: { 0: seriesStruct(), 2: seriesStruct({ creator: ME, premiumsAccrued: 77n }) },
    failIds: [1],
    covers: { 0: 5n },
  });
  const { series, holdings, scanSkipped } = await scanSeries(client, GNOSIS, 3, ME);
  assert.deepEqual(series.map((s) => s.id), [0, 2]);
  assert.equal(scanSkipped.length, 1);
  assert.equal(scanSkipped[0].id, 1);
  assert.match(scanSkipped[0].error, /undecodable series 1/);
  assert.deepEqual(holdings, [{ seriesId: 0, units: 5n }]);
  assert.equal(series[1].premiumsAccruedUnits, 77n);
});

test("readChainState: a top-level failure (seriesCount) fails the TARGET, ok:false", async () => {
  const state = await readChainState(fakeClient({ failSeriesCount: true }), GNOSIS, ME);
  assert.equal(state.ok, false);
  assert.match(state.error, /seriesCount read failed/);
});

test("readChainState: full shape for the policy (agent, marketScan rows, holdings, oracle)", async () => {
  const client = fakeClient({
    seriesCount: 1,
    rows: { 0: seriesStruct({ creator: ME, withdrawn: 3n }) },
    covers: {},
    observations: [{ t: 1_789_000_000, cents: 9288 }],
    balances: { currency: parseUnits("2", 18), allowance: 1n, native: 5n },
  });
  const state = await readChainState(client, GNOSIS, ME);
  assert.equal(state.ok, true);
  assert.equal(state.chainId, 100);
  assert.deepEqual(state.agent, {
    address: ME,
    currencyUnits: parseUnits("2", 18),
    allowanceUnits: 1n,
    nativeWei: 5n,
  });
  assert.equal(state.series[0].escrowUnits, parseUnits("1", 18));
  assert.equal(state.series[0].withdrawnUnits, 3n);
  assert.equal(state.oracle.observations[0].cents, 9288);
  // no wallet -> agent null (observation-only; decide() refuses honestly)
  const anon = await readChainState(client, GNOSIS, null);
  assert.equal(anon.agent, null);
});

// ---------------------------------------------------------------------------
// P&L — state legs + cumulative event legs
// ---------------------------------------------------------------------------

test("computeStatePnl: premiums earned + residuals withdrawn come from OUR series only", () => {
  const rows = [
    { creator: ME, premiumsAccruedUnits: 100n, withdrawnUnits: 40n },
    { creator: OTHER, premiumsAccruedUnits: 999n, withdrawnUnits: 999n },
    { creator: ME.toUpperCase().replace("0X", "0x"), premiumsAccruedUnits: 1n, withdrawnUnits: 0n }, // case-insensitive
  ];
  const pnl = computeStatePnl(rows, ME);
  assert.equal(pnl.premiumsEarnedUnits, 101n);
  assert.equal(pnl.residualsWithdrawnUnits, 40n);
  const empty = computeStatePnl(rows, null);
  assert.equal(empty.premiumsEarnedUnits, 0n);
  assert.equal(empty.residualsWithdrawnUnits, 0n);
  assert.equal(empty.claimsPaidUnits, 0n);
});

test("computeStatePnl: residualsWithdrawn decomposes into escrowReturned + premiumIncome; claimsPaid is its own loss line", () => {
  // one matured series: escrow 100, premiums 10, paidOut 30 => withdrawn = 80
  const rows = [
    { creator: ME, premiumsAccruedUnits: 10n, paidOutUnits: 30n, withdrawnUnits: 80n },
    // still-open series: premiums accrue but nothing withdrawn yet
    { creator: ME, premiumsAccruedUnits: 5n, paidOutUnits: 0n, withdrawnUnits: 0n },
  ];
  const pnl = computeStatePnl(rows, ME);
  assert.equal(pnl.premiumsEarnedUnits, 15n);
  assert.equal(pnl.residualsWithdrawnUnits, 80n);
  assert.equal(pnl.premiumIncomeUnits, 10n, "income realized only at withdrawal");
  assert.equal(pnl.escrowReturnedUnits, 70n, "capital return = withdrawn − premiums (= escrow − paidOut)");
  assert.equal(pnl.escrowReturnedUnits + pnl.premiumIncomeUnits, pnl.residualsWithdrawnUnits, "decomposition is exact");
  assert.equal(pnl.claimsPaidUnits, 30n, "sell-book realized loss");
});

test("computeForgoneRedemptions: settled holdings past redeemEnd are a realized loss at units × ratio", () => {
  const WAD = 10n ** 18n;
  const rows = [
    { id: 0, settled: true, cancelled: false, redeemEnd: 999, payoutRatioWad: WAD / 2n }, // expired
    { id: 1, settled: true, cancelled: false, redeemEnd: 2_000, payoutRatioWad: WAD }, // still open
    { id: 2, settled: false, cancelled: false, redeemEnd: 999, payoutRatioWad: 0n }, // never settled
  ];
  const holdings = [
    { seriesId: 0, units: 100n },
    { seriesId: 1, units: 100n },
    { seriesId: 2, units: 100n },
  ];
  assert.equal(computeForgoneRedemptions(rows, holdings, 1_000), 50n, "only the expired settled holding, at ratio");
  assert.equal(computeForgoneRedemptions(rows, [], 1_000), 0n);
});

test("scanPnlEvents: sums buyer/holder-filtered logs, builds the purchased ledger, chunks the range, cursor advances", async () => {
  const client = fakeClient({
    logs: {
      ProtectionBought: [
        { blockNumber: 100n, args: { seriesId: 0n, maxClaim: 500n, premium: 7n } },
        { blockNumber: 25_000n, args: { seriesId: 3n, maxClaim: 200n, premium: 5n } },
        { blockNumber: 25_500n, args: { seriesId: 3n, maxClaim: 100n, premium: 1n } },
      ],
      Redeemed: [{ blockNumber: 30_000n, args: { payout: 11n } }],
    },
  });
  const res = await scanPnlEvents(client, GNOSIS, ME, 0n, 44_999n, { chunkBlocks: 20_000 });
  assert.equal(res.premiumsPaidUnits, 13n);
  assert.equal(res.redemptionsReceivedUnits, 11n);
  assert.deepEqual(res.purchasedUnitsBySeries, { 0: "500", 3: "300" }, "per-series PURCHASED units (gift separation)");
  assert.equal(res.scannedThrough, 44_999n);
  // 3 chunks × 2 event types
  assert.equal(client.calls.getLogs.length, 6);
});

test("scanPnlEvents: a failing chunk STOPS the cursor at the last good block (retry next run)", async () => {
  const client = fakeClient({
    logs: { ProtectionBought: [{ blockNumber: 10n, args: { seriesId: 1n, maxClaim: 9n, premium: 3n } }], Redeemed: [] },
    failLogsFrom: 20_000n,
  });
  const res = await scanPnlEvents(client, GNOSIS, ME, 0n, 59_999n, { chunkBlocks: 20_000 });
  assert.equal(res.premiumsPaidUnits, 3n);
  assert.equal(res.scannedThrough, 19_999n); // first chunk landed, second failed
  assert.ok(res.notes.some((n) => n.includes("cursor holds")));
});

test("scanPnlEvents: bounded chunk budget resumes next run instead of hammering the RPC", async () => {
  const client = fakeClient({ logs: { ProtectionBought: [], Redeemed: [] } });
  const res = await scanPnlEvents(client, GNOSIS, ME, 0n, 99_999n, { chunkBlocks: 10_000, maxChunks: 3 });
  assert.equal(res.scannedThrough, 29_999n);
  assert.ok(res.notes.some((n) => n.includes("budget")));
});

test("mergePnlState accumulates cumulatively (incl. the purchased ledger) and stores JSON-safe strings", () => {
  const s0 = { premiumsPaidUnits: "10", redemptionsReceivedUnits: "0", purchasedUnitsBySeries: { 2: "100" }, lastScannedBlock: 99 };
  const s1 = mergePnlState(s0, {
    premiumsPaidUnits: 5n,
    redemptionsReceivedUnits: 7n,
    purchasedUnitsBySeries: { 2: "50", 7: "9" },
    scannedThrough: 200n,
  });
  assert.equal(s1.premiumsPaidUnits, "15");
  assert.equal(s1.redemptionsReceivedUnits, "7");
  assert.deepEqual(s1.purchasedUnitsBySeries, { 2: "150", 7: "9" });
  assert.equal(s1.lastScannedBlock, 200);
  const s2 = mergePnlState(null, { premiumsPaidUnits: 1n, redemptionsReceivedUnits: 2n, scannedThrough: 5n });
  assert.equal(s2.premiumsPaidUnits, "1");
  assert.deepEqual(s2.purchasedUnitsBySeries, {});
});

// ---------------------------------------------------------------------------
// run lock — one --execute at a time
// ---------------------------------------------------------------------------

test("acquireRunLock: exclusive; a live lock refuses; release frees it; stale locks are broken", async () => {
  const { mkdtempSync, rmSync: rm } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "nyrent-lock-"));
  try {
    const a = acquireRunLock({ dir, nowMs: 1_000_000, pid: 111 });
    assert.equal(a.ok, true);
    // second taker refuses while the lock is fresh
    const b = acquireRunLock({ dir, nowMs: 1_000_000 + 60_000, pid: 222 });
    assert.equal(b.ok, false);
    assert.equal(b.holder.pid, 111);
    assert.match(b.error, /refusing concurrent execution/);
    // release, then it's takeable again
    releaseRunLock({ dir });
    assert.equal(acquireRunLock({ dir, nowMs: 2_000_000, pid: 222 }).ok, true);
    // stale (> 30 min): broken and re-taken
    const stale = acquireRunLock({ dir, nowMs: 2_000_000 + RUN_LOCK_STALE_MS + 1, pid: 333 });
    assert.equal(stale.ok, true);
    releaseRunLock({ dir });
    releaseRunLock({ dir }); // idempotent
  } finally {
    rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// per-target isolation (the runner-level law; the loop lives in main(), the
// decision points are pure and tested here)
// ---------------------------------------------------------------------------

test("per-target isolation: one target's chain-read failure refuses THAT target; codes still worst-of", async () => {
  // target A fails its read -> decide() refuses -> exit 3 for A
  const bad = await readChainState(fakeClient({ failSeriesCount: true }), GNOSIS, ME);
  assert.equal(bad.ok, false);
  const { decide, DEFAULT_CONFIG } = await import("./policy/decide.mjs");
  const planA = decide({ prints: [] }, bad, { ...DEFAULT_CONFIG, decimals: 18 });
  assert.equal(planA.refused, true);
  // target B still produces a healthy (empty-book) plan from ITS own state
  const good = await readChainState(
    fakeClient({ observations: [{ t: 1_789_990_000, cents: 9288 }], balances: { currency: parseUnits("1", 18), allowance: 0n, native: 1n } }),
    GNOSIS,
    ME,
  );
  const planB = decide({ prints: [] }, good, { ...DEFAULT_CONFIG, decimals: 18 });
  assert.equal(planB.refused, false);
  // worst-of: A refused (3) + B dry-ok (0) => 3
  assert.equal(overallExitCode([3, 0]), 3);
});

test("planHasActions: any leg of the two-sided plan counts (incl. redeems)", () => {
  const empty = { refused: false, newSeries: null, buys: [], redeems: [], pauses: [], cancels: [], withdrawResiduals: [] };
  assert.equal(planHasActions(empty), false);
  assert.equal(planHasActions({ ...empty, refused: true, newSeries: {} }), false);
  assert.equal(planHasActions({ ...empty, newSeries: {} }), true);
  assert.equal(planHasActions({ ...empty, buys: [{}] }), true);
  assert.equal(planHasActions({ ...empty, redeems: [{ seriesId: 1, units: 1n }] }), true);
  assert.equal(planHasActions({ ...empty, pauses: [{}] }), true);
  assert.equal(planHasActions({ ...empty, cancels: [1] }), true);
  assert.equal(planHasActions({ ...empty, withdrawResiduals: [1] }), true);
});
