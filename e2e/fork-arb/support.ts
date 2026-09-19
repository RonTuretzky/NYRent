// Shared constants + helpers for the Arbitrum One mainnet-fork suite.
// Everything runs against anvil's fork on 127.0.0.1:8550 (chainId 42161); the
// ONLY remote traffic is anvil lazily fetching forked state from the upstream
// RPC (plus read-only public-RPC calls while the app still sits on its Gnosis
// default, before the spec drives the header chain switch).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

export const FORK_PORT = 8550;
export const FORK_RPC_URL = `http://127.0.0.1:${FORK_PORT}`;
export const FORK_PREVIEW_PORT = 5176;
export const FORK_PREVIEW_URL = `http://127.0.0.1:${FORK_PREVIEW_PORT}`;
/** Upstream Arbitrum RPC the fork reads untouched state from (overridable). */
export const UPSTREAM_RPC_URL =
  process.env.ARBITRUM_FORK_URL ?? "https://arb1.arbitrum.io/rpc";

// ── Real Arbitrum One addresses (cast-verified against arb1.arbitrum.io/rpc,
//    2026-09-19) — the permissionless deployment of deployments.json. ────────
export const ORACLE = "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3" as const;
export const POOL = "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c" as const;
export const COVER_TOKEN = "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E" as const;
export const ROUTER = "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F" as const;
/** Native (Circle-issued) USDC — the pool currency, 6 decimals. */
export const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
export const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
/** WETH/USDC 0.05% Uniswap v3 pool — the native-ETH route (~$20.8M USDC). */
export const UNI_WETH_USDC_POOL =
  "0xC6962004f452bE9203591991D15f6b388e09E8D0" as const;
/** Hyperliquid bridge (~$599M USDC on 2026-09-19) — impersonated as the USDC
 * faucet for the creator's escrow. NOT a Uniswap pool: the WETH/USDC route
 * pool's state stays exactly mainnet's. */
export const USDC_WHALE =
  "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" as const;

/**
 * Test buyer and series creator: FRESH code-less addresses on Arbitrum
 * (re-verified by the setup), driven via anvil's --auto-impersonate +
 * anvil_setBalance — NEVER anvil's well-known dev keys (their public keys
 * carry EIP-7702 sweeper delegations on real chains, which break the
 * ERC-1155 mint acceptance check).
 */
export const BUYER = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0233" as const;
export const CREATOR = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0232" as const;

export const poolAbi = parseAbi([
  "function seriesCount() view returns (uint256)",
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
export const coverTokenAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
export const uniPoolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
]);

export const forkClient = createPublicClient({
  chain: arbitrum,
  transport: http(FORK_RPC_URL),
});

let rpcId = 0;
export async function rpc<T>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const res = await fetch(FORK_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** eth_sendTransaction on the fork (anvil signs for impersonated accounts)
 * and wait until the receipt reports success. */
export async function sendTx(tx: {
  from: `0x${string}`;
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: bigint;
}): Promise<void> {
  const hash = await rpc<`0x${string}`>("eth_sendTransaction", [
    {
      from: tx.from,
      to: tx.to,
      data: tx.data ?? "0x",
      ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
    },
  ]);
  const receipt = await forkClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`fork tx ${hash} reverted (to ${tx.to})`);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const ART_DIR = path.join(HERE, ".artifacts");
export const STATE_PATH = path.join(ART_DIR, "state.json");
export const PIDS_PATH = path.join(ART_DIR, "pids.json");
export const DEPLOYMENT_PATH = path.join(REPO_ROOT, "web/src/deployment.json");
export const DEPLOYMENT_BAK = path.join(ART_DIR, "deployment.json.bak");

export interface ForkState {
  /** id of the series created with an open sale window on the forked pool */
  seriesId: number;
}
export const readState = (): ForkState =>
  JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));

/**
 * Install the same EIP-1193/6963 shim as the local suite, pointed at the
 * Arbitrum fork but with the WALLET sitting on Gnosis (0x64) initially: the
 * spec drives the header chain switcher, which flips both the app context and
 * the wallet (wallet_switchEthereumChain) to Arbitrum.
 */
export async function installArbWallet(page: Page): Promise<void> {
  const cfg = {
    rpcUrl: FORK_RPC_URL,
    chainIdHex: "0x64",
    accounts: [BUYER],
    accountIndex: 0,
  };
  await page.addInitScript((c) => {
    (window as unknown as { __E2E_WALLET_CONFIG: unknown }).__E2E_WALLET_CONFIG =
      c;
  }, cfg);
  await page.addInitScript({
    path: path.join(HERE, "..", "support", "wallet-shim.js"),
  });
}
