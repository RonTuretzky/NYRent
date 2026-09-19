import type { Address } from "viem";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

export interface DeployedAddresses {
  chainId: number;
  oracle: Address;
  pool: Address;
  token: Address;
  currency: Address;
}

/**
 * True once real contract addresses have been written by the deploy tooling.
 * A production build must never point at a non-Gnosis deployment (e.g. a
 * leftover e2e deployment.json written for a local anvil chain) unless the
 * build explicitly declares it via allowTestChain — the e2e stack builds in
 * production mode against anvil on purpose and declares it.
 */
export function computeIsDeployed(
  d: DeployedAddresses,
  env: { prod: boolean; allowTestChain: boolean },
): boolean {
  return (
    d.oracle !== ZERO_ADDRESS &&
    d.pool !== ZERO_ADDRESS &&
    d.token !== ZERO_ADDRESS &&
    d.currency !== ZERO_ADDRESS &&
    (!env.prod || d.chainId === 100 || env.allowTestChain)
  );
}
