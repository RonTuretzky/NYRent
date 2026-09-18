#!/usr/bin/env node
/**
 * e2e-mainnet.mjs — full lifecycle against the live Gnosis deployment (SPEC §8):
 *
 *   fund (0.002 WXDAI) → quote → buy (0.001 max-claim) → submitObservation(real .eml)
 *   → settle → redeem → final accounting table
 *
 * Idempotent: every step checks on-chain state first and SKIPs work already done,
 * so the script can be re-run after any partial failure.
 *
 * Flags:
 *   --dry-run        estimate gas only (no transactions), print total xDAI cost
 *   --eml <path>     email to submit (default: the verified fixture)
 *   --series <id>    series id (default: deployment.seriesIds[0])
 *
 * Env: DEPLOYER_PRIVATE_KEY, GNOSIS_RPC_URL (.env auto-loaded). Addresses from
 * web/src/deployment.json.
 */
import { parseEther, formatEther } from "viem";
import {
  emailkit,
  FIXTURE_EML,
  ORACLE_ABI,
  POOL_ABI,
  TOKEN_ABI,
  ERC20_ABI,
  makeClients,
  readDeployment,
  parseAndPreflight,
  step,
  info,
  ok,
  skipped,
  die,
  toHex,
  explainRevert,
  sendTx,
  printTable,
  xdai,
  wxdai,
} from "./_lib.mjs";

// SPEC §8 amounts scaled to the deployer's actual balance (~0.001 xDAI):
// fund 0.0004 WXDAI, buy 0.0002 max-claim (premium 0.000057). Override per run:
//   node scripts/e2e-mainnet.mjs --fund 0.0004 --claim 0.0002
const FUND_AMOUNT = parseEther(
  (() => { const i = process.argv.indexOf("--fund"); return i !== -1 ? process.argv[i + 1] : "0.0004"; })(),
);
const MAX_CLAIM = parseEther(
  (() => { const i = process.argv.indexOf("--claim"); return i !== -1 ? process.argv[i + 1] : "0.0002"; })(),
);

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
}
const dryRun = process.argv.includes("--dry-run");
const emlPath = arg("--eml", FIXTURE_EML);

const { publicClient, walletClient, account } = makeClients();
const dep = readDeployment();
const seriesId = BigInt(arg("--series", (dep.seriesIds ?? [0])[0]));

console.log(`e2e-mainnet${dryRun ? " (DRY RUN — gas estimation only, no transactions)" : ""}`);
console.log(`  account:  ${account.address}`);
console.log(`  oracle:   ${dep.oracle}`);
console.log(`  pool:     ${dep.pool}`);
console.log(`  token:    ${dep.token}`);
console.log(`  currency: ${dep.currency}`);
console.log(`  series:   ${seriesId}`);

const readPool = (functionName, args = []) =>
  publicClient.readContract({ address: dep.pool, abi: POOL_ABI, functionName, args });
const readOracle = (functionName, args = []) =>
  publicClient.readContract({ address: dep.oracle, abi: ORACLE_ABI, functionName, args });
const readCur = (functionName, args = []) =>
  publicClient.readContract({ address: dep.currency, abi: ERC20_ABI, functionName, args });

