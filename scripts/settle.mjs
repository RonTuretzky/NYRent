#!/usr/bin/env node
/**
 * settle.mjs — submit an authentic CRE Daily .eml to the oracle, then settle a series.
 *
 * Usage:
 *   node scripts/settle.mjs [--eml path/to/email.eml] [--series <id>]
 *
 * Env: DEPLOYER_PRIVATE_KEY, GNOSIS_RPC_URL (dotenv-loaded from .env if present).
 * Reads web/src/deployment.json for addresses. Idempotent: skips submitObservation
 * if the emailId is already recorded, skips settle if the series is settled.
 */
import {
  emailkit,
  FIXTURE_EML,
  ORACLE_ABI,
  POOL_ABI,
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
  xdai,
} from "./_lib.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : dflt;
}
const emlPath = arg("--eml", FIXTURE_EML);

const { publicClient, walletClient, account } = makeClients();
const dep = readDeployment();
const seriesId = BigInt(arg("--series", (dep.seriesIds ?? [0])[0]));

console.log(`settle.mjs — oracle ${dep.oracle}, pool ${dep.pool}, series ${seriesId}, account ${account.address}`);

step("Parse + preflight the .eml locally");
const report = await parseAndPreflight(emailkit, emlPath);
const p = report.parsed;

step("Check whether this email is already recorded on-chain");
const count = await publicClient.readContract({ address: dep.oracle, abi: ORACLE_ABI, functionName: "observationCount" });
info(`oracle has ${count} observation(s)`);
let obsIndex = -1n;
for (let i = 0n; i < count; i++) {
  const [t, cents, emailId] = await publicClient.readContract({
    address: dep.oracle, abi: ORACLE_ABI, functionName: "observations", args: [i],
  });
  if (emailId.toLowerCase() === p.emailId.toLowerCase()) {
    obsIndex = i;
    info(`found at index ${i}: t=${t} cents=${cents}`);
    break;
  }
}

if (obsIndex !== -1n) {
  skipped(`submitObservation — emailId ${p.emailId} already recorded at index ${obsIndex}`);
} else {
  step("submitObservation(signedHeaders, canonBody, sig)");
  try {
    const { request } = await publicClient.simulateContract({
      address: dep.oracle,
      abi: ORACLE_ABI,
      functionName: "submitObservation",
      args: [toHex(p.signedHeaders), toHex(p.canonBody), toHex(p.sig)],
      account,
    });
    await sendTx(publicClient, walletClient, request, "submitObservation");
  } catch (err) {
    die(`submitObservation failed: ${explainRevert(err)}`);
  }
  const newCount = await publicClient.readContract({ address: dep.oracle, abi: ORACLE_ABI, functionName: "observationCount" });
  obsIndex = newCount - 1n;
  const [t, cents] = await publicClient.readContract({
    address: dep.oracle, abi: ORACLE_ABI, functionName: "observations", args: [obsIndex],
  });
  ok(`recorded at index ${obsIndex}: t=${t}, cents=${cents}, emailId=${p.emailId}`);
}

step("Settle the series");
const s = await publicClient.readContract({ address: dep.pool, abi: POOL_ABI, functionName: "series", args: [seriesId] });
// series() returns the Series struct — viem decodes it as a named object
const {strikeLowCents: lowC, strikeHighCents: highC, obsStart, obsEnd, settled, payoutRatioWad: ratioWad} = s;
if (settled) {
  skipped(`settle — series ${seriesId} already settled with payoutRatioWad=${ratioWad}`);
} else {
  const [obsT] = await publicClient.readContract({
    address: dep.oracle, abi: ORACLE_ABI, functionName: "observations", args: [obsIndex],
  });
  info(`observation t=${obsT}; series window [${obsStart}, ${obsEnd}], strikes ${lowC}/${highC} cents`);
  if (obsT < obsStart || obsT > obsEnd) {
    die(`observation timestamp ${obsT} is outside the series observation window [${obsStart}, ${obsEnd}]`);
  }
  try {
    const { request } = await publicClient.simulateContract({
      address: dep.pool, abi: POOL_ABI, functionName: "settle", args: [seriesId, obsIndex], account,
    });
    await sendTx(publicClient, walletClient, request, `settle(${seriesId}, ${obsIndex})`);
  } catch (err) {
    die(`settle failed: ${explainRevert(err)}`);
  }
  const after = await publicClient.readContract({ address: dep.pool, abi: POOL_ABI, functionName: "series", args: [seriesId] });
  ok(
    `series ${seriesId} settled: payoutRatioWad=${after.payoutRatioWad} (=${((Number(after.payoutRatioWad) / 1e18) * 100).toFixed(2)}% of max claim)`,
  );
}

const bal = await publicClient.getBalance({ address: account.address });
console.log(`\nDone. Account balance: ${xdai(bal)}`);
