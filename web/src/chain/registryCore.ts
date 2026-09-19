/**
 * Pure multi-chain registry logic — no JSON imports, no import.meta.env, no
 * React — so the registry resolution matrix is unit-testable under
 * `node --test` (src/lib/registry.test.ts). chain/registry.ts wires these
 * helpers to deployments.json + the legacy deployment.json + Vite env and
 * adds the ActiveDeploymentProvider/useActiveDeployment context.
 */
// Explicit .ts extension: this module is imported by node --test (see
// src/lib/registry.test.ts), which resolves relative TS imports literally.
import type { Address } from "viem";

export const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";

export const GNOSIS_CHAIN_ID = 100;
export const ARBITRUM_CHAIN_ID = 42161;
export const POLYGON_CHAIN_ID = 137;

/** Chains served from the baked deployments.json. */
export const PRODUCTION_CHAIN_IDS: readonly number[] = [
  GNOSIS_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  POLYGON_CHAIN_ID,
];

export interface DeploymentCurrency {
  address: Address;
  symbol: string;
  decimals: number;
}

/** One chain the app can serve (SHARED CONTRACT shape — pages and hooks
 * consume this and never carry raw chainIds around). */
export interface AppDeployment {
  chainId: number;
  name: string;
  oracle: Address;
  pool: Address;
  token: Address;
  /** SwapAndBuyRouter — absent on the bare anvil test deployment. */
  router?: Address;
  currency: DeploymentCurrency;
  seriesIds: number[];
  explorerBase: string;
}

/** Shape of one entry in chain/deployments.json (keyed by chainId). */
export interface RawDeployment {
  chainId: number;
  name: string;
  oracle: string;
  pool: string;
  token: string;
  router?: string;
  currency: { address: string; symbol: string; decimals: number };
  seriesIds: number[];
  explorerBase: string;
}

/** Legacy-shaped web/src/deployment.json — still written by the anvil e2e
 * global-setup (flat currency address, no name/explorer). */
export interface LegacyDeployment {
  chainId: number;
  oracle: string;
  pool: string;
  token: string;
  currency: string;
  seriesIds: number[];
}

export function fromRaw(raw: RawDeployment): AppDeployment {
  return {
    chainId: raw.chainId,
    name: raw.name,
    oracle: raw.oracle as Address,
    pool: raw.pool as Address,
    token: raw.token as Address,
    router: raw.router as Address | undefined,
    currency: {
      address: raw.currency.address as Address,
      symbol: raw.currency.symbol,
      decimals: raw.currency.decimals,
    },
    seriesIds: raw.seriesIds,
    explorerBase: raw.explorerBase,
  };
}

/** True once the fixed-price deployment carries non-zero addresses.
 * Configured targets can remain undeployed; v4 has its own receipt-backed registry. */
export function isLiveDeployment(d: AppDeployment): boolean {
  return (
    d.oracle !== ZERO_ADDRESS &&
    d.pool !== ZERO_ADDRESS &&
    d.token !== ZERO_ADDRESS &&
    d.currency.address !== ZERO_ADDRESS
  );
}

/**
 * The legacy-shaped deployment.json as a test-chain AppDeployment — or
 * undefined when it points at a production chain (a stale mainnet file:
 * production reads come from deployments.json; the retired sponsor-model
 * Gnosis deployment survives only as the Docs page's legacy record).
 */
export function legacyToTestDeployment(
  legacy: LegacyDeployment,
): AppDeployment | undefined {
  if (PRODUCTION_CHAIN_IDS.includes(legacy.chainId)) return undefined;
  return {
    chainId: legacy.chainId,
    name: `Local chain ${legacy.chainId}`,
    oracle: legacy.oracle as Address,
    pool: legacy.pool as Address,
    token: legacy.token as Address,
    // No router on the local test deployment: buys are currency-direct.
    currency: {
      address: legacy.currency as Address,
      // Placeholder meta — nothing reads the real symbol/decimals from the
      // chain anymore; this IS what renders on the test chain (valid because
      // the anvil e2e currency is a WETH9-style 18-dec token).
      symbol: "WXDAI",
      decimals: 18,
    },
    seriesIds: legacy.seriesIds,
    // Local chains have no explorer; the helper falls back gracefully.
    explorerBase: "",
  };
}

/**
 * Merges the baked production deployments with the optional test entry.
 * The test entry is only served when the build allows test chains (dev, or
 * VITE_ALLOW_TEST_CHAIN=1 — the e2e stack's production-build escape) AND its
 * addresses are real: zero-address placeholders never produce a servable
 * deployment (the old isDeployed kill-switch, per entry now).
 */
export function buildDeployments(
  production: Record<string, RawDeployment>,
  testDeployment: AppDeployment | undefined,
  allowTestChain: boolean,
): Record<number, AppDeployment> {
  const deployments: Record<number, AppDeployment> = {};
  for (const raw of Object.values(production)) {
    deployments[raw.chainId] = fromRaw(raw);
  }
  if (testDeployment && allowTestChain && isLiveDeployment(testDeployment)) {
    deployments[testDeployment.chainId] = testDeployment;
  }
  return deployments;
}

/** A test build (anvil deployment merged in) defaults to its local chain;
 * production builds default to Gnosis. */
export function computeDefaultChainId(
  deployments: Record<number, AppDeployment>,
  testDeployment: AppDeployment | undefined,
): number {
  return testDeployment && deployments[testDeployment.chainId]
    ? testDeployment.chainId
    : GNOSIS_CHAIN_ID;
}

/**
 * Active-chain resolution matrix: an explicit persisted choice wins when it
 * still names a known deployment; otherwise the wallet's chain when IT
 * matches a known deployment; otherwise the default (test chain in e2e
 * builds, else Gnosis). Unknown/stale ids never resolve.
 */
export function resolveActiveChainId(
  storedChainId: number | null | undefined,
  walletChainId: number | undefined,
  deployments: Record<number, AppDeployment>,
  defaultChainId: number,
): number {
  if (storedChainId != null && deployments[storedChainId]) return storedChainId;
  if (walletChainId !== undefined && deployments[walletChainId]) {
    return walletChainId;
  }
  return defaultChainId;
}
