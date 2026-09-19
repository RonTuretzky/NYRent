#!/usr/bin/env node
/**
 * e2e-mainnet.mjs — full Option B (permissionless, no roles) lifecycle against the
 * live Gnosis deployment:
 *
 *   createSeries (escrow 0.0004 WXDAI from the caller = creator) → quote → buy
 *   (0.0002 max-claim, premium 0.000057) → submitObservation(real .eml) → settle
 *   (only when an observation's t lies inside the series window) → redeem →
 *   withdrawResidual (creator, after redeemEnd) → final accounting table
 *
 * There is no sponsor and no fundPool: the CREATOR escrows the series capacity 1:1
 * at creation, premiums accrue to the series bucket, and whatever is left after the
 * claim window returns to the creator through withdrawResidual.
 *
 * B-INVARIANT NOTE: createSeries enforces future windows with saleEnd <= obsStart,
 * so a series created NOW can only be settled by a newsletter email whose signed t
 * lands inside its (future) observation window. The checked-in 2026-09-17 fixture
 * is recorded on the oracle for provenance, but the settle step SKIPs (not fails)
 * until a qualifying observation exists — re-run the script after the next CRE
 * Daily lands in-window to finish settle/redeem, and again after redeemEnd for the
 * residual. Every step is idempotent and re-run safe.
 *
 * Flags:
 *   --dry-run          estimate gas only (no transactions), print total xDAI cost
 *   --eml <path>       email to submit (default: the verified fixture)
 *   --series <id>      target an existing series (default: latest; creates one when none)
 *   --capacity <units> escrow for a newly created series (default 0.0004)
 *   --claim <units>    max-claim to buy (default 0.0002)
 *
 * Env: DEPLOYER_PRIVATE_KEY, GNOSIS_RPC_URL (.env auto-loaded). Addresses from
 * web/src/deployment.json.
 */
import { parseAbi, parseEther, formatEther } from "viem";
import {
  emailkit,
  FIXTURE_EML,
  ORACLE_ABI,
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

// The Option B pool surface (web/src/lib/abi.ts may still carry the legacy ABI
// until it is regenerated, so the fragments live here). The series() tuple MUST
// mirror the CoverPool.Series struct field order exactly.
const POOL_ABI = parseAbi([
  "function seriesCount() view returns (uint256)",
  "function series(uint256 seriesId) view returns ((address creator, uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, bool settled, bool cancelled, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 escrow, uint128 sold, uint128 premiumsAccrued, uint128 paidOut, uint256 withdrawn, bool residualWithdrawn, uint64 payoutRatioWad, uint64 observationT, bytes32 emailId))",
  "function quote(uint256 seriesId, uint256 maxClaim) view returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)",
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
  "function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium)",
  "function settle(uint256 seriesId, uint256 obsIndex)",
  "function redeem(uint256 seriesId, uint256 amount)",
  "function withdrawResidual(uint256 seriesId)",
]);

// New-series economics: the frozen demo strikes/rate, tiny escrow. 2850 bps of the
// 0.0002 default claim = 0.000057 WXDAI premium.
const STRIKE_LOW_CENTS = 8800;
const STRIKE_HIGH_CENTS = 9600;
const PREMIUM_RATE_BPS = 2850;
const SALE_DURATION = 36n * 3600n; // sale open for the run, closes before the window
const OBS_DURATION = 30n * 86400n;
const CLAIM_DURATION = 60n * 86400n;

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
}
const dryRun = process.argv.includes("--dry-run");
const emlPath = arg("--eml", FIXTURE_EML);
const CAPACITY = parseEther(arg("--capacity", "0.0004"));
const MAX_CLAIM = parseEther(arg("--claim", "0.0002"));

const { publicClient, walletClient, account } = makeClients();
const dep = readDeployment();

console.log(`e2e-mainnet${dryRun ? " (DRY RUN — gas estimation only, no transactions)" : ""}`);
console.log(`  account:  ${account.address} (creator AND buyer for the smoke)`);
console.log(`  oracle:   ${dep.oracle}`);
console.log(`  pool:     ${dep.pool}`);
console.log(`  token:    ${dep.token}`);
console.log(`  currency: ${dep.currency}`);

const readPool = (functionName, args = []) =>
  publicClient.readContract({ address: dep.pool, abi: POOL_ABI, functionName, args });
const readOracle = (functionName, args = []) =>
  publicClient.readContract({ address: dep.oracle, abi: ORACLE_ABI, functionName, args });
const readCur = (functionName, args = []) =>
  publicClient.readContract({ address: dep.currency, abi: ERC20_ABI, functionName, args });
