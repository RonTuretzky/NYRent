#!/usr/bin/env node
/**
 * mm-cycle-fork-proof.mjs — POLICY-DRIVEN market-maker cycle proof on a real
 * anvil fork. Where fork-proof.mjs hand-crafts plans to prove the EXECUTOR's
 * vocabulary, this proof lets policy/decide.mjs produce every plan — the full
 * loop the daily runner drives, against the real deployed contracts:
 *
 *   CYCLE 1 (SELL): a FRESH funded EOA (anvil dev key #0 — real ECDSA signing,
 *     no impersonation for the agent) reads chain state via run.mjs's
 *     readChainState, calls decide(), gets a newSeries plan (fair × 1.25
 *     loading, escrow = min(80% × wallet × health, 0.5 units)), executes via
 *     direct.mjs → asserts the escrow left the wallet 1:1.
 *   SCAFFOLD: a SECOND actor (anvil dev key #1) creates an UNDERPRICED series
 *     (200 bps — far below model fair) and also buys cover on the agent's
 *     series, so the agent's book earns real premiums.
 *   CYCLE 2 (BUY / re-run): decide() re-runs on fresh chain state → the plan
 *     INCLUDES a buy of the underpriced series (edge ≥ EDGE_MIN 300 bps),
 *     NEVER the agent's own, and no second newSeries (one own live sale at a
 *     time) → execute → asserts soulbound cover held, series premiumsAccrued,
 *     exact wallet delta, allowance fully consumed.
 *   CYCLE 3 (RESIDUAL + REDEEM — profit realization): warp past the agent
 *     series' redeemEnd; a qualifying observation is INJECTED into the
 *     oracle's storage (anvil_setStorageAt — scaffolding of the same kind as
 *     the impersonated funding: the live oracle only accepts DKIM-verified
 *     CRE Daily emails, and any real fixture email's signature timestamp
 *     predates the fork, so it can never land inside a fresh series' strictly
 *     future obs window) and the POOL's real settle() fixes series B's ratio
 *     from it (mid-band print 9688c on strikes 9288/10088 → ratio 0.5e18).
 *     decide() then refuses sell+buy (stale print) but plans
 *     withdrawResidual(own) AND redeems:[{B, heldUnits}] → execute → asserts
 *     the residual == escrow + premiumsAccrued − paidOut AND the redeem
 *     collects EXACTLY units × ratio (the buy side's profit realization),
 *     cover burned to zero, to the base unit.
 *
 * SIGNALS: the two live oracles hold ZERO observations (verified 2026-09-19),
 * so the collector feed is the only print source in production today; this
 * proof injects a deterministic synthetic print (9288c, 1d old) as that feed —
 * decide()'s plausibility gate is a no-op without an oracle print, exactly as
 * on the live chains.
 *
 * Run:  node executors/mm-cycle-fork-proof.mjs [--target gnosis|arbitrum]
 * Env:  FORK_RPC_URL overrides the upstream RPC for the chosen target.
 * Funding: gnosis wraps native xDAI via WXDAI.deposit(); arbitrum splits the
 * REAL Bankr wallet's live 2.0 native USDC between the two actors
 * (anvil_impersonateAccount scaffolding only — the agent itself key-signs).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, parseAbi, keccak256, numberToHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { decide, DEFAULT_CONFIG } from "../policy/decide.mjs";
import { readChainState } from "../run.mjs";
import { createDirectExecutor } from "./direct.mjs";
import { getTarget, targetRpcUrl, POOL_ABI, ERC20_ABI, COVER_TOKEN_ABI } from "./targets.mjs";

const argv = process.argv.slice(2);
const targetName = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "gnosis";
const T = getTarget(targetName);
const UPSTREAM = process.env.FORK_RPC_URL ?? targetRpcUrl(T);
const DEC = T.currency.decimals;
const U = (x) => parseUnits(x, DEC);
const fmt = (u) => `${formatUnits(u, DEC)} ${T.currency.symbol}`;
const DAY = 86_400;

// GENUINELY FRESH random EOAs, generated per run (ephemeral, worthless keys —
// they exist only inside this fork). NOT anvil's well-known dev accounts: those
// keys are public, swept, and carry EIP-7702 delegations on Gnosis + Arbitrum
// mainnet (0xef0100… code), which makes the soulbound ERC-1155 CoverToken mint
// revert ERC1155InvalidReceiver — a fresh EOA is both more faithful to the
// brief and the only thing that works on a fork of real state. Gas is seeded
// via anvil_setBalance (scaffolding); every agent tx is real ECDSA signing.
const AGENT_KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(AGENT_KEY);
const CP = privateKeyToAccount(generatePrivateKey());
const BANKR_WALLET = "0x1a7223bc942b053794e17b537e73d837cf695561"; // arbitrum USDC funding source

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
  console.log(`mm-cycle[${T.name}]: anvil --fork-url ${UPSTREAM} --port ${port}`);
  const anvil = spawn("anvil", ["--fork-url", UPSTREAM, "--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let anvilErr = "";
  anvil.stderr.on("data", (d) => (anvilErr += d));
  const stop = () => {
    try {
      anvil.kill("SIGKILL");
    } catch {
      /* gone */
    }
  };
  process.on("exit", stop);

  const pub = createPublicClient({ chain: T.chain, transport: http(rpcUrl) });
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      assert.equal(await pub.getChainId(), T.chainId);
      break;
    } catch {
      if (anvil.exitCode !== null) throw new Error(`anvil exited early: ${anvilErr}`);
      if (Date.now() > deadline) throw new Error(`anvil not ready after 120s: ${anvilErr}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const forkBlock = await pub.getBlockNumber();
  console.log(`mm-cycle: forked ${T.name} at block ${forkBlock} (chainId ${T.chainId})`);

  const rpc = (method, params) => pub.request({ method, params });
  const wallet = (account) => createWalletClient({ chain: T.chain, transport: http(rpcUrl), account });
  const bal = (a) => pub.readContract({ address: T.currency.address, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
  const seriesRow = (id) => pub.readContract({ address: T.pool, abi: POOL_ABI, functionName: "series", args: [BigInt(id)] });

  // -- fund the two fresh EOAs: native gas, then the pool currency ------------
  for (const a of [AGENT.address, CP.address]) {
    await rpc("anvil_setBalance", [a, "0x" + parseUnits("10", 18).toString(16)]);
  }
  if (T.name === "gnosis") {
    for (const [acct, amt] of [
      [AGENT, "3"],
      [CP, "2"],
    ]) {
      const hash = await wallet(acct).writeContract({
        address: T.currency.address,
        abi: WXDAI_DEPOSIT_ABI,
        functionName: "deposit",
        value: parseUnits(amt, 18),
        account: acct,
      });
      await pub.waitForTransactionReceipt({ hash });
    }
  } else {
    // native USDC cannot be minted — the REAL Bankr wallet's live 2.0 USDC
    // funds both actors (impersonation is scaffolding; the agent key-signs).
    await rpc("anvil_impersonateAccount", [BANKR_WALLET]);
    await rpc("anvil_setBalance", [BANKR_WALLET, "0x" + parseUnits("1", 18).toString(16)]);
    for (const [to, amt] of [
      [AGENT.address, U("1")],
      [CP.address, U("1")],
    ]) {
      const hash = await wallet(BANKR_WALLET).writeContract({
        address: T.currency.address,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, amt],
        account: BANKR_WALLET,
      });
      await pub.waitForTransactionReceipt({ hash });
    }
  }
  console.log(`mm-cycle: fresh agent EOA ${AGENT.address} funded ${fmt(await bal(AGENT.address))} (key-signing, not impersonated)`);

  const seriesCount0 = Number(await pub.readContract({ address: T.pool, abi: POOL_ABI, functionName: "seriesCount" }));

  // The policy + executor stack under proof — exactly what run.mjs wires up.
  const config = { ...DEFAULT_CONFIG, decimals: DEC };
  const direct = createDirectExecutor({
    rpcUrl,
    privateKey: AGENT_KEY,
    addresses: T.addresses,
    chain: T.chain,
    explorerTx: (h) => h,
    log: () => {},
  });
  const scanState = () => readChainState(pub, T, AGENT.address);

  // Deterministic synthetic print = the collector feed (see header).
  const t0 = Number((await pub.getBlock()).timestamp);
  const signals = { prints: [{ t: t0 - 1 * DAY, cents: 9288, source: "credaily-web (synthetic fork stand-in)" }], kalshi: null };

  // ---- CYCLE 1: SELL — decide() plans the agent's own series ----------------
  const state1 = await scanState();
  assert.equal(state1.ok, true, "chain read must succeed");
  const plan1 = decide(signals, state1, config);
  assert.equal(plan1.refused, false);
  assert.ok(plan1.newSeries, "cycle 1 must plan a newSeries (sell side)");
  assert.equal(plan1.buys.length, 0, "no market to buy yet");
  const cap = plan1.newSeries.capacityUnits;
  assert.equal(cap, U("0.5"), "escrow = min(80% × wallet × health, 0.5 units) — the 0.5-unit clamp binds");
  assert.ok(plan1.newSeries.premiumRateBps >= 500 && plan1.newSeries.premiumRateBps <= 5000);
  assert.equal(plan1.newSeries.saleEnd, plan1.newSeries.obsStart, "saleEnd == obsStart production rule");

  const balBefore1 = await bal(AGENT.address);
  const res1 = await direct.execute(plan1, { dryRun: false });
  assert.equal(res1.ok, true, `cycle 1 execution failed: ${res1.error}`);
  assert.deepEqual(res1.executed.map((t) => t.functionName), ["approve", "createSeries"]);
  const A = seriesCount0; // agent's series id
  const rowA = await seriesRow(A);
  assert.equal(rowA.creator.toLowerCase(), AGENT.address.toLowerCase());
  assert.equal(rowA.escrow, cap, "capacity escrowed 1:1 at creation");
  assert.equal(balBefore1 - (await bal(AGENT.address)), cap, "ESCROW PULLED from the fresh EOA exactly");
  console.log(
    `mm-cycle: CYCLE 1 OK — decide() sold: series ${A} strikes ${plan1.newSeries.strikeLowCents}/${plan1.newSeries.strikeHighCents}c @ ${plan1.newSeries.premiumRateBps} bps, escrow ${fmt(cap)} pulled`,
  );

  // ---- SCAFFOLD: second actor — underpriced series + a buy on OUR series ----
  const nowCp = Number((await pub.getBlock()).timestamp);
  const cpEscrow = U("0.8");
  const cpWallet = wallet(CP);
  let hash = await cpWallet.writeContract({
    address: T.currency.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [T.pool, cpEscrow],
    account: CP,
  });
  await pub.waitForTransactionReceipt({ hash });
  hash = await cpWallet.writeContract({
    address: T.pool,
    abi: POOL_ABI,
    functionName: "createSeries",
    // 200 bps quoted vs a model fair well above 500 bps => edge > EDGE_MIN 300.
    args: [9288, 10088, 200, BigInt(nowCp + 10 * DAY), BigInt(nowCp + 10 * DAY), BigInt(nowCp + 70 * DAY), BigInt(nowCp + 78 * DAY), cpEscrow],
    account: CP,
  });
  await pub.waitForTransactionReceipt({ hash });
  const B = seriesCount0 + 1; // counterparty's series id

  // The counterparty also buys cover on the AGENT's series (premium accrues to
  // the agent's book — proves the residual formula's premium leg in cycle 3).
  const cpClaim = U("0.12");
  const [cpPremium] = await pub.readContract({ address: T.pool, abi: POOL_ABI, functionName: "quote", args: [BigInt(A), cpClaim] });
  hash = await cpWallet.writeContract({
    address: T.currency.address,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [T.pool, cpPremium],
    account: CP,
  });
  await pub.waitForTransactionReceipt({ hash });
  hash = await cpWallet.writeContract({
    address: T.pool,
    abi: POOL_ABI,
    functionName: "buyProtection",
    args: [BigInt(A), cpClaim, cpPremium],
    account: CP,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`mm-cycle: SCAFFOLD — counterparty opened UNDERPRICED series ${B} (${fmt(cpEscrow)} @ 200 bps) and bought ${fmt(cpClaim)} of our series ${A} for ${fmt(cpPremium)}`);

  // ---- CYCLE 2: RE-RUN — the plan must include a buy of the cheap series ----
  const state2 = await scanState();
  const plan2 = decide(signals, state2, config);
  assert.equal(plan2.refused, false);
  assert.equal(plan2.newSeries, null, "one own live sale at a time — no second series while ours sells");
  const buy = plan2.buys.find((b) => b.seriesId === B);
  assert.ok(buy, `cycle 2 plan must include a buy of the underpriced series ${B} — got [${plan2.buys.map((b) => b.seriesId)}]`);
  assert.ok(!plan2.buys.some((b) => b.seriesId === A), "the book NEVER buys its own series");
  assert.equal(buy.quotedPremiumBps, 200);
  assert.ok(buy.edgeBps >= 300, `edge ${buy.edgeBps} must clear EDGE_MIN 300`);
  assert.equal(buy.maxClaimUnits, cpEscrow / 4n, "per-series cap: 25% of remaining capacity");
  assert.equal(buy.maxPremiumUnits, (buy.maxClaimUnits * 200n) / 10_000n, "premium = floor(claim × rate / 1e4)");

  const balBefore2 = await bal(AGENT.address);
  const res2 = await direct.execute(plan2, { dryRun: false });
  assert.equal(res2.ok, true, `cycle 2 execution failed: ${res2.error}`);
  assert.deepEqual(res2.executed.map((t) => t.functionName), ["approve", "buyProtection"]);
  const cover = await pub.readContract({ address: T.token, abi: COVER_TOKEN_ABI, functionName: "balanceOf", args: [AGENT.address, BigInt(B)] });
  assert.equal(cover, buy.maxClaimUnits, "soulbound cover held by the agent");
  const rowB = await seriesRow(B);
  assert.equal(rowB.sold, buy.maxClaimUnits, "series sold == our claim");
  assert.equal(rowB.premiumsAccrued, buy.maxPremiumUnits, "premium accounted into the series bucket");
  assert.equal(balBefore2 - (await bal(AGENT.address)), buy.maxPremiumUnits, "wallet paid exactly the planned premium");
  assert.equal(
    await pub.readContract({ address: T.currency.address, abi: ERC20_ABI, functionName: "allowance", args: [AGENT.address, T.pool] }),
    0n,
    "exact approval fully consumed",
  );
  console.log(
    `mm-cycle: CYCLE 2 OK — decide() bought: ${fmt(buy.maxClaimUnits)} cover on series ${B} for ${fmt(buy.maxPremiumUnits)} (fair ${buy.fairRatioBps} bps vs quoted 200 bps, edge ${buy.edgeBps})`,
  );

  // ---- CYCLE 3: warp past our redeemEnd — residual + REDEEM realization ------
  const warp = plan1.newSeries.redeemEnd - t0 + DAY;
  await rpc("evm_increaseTime", [warp]);
  await rpc("evm_mine", []);

  // SCAFFOLD 2: inject a qualifying observation (t inside B's obs window,
  // mid-band cents) into the oracle's storage, then run the POOL's REAL
  // settle() on it. CredailyRentOracle layout: _modulus slot 0,
  // observations[] slot 1 (element i = 2 slots at keccak256(1) + 2i:
  // [t(uint64) | cents(uint32)<<64], [emailId]), recorded mapping slot 2.
  const rowBpre = await seriesRow(B);
  const obsT = BigInt(rowBpre.obsStart) + 86_400n; // strictly inside [obsStart, obsEnd]
  const obsCents = 9688n; // strikes 9288/10088 => ratio (9688-9288)/800 = 0.5e18
  const obsCount = BigInt(await pub.readContract({ address: T.oracle, abi: parseAbi(["function observationCount() view returns (uint256)"]), functionName: "observationCount" }));
  const base = BigInt(keccak256(numberToHex(1n, { size: 32 })));
  await rpc("anvil_setStorageAt", [T.oracle, numberToHex(base + 2n * obsCount, { size: 32 }), numberToHex(obsT | (obsCents << 64n), { size: 32 })]);
  await rpc("anvil_setStorageAt", [T.oracle, numberToHex(base + 2n * obsCount + 1n, { size: 32 }), keccak256(numberToHex(obsT, { size: 32 }))]);
  await rpc("anvil_setStorageAt", [T.oracle, numberToHex(1n, { size: 32 }), numberToHex(obsCount + 1n, { size: 32 })]);
  const [tRead, centsRead] = await pub.readContract({
    address: T.oracle,
    abi: parseAbi(["function observations(uint256 i) view returns (uint64 t, uint32 cents, bytes32 emailId)"]),
    functionName: "observations",
    args: [obsCount],
  });
  assert.equal(BigInt(tRead), obsT, "injected observation timestamp readable");
  assert.equal(BigInt(centsRead), obsCents, "injected observation cents readable");
  let settleHash = await cpWallet.writeContract({
    address: T.pool,
    abi: POOL_ABI,
    functionName: "settle",
    args: [BigInt(B), obsCount],
    account: CP,
  });
  await pub.waitForTransactionReceipt({ hash: settleHash });
  const rowBsettled = await seriesRow(B);
  assert.equal(rowBsettled.settled, true, "B settled permissionlessly from the injected observation");
  const RATIO = rowBsettled.payoutRatioWad;
  assert.equal(RATIO, 10n ** 18n / 2n, "REAL pool settlement math: mid-band print => ratio 0.5e18");
  console.log(`mm-cycle: SCAFFOLD 2 — observation ${obsCents}c @ t=${obsT} injected, settle(${B}) fixed ratio ${RATIO} (0.5e18)`);

  const state3 = await scanState();
  const plan3 = decide(signals, state3, config);
  assert.equal(plan3.refused, false);
  assert.equal(plan3.newSeries, null, "stale print after the warp — sell side must refuse");
  assert.equal(plan3.buys.length, 0, "stale print after the warp — whole buy leg refused");
  assert.deepEqual(plan3.withdrawResiduals, [A], "the matured own series must be planned for residual withdrawal");
  assert.equal(plan3.cancels.length, 0, "matured path takes precedence over cancel");
  // PROFIT REALIZATION: the settled holding MUST be planned for redemption,
  // stale print or not (a settled payout has no valuation dependence).
  assert.deepEqual(
    plan3.redeems,
    [{ seriesId: B, units: buy.maxClaimUnits }],
    "cycle 3 must plan the redeem of the settled bought cover",
  );
  assert.ok(plan3.target && plan3.target.chainId === T.chainId && plan3.target.wallet === AGENT.address, "plan stamped with chain + identity");

  const rowA3 = await seriesRow(A);
  const expectedResidual = rowA3.escrow + rowA3.premiumsAccrued - rowA3.paidOut - rowA3.withdrawn;
  assert.equal(expectedResidual, cap + cpPremium, "residual = escrow + premiums (nothing paid out, nothing withdrawn)");
  const expectedPayout = (buy.maxClaimUnits * RATIO) / 10n ** 18n;
  const balBefore3 = await bal(AGENT.address);
  const res3 = await direct.execute(plan3, { dryRun: false });
  assert.equal(res3.ok, true, `cycle 3 execution failed: ${res3.error}`);
  assert.deepEqual(res3.executed.map((t) => t.functionName), ["withdrawResidual", "redeem"], "collections: residual then redeem");
  assert.equal(
    (await bal(AGENT.address)) - balBefore3,
    expectedResidual + expectedPayout,
    "withdrawResidual + redeem amounts proven to the base unit (units × ratio collected)",
  );
  assert.equal(
    await pub.readContract({ address: T.token, abi: COVER_TOKEN_ABI, functionName: "balanceOf", args: [AGENT.address, BigInt(B)] }),
    0n,
    "redeem burned the soulbound cover",
  );
  assert.equal((await seriesRow(B)).paidOut, expectedPayout, "series B books the payout");
  console.log(
    `mm-cycle: CYCLE 3 OK — warped ${Math.round(warp / DAY)}d, residual ${fmt(expectedResidual)} (escrow ${fmt(cap)} + premiums ${fmt(cpPremium)}) returned, REDEEMED ${fmt(buy.maxClaimUnits)} cover at ratio 0.5 for ${fmt(expectedPayout)} (buy-side profit REALIZED)`,
  );

  // ---- CYCLE 4 (idempotence): a verbatim re-run of plan3 is a no-op ----------
  const res4 = await direct.execute(plan3, { dryRun: false });
  assert.equal(res4.ok, true, `cycle 4 re-run failed: ${res4.error}`);
  assert.equal(res4.executed.length, 0, "re-running the executed plan sends NOTHING (residual latch + no holdings left)");
  assert.ok(res4.notes.some((n) => n.includes("residual already taken")), "residual one-shot respected");
  assert.ok(res4.notes.some((n) => n.includes("no live holdings")), "redeem re-run dropped on live holdings");
  console.log("mm-cycle: CYCLE 4 OK — verbatim re-run of the executed plan is a local no-op (idempotence)");

  console.log(`\nmm-cycle[${T.name}]: ALL POLICY-DRIVEN CYCLE PROOFS PASSED`);
  console.log(`  pool ${T.pool} (${DEC} decimals) @ fork of block ${forkBlock}; agent = fresh key-signing EOA ${AGENT.address}`);
  stop();
}

main().catch((err) => {
  console.error(`\nmm-cycle FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
