// Shared constants + helpers for the Gnosis mainnet-fork suite. Everything runs
// against anvil's fork on 127.0.0.1:8549 (chainId 100); the ONLY remote traffic
// is anvil lazily fetching forked state from the upstream RPC.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createPublicClient, http, parseAbi } from "viem";
import { gnosis } from "viem/chains";

export const FORK_PORT = 8549;
export const FORK_RPC_URL = `http://127.0.0.1:${FORK_PORT}`;
export const FORK_PREVIEW_PORT = 5175;
export const FORK_PREVIEW_URL = `http://127.0.0.1:${FORK_PREVIEW_PORT}`;
/** Upstream Gnosis RPC the fork reads untouched state from (overridable). */
export const UPSTREAM_RPC_URL =
  process.env.GNOSIS_FORK_URL ?? "https://rpc.gnosischain.com";

// ── Real Gnosis addresses (each cast-verified against rpc.gnosischain.com) ───
export const POOL = "0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3" as const;
export const COVER_TOKEN = "0x48Db7336C15DC4439aE3F023e24FAA26b400CC87" as const;
export const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d" as const;
export const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0" as const;
export const SPONSOR = "0x6636A1CCBdf54485067304C1a590DE016DeaD9F0" as const;
/** WXDAI/USDC.e 0.01% Uniswap v3 pool — the swap's route (~$103k depth). */
export const UNI_WXDAI_USDCE_POOL =
  "0xf5E40cC12f69121B0329c256A99F4ab3ebDfAA2E" as const;
/** GNO/USDC.e 0.30% pool (~$1.08M) — impersonated as the USDC.e faucet. The
 * WXDAI/USDC.e route pool is untouched, so swaps through it stay realistic. */
export const USDCE_WHALE =
  "0x777d8FDCe12499Ae2D66520865811eEE8c7dE679" as const;

/**
 * Test buyer: a FRESH address with no history/code on Gnosis, driven via
 * anvil's --auto-impersonate + anvil_setBalance. Anvil's well-known dev
 * accounts are unusable on a Gnosis fork: their public keys let bots install
 * EIP-7702 sweeper delegations at those addresses on the real chain (dev #0
 * carries `0xef0100…` code), so the ERC-1155 mint's onERC1155Received
 * acceptance check hits the sweeper contract and buyProtection reverts.
 */
export const BUYER = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0231" as const;

export const poolAbi = parseAbi([
  "function seriesCount() view returns (uint256)",
  "function freeCapital() view returns (uint256)",
  "function sponsor() view returns (address)",
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
  "function fundPool(uint256 amt)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function deposit() payable",
]);
export const coverTokenAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
export const uniPoolAbi = parseAbi([
  "function liquidity() view returns (uint128)",
]);

export const forkClient = createPublicClient({
  chain: gnosis,
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

/** eth_sendTransaction on the fork (anvil signs for impersonated/dev accounts)
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

export interface ForkState {
  /** id of the series created with an open sale window on the forked pool */
  seriesId: number;
}
export const readState = (): ForkState =>
  JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));

/** Install the same EIP-1193/6963 shim as the local suite, pointed at the fork
 * (chainId 100) with the dev buyer account. */
export async function installForkWallet(page: Page): Promise<void> {
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
