/**
 * Single point of contact with the generated ABI module (web/src/chain/abi.ts,
 * regenerated from `forge inspect` via scripts/gen-abi.mjs). The ABIs are
 * `as const` JSON — already fully typed for viem/wagmi, no parseAbi needed.
 * Both live chains (Gnosis 100, Arbitrum One 42161) run the SAME contract
 * version, so one ABI set serves every deployment in the registry.
 */
import type { Abi } from "viem";
import {
  oracleAbi,
  poolAbi,
  routerAbi,
  coverTokenAbi as tokenAbi,
  erc20Abi,
} from "./abi.ts";

export { oracleAbi, poolAbi, routerAbi, tokenAbi, erc20Abi };

/** Combined ABI for decoding custom errors from any of our contracts. */
export const allAbis: Abi = [
  ...oracleAbi,
  ...poolAbi,
  ...tokenAbi,
  ...routerAbi,
] as Abi;