const readCover = (seriesId) =>
  publicClient.readContract({
    address: dep.token, abi: TOKEN_ABI, functionName: "balanceOf", args: [account.address, seriesId],
  });

// ---------------------------------------------------------------------------
step("Read on-chain state");
// ---------------------------------------------------------------------------
const now = (await publicClient.getBlock()).timestamp;
const xdaiBefore = await publicClient.getBalance({ address: account.address });
const wxdaiBefore = await readCur("balanceOf", [account.address]);
const symbol = await readCur("symbol").catch(() => "WXDAI");
if (symbol !== "WXDAI") info(`NOTE: currency symbol() = ${symbol} (expected WXDAI)`);
const poolBal0 = await readCur("balanceOf", [dep.pool]);
const seriesCount = await readPool("seriesCount");

const seriesArg = arg("--series", null);
let seriesId;
let needCreate = false;
if (seriesArg !== null) {
  seriesId = BigInt(seriesArg);
  if (seriesId >= seriesCount) die(`--series ${seriesId} does not exist (seriesCount = ${seriesCount})`);
} else if (seriesCount > 0n) {
  seriesId = seriesCount - 1n; // latest series — re-runs keep targeting the one we created
} else {
  seriesId = seriesCount; // will be minted by createSeries below
  needCreate = true;
}

let series = needCreate ? null : await readPool("series", [seriesId]);
info(`balances: ${xdai(xdaiBefore)}, ${wxdai(wxdaiBefore)}; pool holds ${wxdai(poolBal0)}`);
info(
  needCreate
    ? `no series on-chain yet — this run creates series ${seriesId} with ${wxdai(CAPACITY)} creator escrow`
    : `series ${seriesId}/${seriesCount - 1n}: strikes ${series.strikeLowCents}/${series.strikeHighCents} cents, ` +
      `premium ${series.premiumRateBps} bps, escrow ${formatEther(series.escrow)}, sold ${formatEther(series.sold)}, ` +
      `settled=${series.settled} cancelled=${series.cancelled}`,
);
if (series) {
  info(`windows: saleEnd=${series.saleEnd} obs=[${series.obsStart}, ${series.obsEnd}] redeemEnd=${series.redeemEnd} (now=${now})`);
  info(`creator: ${series.creator}${series.creator.toLowerCase() === account.address.toLowerCase() ? " (this account)" : ""}`);
}
const tokenBal0 = needCreate ? 0n : await readCover(seriesId);
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

// Any observation whose t lies inside the series window can settle it. For a series
// created THIS run the window starts 36h from now, so nothing qualifies yet.
async function findQualifyingObservation(s) {
  const count = await readOracle("observationCount");
  for (let i = 0n; i < count; i++) {
    const [t] = await readOracle("observations", [i]);
    if (t >= s.obsStart && t <= s.obsEnd) return i;
  }
  return -1n;
}

// ---------------------------------------------------------------------------
step("Quote");
// ---------------------------------------------------------------------------
let premium;
if (needCreate) {
  premium = (MAX_CLAIM * BigInt(PREMIUM_RATE_BPS)) / 10000n;
  info(`series not created yet — premium at ${PREMIUM_RATE_BPS} bps for ${wxdai(MAX_CLAIM)} max-claim = ${wxdai(premium)}`);
} else {
  // quote() returns (premium, rateBps, capacityLeft, issuableNow)
  const [q, , capacityLeft, issuableNow] = await readPool("quote", [seriesId, MAX_CLAIM]);
  premium = q;
  info(`quote(): premium for ${wxdai(MAX_CLAIM)} max-claim = ${wxdai(premium)}; capacityLeft ${wxdai(capacityLeft)}, issuableNow ${wxdai(issuableNow)}`);
}

// ---------------------------------------------------------------------------
// Plan the remaining steps (each idempotent)
// ---------------------------------------------------------------------------
const isCreator = series ? series.creator.toLowerCase() === account.address.toLowerCase() : true;
const saleOpen = needCreate || (now <= series.saleEnd && !series.settled && !series.cancelled);
const needBuy = tokenBal0 < MAX_CLAIM && saleOpen;
const needSubmit = obsIndex === -1n;
const qualIndex = series ? await findQualifyingObservation(series) : -1n;
const needSettle = !needCreate && !series.settled && !series.cancelled && qualIndex !== -1n;
const canRedeem = !needCreate && series.settled && now <= series.redeemEnd && tokenBal0 > 0n;
const needResidual =
  !needCreate && isCreator && !series.residualWithdrawn && !series.cancelled && now > series.redeemEnd;

