import type { Address } from "viem";
import { POOL_RULES, type PoolRules, type PoolVersion } from "../lib/policy";
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

/** The residential policy pools live on one chain only. */
export const APARTMENTS_CHAIN_ID: number = NETWORK.chainId;
/** The oracle both pools read: one recorded rent per page and month. */
export const APARTMENTS_ORACLE = deployed.oracle as Address | null;

/** One policy pool: its contracts and the rules its policies follow. */
export interface PolicyPool {
  version: PoolVersion;
  address: Address;
  /** The ERC-1155 claim token for this pool's policies. */
  token: Address;
  rules: PoolRules;
}

function pool(version: PoolVersion, entry: { pool?: string | null; token?: string | null } | undefined): PolicyPool | null {
  if (!entry?.pool || !entry.token) return null;
  return { version, address: entry.pool as Address, token: entry.token as Address, rules: POOL_RULES[version] };
}

/** V2 takes every new policy; V1 holds the policies created before it. */
export const POOL_V2 = pool("v2", deployed.v2);
export const POOL_V1 = pool("v1", deployed.v1);
/** Every live pool, newest rules first. */
export const POOLS: PolicyPool[] = [POOL_V2, POOL_V1].filter((p): p is PolicyPool => p !== null);
export const poolFor = (version: PoolVersion): PolicyPool | null => (version === "v1" ? POOL_V1 : POOL_V2);

/**
 * Both pools share one ABI: V2's is V1's plus the RentAlreadyRecorded error
 * (src/lib/abi.test.ts pins that), so calls and event decoding use it for both.
 */
export { apartmentsPoolV2Abi as policyPoolAbi } from "./apartmentsV2Abi";
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
