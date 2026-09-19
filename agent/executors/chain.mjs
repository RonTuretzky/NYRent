/**
 * chain.mjs — self-contained chain constants + minimal ABIs for the agent executors.
 *
 * Deliberately vendored (NOT imported from web/src or scripts/_lib.mjs): the web app is
 * rebuilt by a concurrent workflow and the agent must never depend on it. Addresses match
 * README.md / docs/OPERATIONS.md (Gnosis chainId 100, deployed + verified 2026-09-18).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseAbi } from "viem";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CHAIN_ID = 100;
export const DEFAULT_RPC_URL = "https://rpc.gnosischain.com";
export const BLOCKSCOUT_TX = (hash) => `https://gnosis.blockscout.com/tx/${hash}`;

export const ADDRESSES = {
  pool: "0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  oracle: "0xdd45a0f7fcA25dD540625130d6c252b1880D0561",
  token: "0x48Db7336C15DC4439aE3F023e24FAA26b400CC87",
  currency: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", // WXDAI (WETH9-style, deposit() payable)
  sponsor: "0x6636A1CCBdf54485067304C1a590DE016DeaD9F0",
};

/** CoverPool — views + the four onlySponsor levers + custom errors (for revert decoding). */
export const POOL_ABI = parseAbi([
  "struct Series { uint32 strikeLowCents; uint32 strikeHighCents; uint16 premiumRateBps; uint64 saleEnd; uint64 obsStart; uint64 obsEnd; uint64 redeemEnd; uint128 capacity; uint128 sold; bool settled; uint64 payoutRatioWad; uint64 observationT; bytes32 emailId; }",
  "function seriesCount() view returns (uint256)",
  "function series(uint256 seriesId) view returns (Series)",
  "function reservedOf(uint256 seriesId) view returns (uint256)",
  "function totalReserved() view returns (uint256)",
  "function freeCapital() view returns (uint256)",
  "function salesPaused() view returns (bool)",
  "function sponsor() view returns (address)",
  "function quote(uint256 seriesId, uint256 maxClaim) view returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)",
  // onlySponsor levers
  "function fundPool(uint256 amt)",
  "function withdrawExcess(uint256 amt)",
  "function setSalesPaused(bool paused)",
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256 seriesId)",
  // errors
  "error NotSponsor()",
  "error InvalidSeries()",
  "error InvalidParams(string what)",
  "error SaleClosed()",
  "error SalesArePaused()",
  "error ZeroAmount()",
  "error CapacityExceeded()",
  "error PremiumTooHigh(uint256 premium, uint256 maxPremium)",
  "error Insolvent()",
  "error AlreadySettled()",
  "error NotSettled()",
  "error ObservationOutOfWindow(uint64 t)",
  "error RedeemWindowClosed()",
  "error InsufficientFreeCapital(uint256 requested, uint256 free)",
]);

/** WXDAI is WETH9-style: deposit() payable wraps native xDAI 1:1. */
export const WXDAI_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint256 amount)",
]);

export const ORACLE_ABI = parseAbi([
  "function observationCount() view returns (uint256)",
  "function observations(uint256 i) view returns (uint64 t, uint32 cents, bytes32 emailId)",
]);

/**
 * Load repo-root .env (gitignored) without overriding real env vars.
 * Same semantics as scripts/_lib.mjs loadEnv, duplicated to stay decoupled from web/.
 */
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

/** JSON.stringify replacer that renders bigints as decimal strings. */
export const jsonBigint = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
