#!/usr/bin/env node
/**
 * bankr-fork-proof.mjs — REAL proof of the Bankr custody execution pipeline
 * against the live Arbitrum contracts, without spending mainnet funds and
 * WITHOUT touching Bankr's write surface:
 *
 *   1. spawns `anvil --fork-url <arbitrum>` on a free port — a real fork:
 *      contract code + storage ARE the mainnet CoverPool/USDC/oracle, and the
 *      REAL Bankr wallet's live balances (0.0005 ETH + 2.0 USDC, verified
 *      2026-09-19) are inherited by the fork;
 *   2. runs bankr.mjs's execute() end-to-end with ONE substitution: the
 *      injected fetch serves GET /wallet/me from the live-captured shape and
 *      services POST /wallet/submit by broadcasting the EXACT same
 *      {to, chainId, value, data} transaction from the impersonated Bankr
 *      wallet (anvil_impersonateAccount + eth_sendTransaction) — precisely the
 *      sign-custodially-and-broadcast semantics of the real endpoint
 *      (https://docs.bankr.bot/wallet-api/submit). Everything else — the
 *      triple gate, the currency-need check, per-tx from-override simulation,
 *      calldata encoding, receipt polling, abort-on-first-failure — is the
 *      REAL production code path;
 *   3. proves the full two-sided-underwriter tx list: approve (exact) →
 *      createSeries (escrow pulled from the Bankr wallet) → buyProtectionFor
 *      (cover minted to the Bankr wallet — the BUY leg) → setSeriesPaused,
 *      then asserts every on-chain field (creator, escrow, sold,
 *      premiumsAccrued, soulbound CoverToken balance, allowance fully
 *      consumed);
 *   4. proves PARTIAL semantics: a second batch whose second tx must revert
 *      (cancelSeries on a sold series -> AlreadySold) aborts with the landed
 *      tx listed — the exit-4 contract;
 *   5. proves the gate: with BANKR_EXECUTE off the same plan returns
 *      { gated:true } and NOTHING is submitted.
 *
 * Run: npm run test:fork:bankr   (env ARBITRUM_FORK_RPC_URL overrides upstream)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, parseEther } from "viem";
import { arbitrum } from "viem/chains";
import { createBankrExecutor } from "./bankr.mjs";
import { getTarget, targetRpcUrl, POOL_ABI, ERC20_ABI, COVER_TOKEN_ABI } from "./targets.mjs";

const T = getTarget("arbitrum");
const UPSTREAM = process.env.ARBITRUM_FORK_RPC_URL ?? targetRpcUrl(T);
const BANKR_WALLET = "0x1a7223bc942b053794e17b537e73d837cf695561"; // live-verified via GET /wallet/me
const USDC = (n) => parseUnits(n, 6);

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

async function main() {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  console.log(`bankr-fork-proof: anvil --fork-url ${UPSTREAM} --port ${port}`);
  const anvil = spawn("anvil", ["--fork-url", UPSTREAM, "--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let anvilErr = "";
  anvil.stderr.on("data", (d) => (anvilErr += d));
  const stop = () => {
    try {
      anvil.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);

  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });

  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const id = await publicClient.getChainId();
      assert.equal(id, 42161, `fork must preserve Arbitrum chainId, got ${id}`);
      break;
    } catch {
      if (anvil.exitCode !== null) throw new Error(`anvil exited early: ${anvilErr}`);
      if (Date.now() > deadline) throw new Error(`anvil not ready after 120s: ${anvilErr}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const forkBlock = await publicClient.getBlockNumber();
  console.log(`bankr-fork-proof: forked Arbitrum One at block ${forkBlock} (chainId 42161 confirmed)`);

  // The REAL Bankr wallet, impersonated. Its live USDC balance rides into the
  // fork; only gas is topped up (mainnet holds 0.0005 ETH — enough live, but
  // the proof should never fail on gas).
  await publicClient.request({ method: "anvil_impersonateAccount", params: [BANKR_WALLET] });
  await publicClient.request({ method: "anvil_setBalance", params: [BANKR_WALLET, "0x" + parseEther("1").toString(16)] });
  const custodySigner = createWalletClient({ chain: arbitrum, transport: http(rpcUrl), account: BANKR_WALLET });

  const usdcStart = await publicClient.readContract({ address: T.currency.address, abi: ERC20_ABI, functionName: "balanceOf", args: [BANKR_WALLET] });
  const seriesId = await publicClient.readContract({ address: T.pool, abi: POOL_ABI, functionName: "seriesCount" });
  console.log(`bankr-fork-proof: REAL mainnet state — Bankr wallet holds ${formatUnits(usdcStart, 6)} USDC, pool seriesCount=${seriesId}`);
  assert.ok(usdcStart >= USDC("2"), "live Bankr wallet funding (2.0 USDC) must be visible in the fork");

  // -- the mock Bankr HTTP surface (the ONE substitution) --------------------
  let submits = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/wallet/me")) {
      // live-captured shape, fixtures/bankr-wallet-me.json
      return { ok: true, status: 200, json: async () => ({ success: true, wallets: [{ chain: "evm", address: BANKR_WALLET }] }) };
    }
    if (url.endsWith("/wallet/submit")) {
      submits += 1;
      const { transaction } = JSON.parse(init.body);
      assert.equal(transaction.chainId, 42161, "/wallet/submit must target Arbitrum");
      // Bankr signs with the custodied key and broadcasts — here: the
      // impersonated wallet broadcasts the identical transaction on the fork.
      const hash = await custodySigner.sendTransaction({
        to: transaction.to,
        value: BigInt(transaction.value ?? "0"),
        data: transaction.data,
      });
      return { ok: true, status: 200, json: async () => ({ success: true, transactionHash: hash }) };
    }
    throw new Error(`unexpected fetch in fork proof: ${url}`);
  };

  const makeExecutor = ({ executeEnabled }) =>
    createBankrExecutor({
      apiKey: "bk_fork_proof", // never leaves the process; the mock fetch is the only consumer
      fetchImpl,
      target: T,
      publicClient,
      readState: async () => ({ forkProof: true }), // buildTxs below is state-free
      buildTxs: (plan) => ({ txs: plan.txs, notes: [] }), // inline descriptor lists (see below)
      executeEnabled,
      expectedWallet: BANKR_WALLET,
      log: (m) => console.log(m),
    });

  // -- the two-sided underwriter tx list, in computeTxDiff descriptor shape --
  const now = (await publicClient.getBlock()).timestamp;
  const capacity = USDC("1.5");
  const maxClaim = USDC("0.1");
  const rateBps = 1133n;
  const premium = (maxClaim * rateBps) / 10_000n; // 0.011330 USDC
  const approveExact = capacity + premium;
  const saleEnd = now + 14n * 86400n;
  const obsEnd = saleEnd + 30n * 86400n;
  const series = [9288, 10088, Number(rateBps), saleEnd, saleEnd, obsEnd, obsEnd + 30n * 86400n, capacity];

  const sellBuyPlan = {
    txs: [
      { name: `approve pool for exactly ${formatUnits(approveExact, 6)} USDC`, address: T.currency.address, abi: ERC20_ABI, functionName: "approve", args: [T.pool, approveExact], value: 0n },
      { name: `createSeries(9288/10088, ${rateBps} bps, capacity ${formatUnits(capacity, 6)} USDC)`, address: T.pool, abi: POOL_ABI, functionName: "createSeries", args: series, value: 0n },
      { name: `buyProtectionFor(${seriesId}, ${formatUnits(maxClaim, 6)}, max ${formatUnits(premium, 6)})`, address: T.pool, abi: POOL_ABI, functionName: "buyProtectionFor", args: [seriesId, maxClaim, premium, BANKR_WALLET], value: 0n },
      { name: `setSeriesPaused(${seriesId}, true)`, address: T.pool, abi: POOL_ABI, functionName: "setSeriesPaused", args: [seriesId, true], value: 0n },
    ],
  };

  // -- 1. gate proof: BANKR_EXECUTE off => gated, nothing submitted ----------
  const gatedOut = await makeExecutor({ executeEnabled: false }).execute(sellBuyPlan, { dryRun: false });
  assert.equal(gatedOut.gated, true, "without BANKR_EXECUTE=1 the executor must gate");
  assert.equal(submits, 0, "a gated plan must never reach /wallet/submit");
  console.log(`bankr-fork-proof: PROVED gate — ${gatedOut.error}`);

  // -- 2. full custody pipeline: sell leg + buy leg + creator lever ----------
  const ex = makeExecutor({ executeEnabled: true });
  const out = await ex.execute(sellBuyPlan, { dryRun: false });
  assert.equal(out.ok, true, `custody execution failed: ${out.error}`);
  assert.equal(out.executed.length, 4);
  assert.equal(submits, 4, "each tx goes through /wallet/submit exactly once");

  const s = await publicClient.readContract({ address: T.pool, abi: POOL_ABI, functionName: "series", args: [seriesId] });
  assert.equal(s.creator.toLowerCase(), BANKR_WALLET, "series creator must be the Bankr wallet");
  assert.equal(s.escrow, capacity);
  assert.equal(s.sold, maxClaim);
  assert.equal(s.premiumsAccrued, premium);
  assert.equal(s.strikeLowCents, 9288);
  assert.equal(s.strikeHighCents, 10088);
  const paused = await publicClient.readContract({ address: T.pool, abi: POOL_ABI, functionName: "seriesPaused", args: [seriesId] });
  assert.equal(paused, true);
  const cover = await publicClient.readContract({ address: T.token, abi: COVER_TOKEN_ABI, functionName: "balanceOf", args: [BANKR_WALLET, seriesId] });
  assert.equal(cover, maxClaim, "soulbound cover units must sit on the Bankr wallet");
  const allowanceAfter = await publicClient.readContract({ address: T.currency.address, abi: ERC20_ABI, functionName: "allowance", args: [BANKR_WALLET, T.pool] });
  assert.equal(allowanceAfter, 0n, "the exact approve must be fully consumed");
  const usdcAfter = await publicClient.readContract({ address: T.currency.address, abi: ERC20_ABI, functionName: "balanceOf", args: [BANKR_WALLET] });
  assert.equal(usdcStart - usdcAfter, approveExact, "wallet spent exactly escrow + premium");
  console.log(
    `bankr-fork-proof: PROVED custody pipeline — series ${seriesId} created by ${BANKR_WALLET}, escrow ${formatUnits(s.escrow, 6)} USDC, ` +
      `sold ${formatUnits(s.sold, 6)}, premiums ${formatUnits(s.premiumsAccrued, 6)}, paused, cover minted, allowance consumed`,
  );

  // -- 3. PARTIAL semantics: 2nd tx must revert (AlreadySold) ----------------
  const partialPlan = {
    txs: [
      { name: `setSeriesPaused(${seriesId}, false)`, address: T.pool, abi: POOL_ABI, functionName: "setSeriesPaused", args: [seriesId, false], value: 0n },
      { name: `cancelSeries(${seriesId}) [must revert: sold > 0]`, address: T.pool, abi: POOL_ABI, functionName: "cancelSeries", args: [seriesId], value: 0n },
    ],
  };
  const partial = await ex.execute(partialPlan, { dryRun: false });
  assert.equal(partial.ok, false);
  assert.equal(partial.executed.length, 1, "the landed unpause must be listed (exit-4 semantics)");
  assert.match(partial.executed[0].name, /setSeriesPaused/);
  assert.match(partial.failed.name, /cancelSeries/);
  assert.match(partial.error, /AlreadySold/, "the revert must decode to the pool's custom error");
  const pausedAfter = await publicClient.readContract({ address: T.pool, abi: POOL_ABI, functionName: "seriesPaused", args: [seriesId] });
  assert.equal(pausedAfter, false, "the landed tx changed state; the aborted one did not");
  console.log(`bankr-fork-proof: PROVED partial semantics — 1 landed, batch aborted at cancelSeries (${partial.error})`);

  console.log("\nbankr-fork-proof: ALL PROOFS PASSED");
  stop();
}

main().catch((err) => {
  console.error(`\nbankr-fork-proof FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
