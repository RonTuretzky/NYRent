import type { Address } from "viem";
import raw from "../deployment.json";

export interface Deployment {
  chainId: number;
  oracle: Address;
  pool: Address;
  token: Address;
  currency: Address;
  seriesIds: number[];
}

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

export const deployment: Deployment = {
  chainId: raw.chainId,
  oracle: raw.oracle as Address,
  pool: raw.pool as Address,
  token: raw.token as Address,
  currency: raw.currency as Address,
  seriesIds: raw.seriesIds,
};

/** True once real contract addresses have been written by the deploy tooling. */
export const isDeployed =
  deployment.oracle !== ZERO_ADDRESS &&
  deployment.pool !== ZERO_ADDRESS &&
  deployment.token !== ZERO_ADDRESS &&
  deployment.currency !== ZERO_ADDRESS &&
  // A production build must never point at a non-Gnosis deployment (e.g. a
  // leftover e2e deployment.json written for a local anvil chain). The e2e
  // stack builds in production mode against anvil on purpose and declares it.
  (!import.meta.env.PROD || deployment.chainId === 100 || import.meta.env.VITE_ALLOW_TEST_CHAIN === "1");
