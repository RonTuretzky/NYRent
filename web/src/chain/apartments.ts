import type { Address } from "viem";
import deployed from "./apartments-deployment.json";

/** The residential policy pool lives on one chain only. */
export const APARTMENTS_CHAIN_ID = deployed.chainId;
export const APARTMENTS_POOL = deployed.pool as Address | null;
export const APARTMENTS_ORACLE = deployed.oracle as Address | null;
export const APARTMENTS_TOKEN = deployed.token as Address | null;
export const WRAPPED_NATIVE: Address = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
export const CURRENCY_DECIMALS = 18;

export const wrappedNativeAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const claimTokenAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
