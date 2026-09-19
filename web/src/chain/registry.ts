/**
 * Multi-chain deployment registry + active-deployment context (SHARED
 * CONTRACT). Production deployments are baked from deployments.json (keyed by
 * chainId); the anvil e2e path keeps writing the legacy-shaped
 * src/deployment.json, which is merged in as the test-chain entry whenever it
 * points at a non-production chain (guarded by VITE_ALLOW_TEST_CHAIN for prod
 * builds, mirroring the old isDeployed kill-switch).
 *
 * Pages and components never pass chainIds around: they call
 * `useActiveDeployment()` and read everything (addresses, currency decimals,
 * explorer base) from the active deployment.
 *
 * The pure merge/resolution logic lives in ./registryCore.ts (no JSON or
 * import.meta.env) so src/lib/registry.test.ts can drive the full matrix
 * under `node --test`.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAccount } from "wagmi";
import productionRaw from "./deployments.json";
import legacyRaw from "../deployment.json";
import {
  buildDeployments,
  computeDefaultChainId,
  isLiveDeployment,
  legacyToTestDeployment,
  resolveActiveChainId,
  PRODUCTION_CHAIN_IDS,
  type AppDeployment,
  type DeploymentCurrency,
  type RawDeployment,
} from "./registryCore";

export { isLiveDeployment, resolveActiveChainId, PRODUCTION_CHAIN_IDS };
export type { AppDeployment, DeploymentCurrency };

/** The legacy-shaped deployment.json (flat currency address, no names) as a
 * test-chain AppDeployment — or undefined when it points at a production
 * chain (a stale mainnet file: production reads come from deployments.json). */
export const TEST_DEPLOYMENT: AppDeployment | undefined =
  legacyToTestDeployment(legacyRaw);

const allowTestChain =
  import.meta.env.VITE_ALLOW_TEST_CHAIN === "1" || !import.meta.env.PROD;

export const DEPLOYMENTS: Record<number, AppDeployment> = buildDeployments(
  productionRaw as Record<string, RawDeployment>,
  TEST_DEPLOYMENT,
  allowTestChain,
);

/** A test build (VITE_ALLOW_TEST_CHAIN against anvil) defaults to its local
 * chain; production builds default to Polygon. */
export const DEFAULT_CHAIN_ID = computeDefaultChainId(
  DEPLOYMENTS,
  TEST_DEPLOYMENT,
);

export interface ActiveDeploymentValue {
  deployment: AppDeployment;
  chainId: number;
  setChainId: (chainId: number) => void;
}

const ActiveDeploymentContext = createContext<
  ActiveDeploymentValue | undefined
>(undefined);

const STORAGE_KEY = "rentsafe.chainId";

function readStoredChainId(): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const id = Number(raw);
    return DEPLOYMENTS[id] ? id : undefined;
  } catch {
    return undefined;
  }
}

export function ActiveDeploymentProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { chainId: walletChainId } = useAccount();
  const [stored] = useState<number | undefined>(readStoredChainId);
  const [explicit, setExplicit] = useState<boolean>(stored !== undefined);
  const [chainId, setChainIdState] = useState<number>(() =>
    resolveActiveChainId(stored, undefined, DEPLOYMENTS, DEFAULT_CHAIN_ID),
  );

  // Until the user explicitly picks a chain, follow the wallet whenever it
  // sits on a chain we have a deployment for.
  useEffect(() => {
    if (explicit) return;
    if (walletChainId === undefined) return;
    if (!DEPLOYMENTS[walletChainId]) return;
    setChainIdState(walletChainId);
  }, [explicit, walletChainId]);

  const setChainId = useCallback((next: number) => {
    if (!DEPLOYMENTS[next]) return;
    setExplicit(true);
    setChainIdState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* private mode etc. — the choice just won't persist */
    }
  }, []);

  const deployment = DEPLOYMENTS[chainId] ?? DEPLOYMENTS[DEFAULT_CHAIN_ID];

  const value = useMemo<ActiveDeploymentValue>(
    () => ({ deployment, chainId: deployment.chainId, setChainId }),
    [deployment, setChainId],
  );

  return createElement(
    ActiveDeploymentContext.Provider,
    { value },
    children,
  );
}

export function useActiveDeployment(): ActiveDeploymentValue {
  const value = useContext(ActiveDeploymentContext);
  if (value) return value;
  // Defensive fallback (unit renders outside the provider): the default
  // deployment, with a no-op setter.
  return {
    deployment: DEPLOYMENTS[DEFAULT_CHAIN_ID],
    chainId: DEFAULT_CHAIN_ID,
    setChainId: () => {},
  };
}
