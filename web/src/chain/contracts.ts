/**
 * Single point of contact with the generated ABI module (web/src/lib/abi.ts,
 * regenerated from `forge inspect` via scripts/gen-abi.mjs). The ABIs are
 * `as const` JSON — already fully typed for viem/wagmi, no parseAbi needed.
 */
import type { Abi } from "viem";
import {
  oracleAbi,
  poolAbi,
  coverTokenAbi as tokenAbi,
  erc20Abi,
} from "../lib/abi.ts";

export { oracleAbi, poolAbi, tokenAbi, erc20Abi };

/** Combined ABI for decoding custom errors from any of our contracts. */
export const allAbis: Abi = [
  ...oracleAbi,
  ...poolAbi,
  ...tokenAbi,
] as Abi;
