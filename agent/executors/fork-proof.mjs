#!/usr/bin/env node
/**
 * fork-proof.mjs — REAL proof that direct.mjs's Option B vocabulary works
 * against the live PERMISSIONLESS contracts, without spending mainnet funds:
 *
 *   1. spawns `anvil --fork-url <target rpc>` on a free port (a real fork:
 *      contract code + storage ARE the deployed CoverPool/currency/oracle);
 *   2. impersonates two actors — the AGENT wallet and a COUNTERPARTY
 *      underwriter — and funds them (Gnosis: wrap native xDAI via WXDAI
 *      deposit(); Arbitrum: the live Bankr wallet's REAL 2.0 USDC is the
 *      funding source, split between the actors);
 *   3. the counterparty opens a cheap series (raw approve + createSeries);
 *   4. runs direct.mjs end-to-end for a two-sided Plan:
 *        approve(escrow) → createSeries (0.4 units ESCROWED) →
 *        approve(premium) → buyProtection (0.3 units on the counterparty)
 *      then the creator levers: setSeriesPaused(true), withdrawResidual after
 *      a time warp past redeemEnd, and cancelSeries on a fresh unsold series;
 *   5. asserts every balance/latch: escrow+premium left the wallet exactly,
 *      soulbound cover minted, sold/escrow bookkeeping, pause flag, residual
 *      refund, cancel refund, exact approvals fully consumed;
 *   6. proves the EXECUTION-TIME CLAMPS against live fork state: an over-cap
 *      escrow (0.6 units) and an over-cap buy notional both refuse (PlanError)
 *      with the caps derived from the LIVE token decimals (18 vs 6).
 *
 * Run: npm run test:fork              (Gnosis, WXDAI 18 decimals)
 *      npm run test:fork:arbitrum     (Arbitrum, native USDC 6 decimals —
 *                                     the decimals matrix against real state)
 * Env: FORK_RPC_URL overrides the upstream RPC for the chosen target.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, parseAbi } from "viem";
import { createDirectExecutor, computeTxDiff, PlanError } from "./direct.mjs";
import { getTarget, targetRpcUrl, POOL_ABI, ERC20_ABI } from "./targets.mjs";

const argv = process.argv.slice(2);
const targetName = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "gnosis";
const TARGET = getTarget(targetName);
const UPSTREAM = process.env.FORK_RPC_URL ?? targetRpcUrl(TARGET);
const DEC = TARGET.currency.decimals;
const U = (x) => parseUnits(x, DEC);
const fmt = (u) => `${formatUnits(u, DEC)} ${TARGET.currency.symbol}`;

// Actors. AGENT is an arbitrary impersonated wallet; the FUNDER on Arbitrum is
// the real Bankr-custodied wallet (holds 2.0 native USDC live, verified
// 2026-09-19) — its forked balance funds both actors, so the proof runs on the
// exact wallet the Bankr rail would custody. No real key is ever used.
const AGENT = "0x1111100000000000000000000000000000011111";
const COUNTERPARTY = "0x2222200000000000000000000000000000022222";
const ARBITRUM_FUNDER = "0x1a7223bc942b053794e17b537e73d837cf695561"; // BANKR_WALLET

const WXDAI_DEPOSIT_ABI = parseAbi(["function deposit() payable"]);

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
  console.log(`fork-proof[${TARGET.name}]: anvil --fork-url ${UPSTREAM} --port ${port}`);
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

  const publicClient = createPublicClient({ chain: TARGET.chain, transport: http(rpcUrl) });

  // Wait for the fork to answer (forking a public RPC can take a while).
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const id = await publicClient.getChainId();
      assert.equal(id, TARGET.chainId, `fork must preserve chainId ${TARGET.chainId}, got ${id}`);
      break;
    } catch {
      if (anvil.exitCode !== null) throw new Error(`anvil exited early: ${anvilErr}`);
      if (Date.now() > deadline) throw new Error(`anvil not ready after 120s: ${anvilErr}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const forkBlock = await publicClient.getBlockNumber();
  console.log(`fork-proof: forked ${TARGET.name} mainnet at block ${forkBlock} (chainId ${TARGET.chainId} confirmed)`);

  const rpc = (method, params) => publicClient.request({ method, params });
  const gasWei = "0x" + parseUnits("10", 18).toString(16);
  for (const a of [AGENT, COUNTERPARTY, ARBITRUM_FUNDER]) {
    await rpc("anvil_impersonateAccount", [a]);
    await rpc("anvil_setBalance", [a, gasWei]);
  }
  const walletOf = (account) => createWalletClient({ chain: TARGET.chain, transport: http(rpcUrl), account });

  // -- fund the actors with the pool currency ---------------------------------
  if (TARGET.name === "gnosis") {
    // WXDAI is WETH9-style: deposit() wraps native xDAI 1:1 (test scaffolding
    // only — the executor itself never wraps; it refuses on shortfall).
    for (const a of [AGENT, COUNTERPARTY]) {
      const hash = await walletOf(a).writeContract({
        address: TARGET.addresses.currency,
        abi: WXDAI_DEPOSIT_ABI,
        functionName: "deposit",
        value: parseUnits("2", 18),
        account: a,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  } else {
    // Native USDC cannot be minted on a fork — the REAL Bankr wallet balance
    // (2.0 USDC live) funds both actors.
    const funderBal = await publicClient.readContract({
      address: TARGET.addresses.currency,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [ARBITRUM_FUNDER],
    });
    console.log(`fork-proof: Bankr wallet holds ${fmt(funderBal)} on the fork (REAL live balance)`);
    assert.ok(funderBal >= U("1.5"), `Bankr wallet must hold >= 1.5 USDC to fund the proof, has ${fmt(funderBal)}`);
    for (const [to, amt] of [
      [AGENT, U("0.6")],
      [COUNTERPARTY, U("0.9")],
    ]) {
      const hash = await walletOf(ARBITRUM_FUNDER).writeContract({
        address: TARGET.addresses.currency,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, amt],
        account: ARBITRUM_FUNDER,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  const currencyBal = (a) =>
    publicClient.readContract({ address: TARGET.addresses.currency, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
  const readSeries = (id) =>
    publicClient.readContract({ address: TARGET.addresses.pool, abi: POOL_ABI, functionName: "series", args: [BigInt(id)] });

  // -- counterparty opens a cheap series (raw calls — market scaffolding) ------
  const block0 = await publicClient.getBlock();
  const now = Number(block0.timestamp);
  const DAY = 86_400;
  const cpEscrow = U("0.8");
  const cpSeries = {
    strikeLowCents: 9288,
    strikeHighCents: 10088,
    premiumRateBps: 1000, // 10% — deliberately cheap so the agent's buy leg has edge
    saleEnd: BigInt(now + 5 * DAY),
    obsStart: BigInt(now + 5 * DAY),
    obsEnd: BigInt(now + 6 * DAY),
    redeemEnd: BigInt(now + 13 * DAY + 3600),
  };
  {
    const cp = walletOf(COUNTERPARTY);
    let hash = await cp.writeContract({
      address: TARGET.addresses.currency,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [TARGET.addresses.pool, cpEscrow],
      account: COUNTERPARTY,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await cp.writeContract({
      address: TARGET.addresses.pool,
      abi: POOL_ABI,
      functionName: "createSeries",
      args: [
        cpSeries.strikeLowCents,
        cpSeries.strikeHighCents,
        cpSeries.premiumRateBps,
        cpSeries.saleEnd,
        cpSeries.obsStart,
        cpSeries.obsEnd,
        cpSeries.redeemEnd,
        cpEscrow,
      ],
      account: COUNTERPARTY,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const seriesCount0 = Number(
    await publicClient.readContract({ address: TARGET.addresses.pool, abi: POOL_ABI, functionName: "seriesCount" }),
  );
  const B = seriesCount0 - 1; // the counterparty's series id
  console.log(`fork-proof: counterparty opened series ${B} (${fmt(cpEscrow)} escrow @ ${cpSeries.premiumRateBps} bps)`);

  // -- the agent's Direct executor (impersonated, no real key) -----------------
  const direct = createDirectExecutor({
    rpcUrl,
    impersonate: AGENT,
    addresses: TARGET.addresses,
    chain: TARGET.chain,
    explorerTx: (h) => h,
    log: () => {},
  });
  const state0 = await direct.readState();
  assert.equal(state0.decimals, DEC, "LIVE token decimals drive the caps");
  const agentBal0 = state0.currencyUnits;

  // ---- Plan 1: two-sided — SELL our own series + BUY the counterparty's ------
  const A_escrow = U("0.4");
  const buyClaim = U("0.3");
  const buyPremium = (buyClaim * 1000n) / 10_000n; // 10% => 0.03 units
  const ourSeries = {
    strikeLowCents: 9288,
    strikeHighCents: 10088,
    premiumRateBps: 919,
    saleEnd: now + 3600,
    obsStart: now + 3600,
    obsEnd: now + 2 * 3600,
    redeemEnd: now + 2 * 3600 + 7 * DAY + 3600,
    capacityUnits: A_escrow,
  };
  const plan1 = {
    newSeries: ourSeries,
    buys: [{ seriesId: B, maxClaimUnits: buyClaim, maxPremiumUnits: buyPremium }],
    rationale: ["fork-proof: two-sided plan (escrowed sell + arbitrage buy)"],
  };

  // dry run first: the tx list comes back WITHOUT anything being sent
  const dry = await direct.execute(plan1, { dryRun: true });
  assert.equal(dry.ok, true, `dry run failed: ${dry.error}`);
  assert.deepEqual(
    dry.txs.map((t) => t.functionName),
    ["approve", "createSeries", "approve", "buyProtection"],
    "dry run must plan exact-approve+createSeries (escrow!) then exact-approve+buyProtection",
  );
  assert.equal(dry.budget.totalPullUnits, A_escrow + buyPremium);
  const stateAfterDry = await direct.readState();
  assert.equal(stateAfterDry.seriesCount, seriesCount0, "dry run must not send transactions");
  console.log(`fork-proof: dry run planned ${dry.txs.length} txs, sent none`);

  // live execution against the forked mainnet contracts
  const res1 = await direct.execute(plan1, { dryRun: false });
  assert.equal(res1.ok, true, `plan1 failed: ${res1.error}`);
  assert.equal(res1.executed.length, 4, "expected exactly 4 transactions");
  const A = seriesCount0; // our series id

  const state1 = await direct.readState();
  assert.equal(state1.seriesCount, seriesCount0 + 1, "seriesCount must increment");
  assert.equal(state1.currencyUnits, agentBal0 - A_escrow - buyPremium, "escrow + premium left the wallet EXACTLY");
  assert.equal(state1.allowanceUnits, 0n, "exact approvals fully consumed");

  const sA = await readSeries(A);
  assert.equal(sA.creator.toLowerCase(), AGENT.toLowerCase(), "we are the series creator");
  assert.equal(sA.escrow, A_escrow, "capacity escrowed 1:1 at creation");
  assert.equal(BigInt(sA.premiumRateBps), 919n);
  assert.equal(sA.sold, 0n);
  const sB = await readSeries(B);
  assert.equal(sB.sold, buyClaim, "counterparty series sold == our claim");
  assert.equal(sB.premiumsAccrued, buyPremium, "premium accrued into the SERIES bucket");
  const cover = await publicClient.readContract({
    address: TARGET.addresses.token,
    abi: parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [AGENT, BigInt(B)],
  });
  assert.equal(cover, buyClaim, "soulbound cover minted to the agent");
  console.log(`fork-proof: plan1 OK — series ${A} created (${fmt(A_escrow)} escrowed), bought ${fmt(buyClaim)} cover on ${B} for ${fmt(buyPremium)}`);

  // ---- clamp re-enforcement against LIVE fork state (pure, no txs) -----------
  assert.throws(
    () => computeTxDiff({ newSeries: { ...ourSeries, capacityUnits: U("0.6") } }, state1, { addresses: TARGET.addresses }),
    PlanError,
    "0.6-unit escrow must refuse (0.5-unit per-run cap at LIVE decimals)",
  );
  assert.throws(
    () =>
      computeTxDiff(
        { buys: [{ seriesId: B, maxClaimUnits: U("0.6"), maxPremiumUnits: U("0.06") }] },
        state1,
        { addresses: TARGET.addresses },
      ),
    PlanError,
    "0.6-unit buy notional must refuse",
  );
  console.log(`fork-proof: execution-time caps re-enforced from LIVE state (decimals=${state1.decimals})`);

  // ---- Plan 2: creator lever — pause our own series ---------------------------
  const res2 = await direct.execute({ pauses: [{ seriesId: A, paused: true }] }, { dryRun: false });
  assert.equal(res2.ok, true, `plan2 failed: ${res2.error}`);
  assert.deepEqual(res2.executed.map((t) => t.functionName), ["setSeriesPaused"]);
  assert.equal(
    await publicClient.readContract({ address: TARGET.addresses.pool, abi: POOL_ABI, functionName: "seriesPaused", args: [BigInt(A)] }),
    true,
  );
  console.log(`fork-proof: plan2 OK — series ${A} paused (sales only; settle/redeem unaffected)`);

  // ---- warp past redeemEnd, Plan 3: withdrawResidual --------------------------
  await rpc("evm_increaseTime", [9 * DAY]);
  await rpc("evm_mine", []);
  const balBefore = await currencyBal(AGENT);
  const res3 = await direct.execute({ withdrawResiduals: [A] }, { dryRun: false });
  assert.equal(res3.ok, true, `plan3 failed: ${res3.error}`);
  assert.deepEqual(res3.executed.map((t) => t.functionName), ["withdrawResidual"]);
  const balAfter = await currencyBal(AGENT);
  assert.equal(balAfter - balBefore, A_escrow, "residual = full escrow (nothing sold, no premiums)");
  // one-shot latch: a second attempt is dropped locally, not sent
  const res3b = await direct.execute({ withdrawResiduals: [A] }, { dryRun: false });
  assert.equal(res3b.ok, true);
  assert.equal(res3b.executed.length, 0, "residual one-shot: second attempt is a local no-op");
  assert.ok(res3b.notes.some((n) => n.includes("residual already taken")));
  console.log(`fork-proof: plan3 OK — residual ${fmt(A_escrow)} returned once, latch respected`);

  // ---- Plan 4: fresh series then cancel (unsold refund path) ------------------
  const block2 = await publicClient.getBlock();
  const now2 = Number(block2.timestamp);
  const D_escrow = U("0.2");
  const seriesD = {
    ...ourSeries,
    saleEnd: now2 + 3600,
    obsStart: now2 + 3600,
    obsEnd: now2 + 2 * 3600,
    redeemEnd: now2 + 2 * 3600 + 7 * DAY + 3600,
    capacityUnits: D_escrow,
  };
  const res4a = await direct.execute({ newSeries: seriesD }, { dryRun: false });
  assert.equal(res4a.ok, true, `plan4a failed: ${res4a.error}`);
  const D = state1.seriesCount; // next id
  const balBeforeCancel = await currencyBal(AGENT);
  const res4b = await direct.execute({ cancels: [D] }, { dryRun: false });
  assert.equal(res4b.ok, true, `plan4b failed: ${res4b.error}`);
  assert.deepEqual(res4b.executed.map((t) => t.functionName), ["cancelSeries"]);
  const sD = await readSeries(D);
  assert.equal(sD.cancelled, true);
  assert.equal(sD.escrow, 0n, "cancel zeroes the escrow (books closed)");
  assert.equal((await currencyBal(AGENT)) - balBeforeCancel, D_escrow, "cancel refunds the full escrow");
  console.log(`fork-proof: plan4 OK — series ${D} created then cancelled, ${fmt(D_escrow)} refunded`);

  console.log(`\nfork-proof[${TARGET.name}]: PROOF SUMMARY`);
  console.log(`  fork:      ${TARGET.name} mainnet @ block ${forkBlock} via ${UPSTREAM}`);
  console.log(`  pool:      ${TARGET.addresses.pool} (real deployed bytecode + storage, ${DEC} decimals)`);
  console.log(`  agent:     ${AGENT} (impersonated, no real key used)`);
  for (const t of [...res1.executed, ...res2.executed, ...res3.executed, ...res4a.executed, ...res4b.executed])
    console.log(`  tx ${t.functionName.padEnd(16)} gasUsed=${t.gasUsed} block=${t.blockNumber}`);
  console.log("fork-proof: ALL ASSERTIONS PASSED — Option B vocabulary (escrowed create, buy leg, pause, residual, cancel) verified against mainnet state without spending");
  stop();
}

main().catch((err) => {
  console.error("fork-proof FAILED:", err);
  process.exit(1);
});
