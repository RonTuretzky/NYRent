#!/usr/bin/env node
/**
 * fork-proof.mjs — REAL proof that direct.mjs's sponsor levers work against the
 * live Gnosis contracts, without spending mainnet funds:
 *
 *   1. spawns `anvil --fork-url https://rpc.gnosischain.com` on a free port
 *      (a real fork: contract code + storage ARE the mainnet CoverPool/WXDAI/oracle);
 *   2. impersonates the immutable sponsor (anvil_impersonateAccount + anvil_setBalance)
 *      and empties its WXDAI so the wrap path is forced;
 *   3. runs direct.mjs end-to-end for a real Plan:
 *        setSalesPaused(true) FIRST (safety before capital moves) → wrap 0.1 xDAI
 *        → approve exact → fundPool(0.1) → createSeries
 *      then a second Plan: withdrawExcess(0.05) + setSalesPaused(false) (unpause LAST);
 *   4. asserts seriesCount incremented, every series field matches the Plan,
 *      freeCapital moved by exactly the funded/withdrawn amounts, and the exact
 *      approve was fully consumed (allowance back to 0).
 *
 * Run: npm run test:fork   (env FORK_RPC_URL overrides the upstream RPC)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { createPublicClient, http, parseEther, formatEther } from "viem";
import { gnosis } from "viem/chains";
import { createDirectExecutor } from "./direct.mjs";
import { ADDRESSES, POOL_ABI, WXDAI_ABI, DEFAULT_RPC_URL } from "./chain.mjs";

const UPSTREAM = process.env.FORK_RPC_URL ?? DEFAULT_RPC_URL;
const SPONSOR = ADDRESSES.sponsor;

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
  console.log(`fork-proof: anvil --fork-url ${UPSTREAM} --port ${port}`);
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

  const publicClient = createPublicClient({ chain: gnosis, transport: http(rpcUrl) });

  // Wait for the fork to answer (forking a public RPC can take a while).
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const id = await publicClient.getChainId();
      assert.equal(id, 100, `fork must preserve Gnosis chainId, got ${id}`);
      break;
    } catch {
      if (anvil.exitCode !== null) throw new Error(`anvil exited early: ${anvilErr}`);
      if (Date.now() > deadline) throw new Error(`anvil not ready after 120s: ${anvilErr}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const forkBlock = await publicClient.getBlockNumber();
  console.log(`fork-proof: forked Gnosis mainnet at block ${forkBlock} (chainId 100 confirmed)`);

  // Impersonate the immutable sponsor and give it gas + wrap headroom.
  await publicClient.request({ method: "anvil_impersonateAccount", params: [SPONSOR] });
  await publicClient.request({ method: "anvil_setBalance", params: [SPONSOR, "0x" + parseEther("10").toString(16)] });

  const direct = createDirectExecutor({ rpcUrl, impersonate: SPONSOR });
  const state0 = await direct.readState();
  console.log(
    `fork-proof: REAL mainnet state — seriesCount=${state0.seriesCount}, freeCapital=${formatEther(state0.freeCapitalWei)} WXDAI, ` +
      `sponsor WXDAI=${formatEther(state0.wxdaiWei)}, allowance=${state0.allowanceWei}, salesPaused=${state0.salesPaused}`,
  );
  assert.equal(state0.sponsor.toLowerCase(), SPONSOR.toLowerCase(), "pool.sponsor() must be the impersonated account");

  // Force the wrap path: move ALL of the sponsor's forked WXDAI away (a real
  // WXDAI.transfer sent as the impersonated sponsor).
  if (state0.wxdaiWei > 0n) {
    const hash = await direct.walletClient.writeContract({
      address: ADDRESSES.currency,
      abi: WXDAI_ABI,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", state0.wxdaiWei],
      account: SPONSOR,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`fork-proof: setup — parked ${formatEther(state0.wxdaiWei)} sponsor WXDAI at 0xdEaD to force the wrap path`);
  }

  const block = await publicClient.getBlock();
  const now = block.timestamp;
  const plan = {
    targetFreeCapitalWei: state0.freeCapitalWei + parseEther("0.1"),
    newSeries: {
      strikeLowCents: 8900,
      strikeHighCents: 9700,
      premiumRateBps: 2500,
      saleEnd: now + 7n * 86400n, // = obsStart: no informed-trading overlap
      obsStart: now + 7n * 86400n,
      obsEnd: now + 14n * 86400n,
      redeemEnd: now + 21n * 86400n,
      capacity: parseEther("0.5"),
    },
    pause: true,
    rationale: ["fork-proof: exercise every sponsor lever against forked mainnet state"],
  };

  // --- dry run first: the tx list comes back WITHOUT anything being sent -----
  const dry = await direct.execute(plan, { dryRun: true });
  assert.equal(dry.ok, true, `dry run failed: ${dry.error}`);
  assert.deepEqual(
    dry.txs.map((t) => t.functionName),
    ["setSalesPaused", "deposit", "approve", "fundPool", "createSeries"],
    "dry run must plan setSalesPaused(true) FIRST (safety), then wrap -> approve -> fundPool -> createSeries",
  );
  const stateAfterDry = await direct.readState();
  assert.equal(stateAfterDry.seriesCount, state0.seriesCount, "dry run must not send transactions");
  console.log(`fork-proof: dry run planned ${dry.txs.length} txs, sent none (seriesCount still ${stateAfterDry.seriesCount})`);

  // --- live execution against the forked mainnet contracts -------------------
  const res = await direct.execute(plan, { dryRun: false });
  assert.equal(res.ok, true, `execute failed: ${res.error}`);
  assert.equal(res.executed.length, 5, "expected exactly 5 transactions");

  const state1 = await direct.readState();
  const newId = state0.seriesCount; // series ids are 0-based
  assert.equal(state1.seriesCount, state0.seriesCount + 1n, "seriesCount must increment");
  assert.equal(state1.freeCapitalWei, state0.freeCapitalWei + parseEther("0.1"), "freeCapital must rise by exactly the funded 0.1 WXDAI");
  assert.equal(state1.allowanceWei, 0n, "exact approve must be fully consumed by fundPool");
  assert.equal(state1.salesPaused, true, "setSalesPaused(true) must be live");

  const s = await publicClient.readContract({ address: ADDRESSES.pool, abi: POOL_ABI, functionName: "series", args: [newId] });
  assert.equal(BigInt(s.strikeLowCents), 8900n);
  assert.equal(BigInt(s.strikeHighCents), 9700n);
  assert.equal(BigInt(s.premiumRateBps), 2500n);
  assert.equal(s.saleEnd, plan.newSeries.saleEnd);
  assert.equal(s.obsStart, plan.newSeries.obsStart);
  assert.equal(s.obsEnd, plan.newSeries.obsEnd);
  assert.equal(s.redeemEnd, plan.newSeries.redeemEnd);
  assert.equal(s.capacity, plan.newSeries.capacity);
  assert.equal(s.sold, 0n);
  assert.equal(s.settled, false);
  console.log(`fork-proof: series ${newId} on the fork matches the Plan field-for-field`);

  // --- second plan: the remaining lever (withdrawExcess) + unpause ------------
  const plan2 = { targetFreeCapitalWei: state1.freeCapitalWei - parseEther("0.05"), newSeries: null, pause: false, rationale: ["fork-proof: withdraw + unpause"] };
  const res2 = await direct.execute(plan2, { dryRun: false });
  assert.equal(res2.ok, true, `plan2 failed: ${res2.error}`);
  assert.deepEqual(res2.executed.map((t) => t.functionName), ["withdrawExcess", "setSalesPaused"]);

  const state2 = await direct.readState();
  assert.equal(state2.freeCapitalWei, state1.freeCapitalWei - parseEther("0.05"), "freeCapital must fall by exactly 0.05");
  assert.equal(state2.wxdaiWei, parseEther("0.05"), "withdrawn WXDAI must land on the sponsor");
  assert.equal(state2.salesPaused, false);

  console.log("\nfork-proof: PROOF SUMMARY");
  console.log(`  fork:            Gnosis mainnet @ block ${forkBlock} via ${UPSTREAM}`);
  console.log(`  pool:            ${ADDRESSES.pool} (real deployed bytecode + storage)`);
  console.log(`  sponsor:         ${SPONSOR} (impersonated, no real key used)`);
  for (const t of [...res.executed, ...res2.executed]) console.log(`  tx ${t.functionName.padEnd(15)} gasUsed=${t.gasUsed} block=${t.blockNumber}`);
  console.log(`  seriesCount:     ${state0.seriesCount} -> ${state1.seriesCount}`);
  console.log(`  freeCapital:     ${formatEther(state0.freeCapitalWei)} -> ${formatEther(state1.freeCapitalWei)} -> ${formatEther(state2.freeCapitalWei)} WXDAI`);
  console.log(`  salesPaused:     false -> true -> false`);
  console.log("fork-proof: ALL ASSERTIONS PASSED — sponsor levers verified against mainnet state without spending");
  stop();
}

main().catch((err) => {
  console.error("fork-proof FAILED:", err);
  process.exit(1);
});