// ---------------------------------------------------------------------------
step("Read on-chain state");
// ---------------------------------------------------------------------------
const xdaiBefore = await publicClient.getBalance({ address: account.address });
const wxdaiBefore = await readCur("balanceOf", [account.address]);
const symbol = await readCur("symbol").catch(() => "WXDAI");
if (symbol !== "WXDAI") info(`NOTE: currency symbol() = ${symbol} (expected WXDAI)`);
const poolBal0 = await readCur("balanceOf", [dep.pool]);
const series = await readPool("series", [seriesId]);
// series() returns the Series struct — viem decodes it as a named object
const {
  strikeLowCents: lowC,
  strikeHighCents: highC,
  premiumRateBps,
  saleEnd,
  obsStart,
  obsEnd,
  redeemEnd,
  capacity,
  sold,
  settled,
} = series;
const tokenBal0 = await publicClient.readContract({
  address: dep.token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account.address, seriesId],
});
info(`balances: ${xdai(xdaiBefore)}, ${wxdai(wxdaiBefore)}; pool holds ${wxdai(poolBal0)}`);
info(`series: strikes ${lowC}/${highC} cents, premium ${premiumRateBps} bps, capacity ${formatEther(capacity)}, sold ${formatEther(sold)}, settled=${settled}`);
info(`windows: saleEnd=${saleEnd} obs=[${obsStart}, ${obsEnd}] redeemEnd=${redeemEnd}`);
info(`cover token balance: ${formatEther(tokenBal0)} claim units`);

// ---------------------------------------------------------------------------
step("Parse + preflight the settlement email (local, free)");
// ---------------------------------------------------------------------------
const report = await parseAndPreflight(emailkit, emlPath);
const eml = report.parsed;

const obsCount = await readOracle("observationCount");
let obsIndex = -1n;
for (let i = 0n; i < obsCount; i++) {
  const [, , emailId] = await readOracle("observations", [i]);
  if (emailId.toLowerCase() === eml.emailId.toLowerCase()) { obsIndex = i; break; }
}
info(obsIndex !== -1n ? `email already recorded at observation index ${obsIndex}` : "email not yet recorded on-chain");

// ---------------------------------------------------------------------------
step("Quote");
// ---------------------------------------------------------------------------
let premium;
try {
  // quote() returns (premium, rateBps, capacityLeft, issuableNow)
  [premium] = await readPool("quote", [seriesId, MAX_CLAIM]);
  info(`quote(): premium for ${wxdai(MAX_CLAIM)} max-claim = ${wxdai(premium)}`);
} catch {
  premium = (MAX_CLAIM * BigInt(premiumRateBps)) / 10000n;
  info(`quote() view unavailable/mismatched — computed from premiumRateBps: ${wxdai(premium)}`);
}

// ---------------------------------------------------------------------------
// Plan the remaining steps (each idempotent)
// ---------------------------------------------------------------------------
const needBuy = tokenBal0 < MAX_CLAIM && !settled;
// fund only while the buy is still pending — after settlement/redemption the pool
// balance legitimately sits below FUND_AMOUNT and must not trigger a re-fund
const needFund = needBuy && poolBal0 < FUND_AMOUNT;
const alreadyRedeemed = settled && tokenBal0 === 0n;
const needSubmit = obsIndex === -1n && !settled;
const needSettle = !settled;
const currencyOut = (needFund ? FUND_AMOUNT : 0n) + (needBuy ? premium : 0n);
const needWrap = currencyOut > wxdaiBefore ? currencyOut - wxdaiBefore : 0n;
const allowance = await readCur("allowance", [account.address, dep.pool]);
const needApprove = currencyOut > 0n && allowance < currencyOut;

