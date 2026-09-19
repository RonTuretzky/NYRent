/**
 * Shared helpers for the operator scripts (verify-eml, emlToCalldata, settle, e2e-mainnet).
 * Node >= 22 (built-in TypeScript type stripping is used to import web/src TS modules).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createPublicClient, createWalletClient, http, formatEther, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";

import { oracleAbi, poolAbi, coverTokenAbi, erc20Abi, allErrorsAbi } from "../web/src/chain/abi.ts";

export * as emailkit from "../web/src/lib/emailkit.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_EML = path.join(ROOT, "fixtures", "credaily-2026-09-17", "credaily-cpace-2026-09-17.eml");
// DEPLOYMENT_JSON env var overrides the default path (used by tests/local anvil runs)
export const DEPLOYMENT_PATH =
  process.env.DEPLOYMENT_JSON ?? path.join(ROOT, "web", "src", "deployment.json");

// abi.ts is generated JSON ABI (scripts/gen-abi.mjs) — usable by viem directly.
export const ORACLE_ABI = oracleAbi;
export const POOL_ABI = poolAbi;
export const TOKEN_ABI = coverTokenAbi;
export const ERC20_ABI = erc20Abi;
export const ERRORS_ABI = allErrorsAbi;

// ---------------------------------------------------------------------------
// env (.env at repo root, if present; never required — real env wins)
// ---------------------------------------------------------------------------

export function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`missing env var ${name} (set it in the environment or in ${path.join(ROOT, ".env")})`);
  return v;
}

// ---------------------------------------------------------------------------
// deployment.json + clients
// ---------------------------------------------------------------------------

export function readDeployment() {
  if (!existsSync(DEPLOYMENT_PATH)) {
    die(
      `web/src/deployment.json not found — run the deploy tooling first (script/Deploy.s.sol writes it).\n  expected at: ${DEPLOYMENT_PATH}`,
    );
  }
  const d = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
  for (const k of ["chainId", "oracle", "pool", "token", "currency"]) {
    if (!(k in d)) die(`deployment.json missing key "${k}"`);
    if (typeof d[k] === "string" && /^0x0{40}$/i.test(d[k])) {
      die(`deployment.json has placeholder zero address for "${k}" — run the deploy first (SPEC §8)`);
    }
  }
  if (Number(d.chainId) !== gnosis.id) die(`deployment.json chainId ${d.chainId} != gnosis (${gnosis.id})`);
  return d;
}

export function makeClients({ needKey = true } = {}) {
  loadEnv();
  const rpcUrl = requireEnv("GNOSIS_RPC_URL");
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: gnosis, transport });
  let account = null;
  let walletClient = null;
  if (needKey) {
    let pk = requireEnv("DEPLOYER_PRIVATE_KEY");
    if (!pk.startsWith("0x")) pk = "0x" + pk;
    account = privateKeyToAccount(pk);
    walletClient = createWalletClient({ chain: gnosis, transport, account });
  }
  return { publicClient, walletClient, account, rpcUrl };
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

export function die(msg, code = 1) {
  console.error(`\nERROR: ${msg}`);
  process.exit(code);
}

let stepNo = 0;
export function step(title) {
  stepNo++;
  console.log(`\n[${stepNo}] ${title}`);
}
export const info = (msg) => console.log(`    ${msg}`);
export const ok = (msg) => console.log(`    OK  ${msg}`);
export const skipped = (msg) => console.log(`    SKIP ${msg} (already done on-chain)`);

export const xdai = (wei) => `${formatEther(wei)} xDAI`;
export const wxdai = (wei) => `${formatEther(wei)} WXDAI`;

export function printChecklist(report) {
  console.log("\n  Preflight checklist:");
  for (const c of report.checks) {
    console.log(`    [${c.pass ? "PASS" : "FAIL"}] ${c.id.padEnd(12)} ${c.label}`);
    console.log(`           ${c.detail}`);
  }
  console.log(`  => ${report.ok ? "ALL CHECKS PASS" : "PREFLIGHT FAILED"}`);
}

export function printTable(title, rows) {
  // rows: array of [label, value]
  const w = Math.max(...rows.map(([l]) => l.length));
  console.log(`\n  ${title}`);
  console.log("  " + "-".repeat(w + 40));
  for (const [l, v] of rows) console.log(`  ${l.padEnd(w)}  ${v}`);
  console.log("  " + "-".repeat(w + 40));
}

/** Try to decode a revert into a named custom error from our ABIs. */
export function explainRevert(err) {
  const data =
    err?.cause?.data ?? err?.data ?? (typeof err?.cause?.cause?.data === "string" ? err.cause.cause.data : undefined);
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ abi: ERRORS_ABI, data });
      return `custom error ${decoded.errorName}(${(decoded.args ?? []).join(", ")})`;
    } catch {
      /* not one of ours */
    }
  }
  return err?.shortMessage ?? err?.message ?? String(err);
}

/** Write + wait, with progress lines. Returns { receipt, feeWei }. */
export async function sendTx(publicClient, walletClient, request, label) {
  info(`sending tx: ${label} ...`);
  const hash = await walletClient.writeContract(request);
  info(`tx ${hash} — waiting for confirmation`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") die(`${label} reverted (tx ${hash})`);
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  ok(`${label}: gasUsed=${receipt.gasUsed} fee=${xdai(feeWei)} block=${receipt.blockNumber}`);
  return { receipt, feeWei };
}

/** Parse a verified .eml into the on-chain byte triplet, printing the checklist. */
export async function parseAndPreflight(emailkitMod, emlPath, { allowFail = false } = {}) {
  const raw = new Uint8Array(readFileSync(emlPath));
  info(`read ${emlPath} (${raw.length} bytes)`);
  const report = await emailkitMod.preflight(raw);
  printChecklist(report);
  if (!report.ok && !allowFail) die("preflight failed — refusing to touch the chain with a bad email");
  return report;
}

export const toHex = (u8) => "0x" + Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