// Creator escrow (createSeries) + buyer premium both leave this wallet in WXDAI.
const currencyOut = (needCreate ? CAPACITY : 0n) + (needBuy ? premium : 0n);
const needWrap = currencyOut > wxdaiBefore ? currencyOut - wxdaiBefore : 0n;
const allowance = await readCur("allowance", [account.address, dep.pool]);
const needApprove = currencyOut > 0n && allowance < currencyOut;

const submitArgs = [toHex(eml.signedHeaders), toHex(eml.canonBody), toHex(eml.sig)];
const createArgs = [
  STRIKE_LOW_CENTS,
  STRIKE_HIGH_CENTS,
  PREMIUM_RATE_BPS,
  now + SALE_DURATION, // saleEnd
  now + SALE_DURATION, // obsStart (= saleEnd: the contract's informed-trading rule)
  now + SALE_DURATION + OBS_DURATION, // obsEnd
  now + SALE_DURATION + OBS_DURATION + CLAIM_DURATION, // redeemEnd
  CAPACITY,
];
const plan = [
  {
    name: `wrap ${formatEther(needWrap)} xDAI -> WXDAI (deposit)`,
    needed: needWrap > 0n,
    skipMsg: "wrap — wallet already holds enough WXDAI",
    fallbackGas: 45000n,
    req: { address: dep.currency, abi: ERC20_ABI, functionName: "deposit", args: [], value: needWrap, account },
  },
  {
    name: `approve pool for ${wxdai(currencyOut)} (escrow + premium)`,
    needed: needApprove,
    skipMsg: "approve — existing allowance suffices",
    fallbackGas: 55000n,
    req: { address: dep.currency, abi: ERC20_ABI, functionName: "approve", args: [dep.pool, currencyOut], account },
  },
  {
    name: `createSeries(${STRIKE_LOW_CENTS}/${STRIKE_HIGH_CENTS}, ${PREMIUM_RATE_BPS} bps, escrow ${formatEther(CAPACITY)})`,
    needed: needCreate,
    skipMsg: `createSeries — series ${seriesId} already exists`,
    fallbackGas: 220000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "createSeries", args: createArgs, account },
  },
  {
    name: `buyProtection(${seriesId}, ${formatEther(MAX_CLAIM)}, maxPremium=${formatEther(premium)})`,
    needed: needBuy,
    skipMsg:
      tokenBal0 >= MAX_CLAIM
        ? `buyProtection — already hold ${formatEther(tokenBal0)} claim units`
        : "buyProtection — sale closed (settled/cancelled/past saleEnd)",
    fallbackGas: 180000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "buyProtection", args: [seriesId, MAX_CLAIM, premium], account },
  },
  {
    name: `submitObservation(.eml: ${eml.signedHeaders.length}B headers + ${eml.canonBody.length}B body + sig)`,
    needed: needSubmit,
    skipMsg: `submitObservation — emailId recorded at index ${obsIndex}`,
    fallbackGas: 5500000n, // SPEC §1 upper band for the 102 KB email
    req: { address: dep.oracle, abi: ORACLE_ABI, functionName: "submitObservation", args: submitArgs, account },
  },
  {
    name: "settle(series, obsIndex)",
    needed: needSettle,
    skipMsg: !needCreate && series?.settled
      ? `settle — already settled with payoutRatioWad=${series.payoutRatioWad}`
      : "settle — no observation inside the series window yet (B invariant: freshly " +
        "created windows are in the future; re-run once a CRE Daily lands in-window)",
    fallbackGas: 130000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "settle", args: [seriesId, qualIndex === -1n ? 0n : qualIndex], account },
  },
  {
    name: "redeem(series, all claim units)",
    needed: canRedeem,
    skipMsg: "redeem — nothing redeemable (not settled, window closed, or no units held)",
    fallbackGas: 100000n,
    // amount refined at execution time; estimation stand-in uses current balance or MAX_CLAIM
    req: { address: dep.pool, abi: POOL_ABI, functionName: "redeem", args: [seriesId, tokenBal0 > 0n ? tokenBal0 : MAX_CLAIM], account },
  },
  {
    name: `withdrawResidual(${seriesId})`,
    needed: needResidual,
    skipMsg: !needCreate && series && now <= series.redeemEnd
      ? `withdrawResidual — claim window open until ${series.redeemEnd} (creator residual locked)`
      : "withdrawResidual — already withdrawn, cancelled, or not the creator",
    fallbackGas: 90000n,
    req: { address: dep.pool, abi: POOL_ABI, functionName: "withdrawResidual", args: [seriesId], account },
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
    if (!s.needed) { rows.push([s.name, `SKIP (${s.skipMsg})`]); continue; }
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

// createSeries — the creator escrows the capacity; re-read the series afterwards
if (plan[2].needed) {
  await run(plan[2]);
  const newCount = await readPool("seriesCount");
  seriesId = newCount - 1n;
  series = await readPool("series", [seriesId]);
  ok(`series ${seriesId} created: escrow ${formatEther(series.escrow)} pulled from creator, windows obs=[${series.obsStart}, ${series.obsEnd}]`);
  plan[3].req.args = [seriesId, MAX_CLAIM, premium];
} else {
  skipped(plan[2].skipMsg);
}

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

// settle — needs an observation INSIDE the series window (the fixture usually is
// not, for a series created this run; that is the B informed-trading invariant)
if (series && !series.settled && !series.cancelled) {
  const qual = await findQualifyingObservation(series);
  if (qual !== -1n) {
    plan[5].needed = true;
    plan[5].req.args = [seriesId, qual];
    await run(plan[5]);
    series = await readPool("series", [seriesId]);
  } else {
    skipped(plan[5].skipMsg);
  }
} else {
  skipped(plan[5].skipMsg);
}

// redeem — refresh balance (minted by buy this run) and series state
const tokenBalNow = await readCover(seriesId);
if (series?.settled && tokenBalNow > 0n && now <= series.redeemEnd) {
  plan[6].needed = true;
  plan[6].req.args = [seriesId, tokenBalNow];
  plan[6].name = `redeem(${seriesId}, ${formatEther(tokenBalNow)})`;
  await run(plan[6]);
} else {
  skipped(plan[6].skipMsg);
}

// withdrawResidual — creator-only sweep once the claim window has closed
await run(plan[7]);

// ---------------------------------------------------------------------------
step("Final accounting");
// ---------------------------------------------------------------------------
const seriesAfter = await readPool("series", [seriesId]);
const ratio = seriesAfter.payoutRatioWad;
const xdaiAfter = await publicClient.getBalance({ address: account.address });
const wxdaiAfter = await readCur("balanceOf", [account.address]);
const poolBalAfter = await readCur("balanceOf", [dep.pool]);
const payout = seriesAfter.settled ? (MAX_CLAIM * ratio) / 10n ** 18n : 0n;
const residualNow =
  seriesAfter.escrow + seriesAfter.premiumsAccrued - seriesAfter.paidOut - seriesAfter.withdrawn;

printTable("Lifecycle accounting (account = creator = buyer for the smoke)", [
  ["series / emailId", `${seriesId} / ${seriesAfter.emailId}`],
  ["creator", seriesAfter.creator],
  ["settled / cancelled", `${seriesAfter.settled} / ${seriesAfter.cancelled}`],
  ["payout ratio", `${formatEther(ratio)} (clamp((cents-${seriesAfter.strikeLowCents}) / (${seriesAfter.strikeHighCents}-${seriesAfter.strikeLowCents})))`],
  ["escrow (creator-funded)", wxdai(seriesAfter.escrow)],
  ["sold / max claim bought", `${wxdai(seriesAfter.sold)} / ${wxdai(MAX_CLAIM)}`],
  [`premiums accrued (rate ${seriesAfter.premiumRateBps} bps)`, wxdai(seriesAfter.premiumsAccrued)],
  ["paid out to redeemers", wxdai(seriesAfter.paidOut)],
  ["withdrawn by creator", wxdai(seriesAfter.withdrawn)],
  ["series residual (escrow+premiums-paidOut-withdrawn)", wxdai(residualNow)],
  ["payout at ratio (this claim)", wxdai(payout)],
  ["pool balance", `${wxdai(poolBal0)} -> ${wxdai(poolBalAfter)}`],
  ["wallet WXDAI", `${wxdai(wxdaiBefore)} -> ${wxdai(wxdaiAfter)}`],
  ["wallet xDAI", `${xdai(xdaiBefore)} -> ${xdai(xdaiAfter)}`],
  ["gas fees this run", xdai(totalFees)],
  ["premium paid this run", wxdai(premiumPaidThisRun)],
]);
const nowAfter = (await publicClient.getBlock()).timestamp;
console.log(
  seriesAfter.settled
    ? "\nE2E lifecycle complete."
    : nowAfter > seriesAfter.redeemEnd
      ? "\nE2E lifecycle complete — series expired UNSETTLED (fallback: holders redeem nothing, the creator residual sweeps escrow + premiums)."
      : "\nE2E run complete — series awaits a qualifying in-window observation to settle (re-run later).",
);