const submitArgs = [toHex(eml.signedHeaders), toHex(eml.canonBody), toHex(eml.sig)];
const plan = [
  {
    name: `wrap ${formatEther(needWrap)} xDAI -> WXDAI (deposit)`,
    needed: needWrap > 0n,
    skipMsg: "wrap — wallet already holds enough WXDAI",
    fallbackGas: 45000n,
    req: { address: dep.currency, abi: ERC20_ABI, functionName: "deposit", args: [], value: needWrap, account },
  },
  {
    name: `approve pool for ${wxdai(currencyOut)}`,
    needed: needApprove,
    skipMsg: "approve — existing allowance suffices",
    fallbackGas: 55000n,
    req: { address: dep.currency, abi: ERC20_ABI, functionName: "approve", args: [dep.pool, currencyOut], account },
  },
  {
    name: `fundPool(${formatEther(FUND_AMOUNT)})`,
    needed: needFund,
    skipMsg: needBuy
      ? `fundPool — pool already holds ${wxdai(poolBal0)} >= ${wxdai(FUND_AMOUNT)}`
      : "fundPool — buy already complete, no funding needed",
    fallbackGas: 90000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "fundPool", args: [FUND_AMOUNT], account },
  },
  {
    name: `buyProtection(${seriesId}, ${formatEther(MAX_CLAIM)}, maxPremium=${formatEther(premium)})`,
    needed: needBuy,
    skipMsg: settled
      ? "buyProtection — series already settled"
      : `buyProtection — already hold ${formatEther(tokenBal0)} claim units`,
    fallbackGas: 160000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "buyProtection", args: [seriesId, MAX_CLAIM, premium], account },
  },
  {
    name: `submitObservation(.eml: ${eml.signedHeaders.length}B headers + ${eml.canonBody.length}B body + sig)`,
    needed: needSubmit,
    skipMsg: settled ? "submitObservation — series already settled" : `submitObservation — emailId recorded at index ${obsIndex}`,
    fallbackGas: 5500000n, // SPEC §1 upper band for the 102 KB email
    req: { address: dep.oracle, abi: ORACLE_ABI, functionName: "submitObservation", args: submitArgs, account },
  },
  {
    name: "settle(series, obsIndex)",
    needed: needSettle,
    skipMsg: `settle — already settled with payoutRatioWad=${series.payoutRatioWad}`,
    fallbackGas: 130000n,
    // obsIndex may not exist yet in dry-run; use index 0 as estimation stand-in
    req: { address: dep.pool, abi: POOL_ABI, functionName: "settle", args: [seriesId, obsIndex === -1n ? 0n : obsIndex], account },
  },
  {
    name: "redeem(series, all claim units)",
    needed: !alreadyRedeemed && (tokenBal0 > 0n || needBuy),
    skipMsg: "redeem — no claim units held and series settled (already redeemed)",
    fallbackGas: 100000n,
    // amount refined at execution time; estimation stand-in uses current balance or MAX_CLAIM
    req: { address: dep.pool, abi: POOL_ABI, functionName: "redeem", args: [seriesId, tokenBal0 > 0n ? tokenBal0 : MAX_CLAIM], account },
  },
];

