import type { Address } from "viem";
import raw from "../deployment.json";
import { computeIsDeployed, ZERO_ADDRESS } from "./isDeployed";

export { ZERO_ADDRESS };

export interface Deployment {
  chainId: number;
  oracle: Address;
  pool: Address;
  token: Address;
  currency: Address;
  seriesIds: number[];
}

export const deployment: Deployment = {
  chainId: raw.chainId,
  oracle: raw.oracle as Address,
  pool: raw.pool as Address,
  token: raw.token as Address,
  currency: raw.currency as Address,
  seriesIds: raw.seriesIds,
};

/** True once real contract addresses have been written by the deploy tooling
 * (see isDeployed.ts for the full rules, incl. the wrong-chain kill-switch). */
export const isDeployed = computeIsDeployed(deployment, {
  prod: import.meta.env.PROD,
  allowTestChain: import.meta.env.VITE_ALLOW_TEST_CHAIN === "1",
});
