import type { Address } from "viem";
import deployed from "./apartments-deployment.json";

/**
 * The one network the app serves. Copy (network name, currency and gas token
 * symbols) and explorer links read from here; wagmi.ts builds its only chain
 * from the same id.
 */
export const NETWORK = {
  chainId: 42161,
  name: "Arbitrum One",
  /** The policy currency. */
  symbol: "USDC",
  /** The gas token. */
  nativeSymbol: "ETH",
  explorerBase: "https://arbiscan.io",
} as const;

/** The residential policy pool lives on one chain only. */
export const APARTMENTS_CHAIN_ID: number = NETWORK.chainId;
export const APARTMENTS_POOL = deployed.pool as Address | null;
export const APARTMENTS_ORACLE = deployed.oracle as Address | null;
export const APARTMENTS_TOKEN = deployed.token as Address | null;
export const POLICY_CURRENCY: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const CURRENCY_DECIMALS = 6;

export const policyCurrencyAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const claimTokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