// ---------------------------------------------------------------------------
if (dryRun) {
  step("DRY RUN — gas estimation");
  const gasPrice = await publicClient.getGasPrice();
  info(`current gas price: ${formatEther(gasPrice * 1000000n)} xDAI per 1M gas (${gasPrice} wei)`);
  let totalGas = 0n;
  const rows = [];
  for (const s of plan) {
    if (!s.needed) { rows.push([s.name, "SKIP (already done on-chain)"]); continue; }
    let gas;
    let how = "estimated";
    try {
      gas = await publicClient.estimateContractGas(s.req);
    } catch (err) {
      gas = s.fallbackGas;
      how = `fallback (estimation reverted: ${explainRevert(err).slice(0, 60)})`;
    }
    totalGas += gas;
    rows.push([s.name, `${gas} gas — ${how}`]);
  }
  rows.push(["TOTAL", `${totalGas} gas = ${xdai(totalGas * gasPrice)} at current gas price`]);
  printTable("Dry-run gas plan", rows);
  const shortfall = totalGas * gasPrice + needWrap > xdaiBefore ? totalGas * gasPrice + needWrap - xdaiBefore : 0n;
  console.log(
    shortfall > 0n
      ? `\nSHORTFALL: account needs ${xdai(shortfall)} more xDAI (has ${xdai(xdaiBefore)}, needs gas ${xdai(totalGas * gasPrice)} + wrap ${xdai(needWrap)}).`
      : `\nAccount balance ${xdai(xdaiBefore)} covers estimated gas ${xdai(totalGas * gasPrice)} + wrap ${xdai(needWrap)}.`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
let totalFees = 0n;
let premiumPaidThisRun = 0n;

async function run(s, label = s.name) {
  if (!s.needed) { skipped(s.skipMsg); return; }
  step(label);
  try {
    const { request } = await publicClient.simulateContract(s.req);
    const { feeWei } = await sendTx(publicClient, walletClient, request, s.name);
    totalFees += feeWei;
  } catch (err) {
    die(`${s.name} failed: ${explainRevert(err)}`);
  }
}

await run(plan[0]); // wrap
await run(plan[1]); // approve
await run(plan[2]); // fund
if (plan[3].needed) premiumPaidThisRun = premium;
await run(plan[3]); // buy

// submitObservation — refresh idempotency guard just before sending
if (plan[4].needed) {
  await run(plan[4]);
  const newCount = await readOracle("observationCount");
  obsIndex = newCount - 1n;
  const [t, cents] = await readOracle("observations", [obsIndex]);
  ok(`observation recorded: index=${obsIndex} t=${t} cents=${cents} emailId=${eml.emailId}`);
} else {
  skipped(plan[4].skipMsg);
}

// settle — needs the real obsIndex
if (plan[5].needed) {
  if (obsIndex === -1n) die("cannot settle: no recorded observation for this email");
  plan[5].req.args = [seriesId, obsIndex];
  await run(plan[5]);
} else {
  skipped(plan[5].skipMsg);
}

// redeem — refresh balance (minted by buy this run) and series ratio
const tokenBalNow = await publicClient.readContract({
  address: dep.token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account.address, seriesId],
});
if (tokenBalNow > 0n) {
  plan[6].needed = true;
  plan[6].req.args = [seriesId, tokenBalNow];
  plan[6].name = `redeem(${seriesId}, ${formatEther(tokenBalNow)})`;
  await run(plan[6]);
} else {
  skipped("redeem — no claim units held (already redeemed)");
}

// ---------------------------------------------------------------------------
step("Final accounting");
// ---------------------------------------------------------------------------
const seriesAfter = await readPool("series", [seriesId]);
const ratio = seriesAfter.payoutRatioWad;
const xdaiAfter = await publicClient.getBalance({ address: account.address });
const wxdaiAfter = await readCur("balanceOf", [account.address]);
const poolBalAfter = await readCur("balanceOf", [dep.pool]);
const freeCap = await readPool("freeCapital").catch(() => null);
const payout = (MAX_CLAIM * ratio) / 10n ** 18n;
const settledCents = await readOracle("observations", [obsIndex === -1n ? 0n : obsIndex])
  .then((o) => Number(o[1]))
  .catch(() => 0);

printTable("Lifecycle accounting (account = sponsor = buyer for the MVP demo)", [
  ["series / emailId", `${seriesId} / ${seriesAfter.emailId}`],
  ["settled value", `$${(settledCents / 100).toFixed(2)} / SF (${settledCents} cents)`],
  ["payout ratio", `${formatEther(ratio)} (clamp((cents-${lowC}) / (${highC}-${lowC})))`],
  ["max claim bought", wxdai(MAX_CLAIM)],
  [`premium (rate ${premiumRateBps} bps)`, wxdai(premium)],
  ["payout at ratio", wxdai(payout)],
  ["pool balance", `${wxdai(poolBal0)} -> ${wxdai(poolBalAfter)}`],
  ["pool freeCapital", freeCap === null ? "n/a" : wxdai(freeCap)],
  ["wallet WXDAI", `${wxdai(wxdaiBefore)} -> ${wxdai(wxdaiAfter)}`],
  ["wallet xDAI", `${xdai(xdaiBefore)} -> ${xdai(xdaiAfter)}`],
  ["gas fees this run", xdai(totalFees)],
  ["buyer net (payout - premium)", `${formatEther(payout - premium)} WXDAI`],
]);
console.log("\nE2E lifecycle complete.");
