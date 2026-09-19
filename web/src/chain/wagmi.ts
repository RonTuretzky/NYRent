import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, fallback, http, type Transport } from "wagmi";
import { arbitrum, gnosis, polygon } from "wagmi/chains";
import { defineChain, type Chain } from "viem";
import legacyRaw from "../deployment.json";
import { TEST_DEPLOYMENT } from "./registry";

// The app is multi-chain: Gnosis + Arbitrum + Polygon are always configured, and the
// anvil e2e deployment (legacy-shaped deployment.json pointing at a non-
// production chainId) is appended as a minimal extra chain so wagmi/
// RainbowKit still work unmodified against a local fork.
const rpcOverride: string | undefined = import.meta.env.VITE_RPC_URL;

// An explicit VITE_RPC_URL is authoritative FOR THE CHAIN deployment.json
// names: the fork suites build with chainId 100 (Gnosis fork) or a local
// anvil id, and their endpoint must never silently fail over to a public RPC
// with the same chainId but different state.
const overrideChainId: number | undefined = rpcOverride
  ? legacyRaw.chainId
  : undefined;

const gnosisChain: Chain = {
  ...gnosis,
  // Blockscout matches the app's own explorer links (chain/explorer.ts).
  blockExplorers: {
    default: { name: "Blockscout", url: "https://gnosis.blockscout.com" },
  },
  ...(overrideChainId === gnosis.id && rpcOverride
    ? { rpcUrls: { default: { http: [rpcOverride] } } }
    : {}),
};

const arbitrumChain: Chain = {
  ...arbitrum,
  ...(overrideChainId === arbitrum.id && rpcOverride
    ? { rpcUrls: { default: { http: [rpcOverride] } } }
    : {}),
};

const polygonChain: Chain = {
  ...polygon,
  ...(overrideChainId === polygon.id && rpcOverride
    ? { rpcUrls: { default: { http: [rpcOverride] } } }
    : {}),
};

const testChain: Chain | undefined = TEST_DEPLOYMENT
  ? defineChain({
      id: TEST_DEPLOYMENT.chainId,
      name: TEST_DEPLOYMENT.name,
      nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
      rpcUrls: {
        default: { http: [rpcOverride ?? "http://127.0.0.1:8547"] },
      },
    })
  : undefined;

export const appChains: readonly [Chain, ...Chain[]] = testChain
  ? [testChain, gnosisChain, arbitrumChain, polygonChain]
  : [gnosisChain, arbitrumChain, polygonChain];

/** @deprecated single-chain era export — the DEFAULT chain (test chain in
 * anvil e2e builds, else Gnosis). Multi-chain code should resolve the chain
 * from useActiveDeployment() + chainById() instead. */
export const appChain: Chain = appChains[0];

// WalletConnect-based wallets need a real Reown (WalletConnect Cloud)
// projectId; without one the app stays injected-only and makes no
// WalletConnect network calls (so no console errors from a placeholder id).
const walletConnectProjectId: string | undefined = import.meta.env
  .VITE_WALLETCONNECT_PROJECT_ID;

const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: walletConnectProjectId
        ? [injectedWallet, walletConnectWallet, coinbaseWallet, safeWallet]
        : [injectedWallet],
    },
  ],
  {
    appName: "RentSafe",
    projectId: walletConnectProjectId ?? "UNUSED_INJECTED_ONLY",
  },
);

// Batched transports coalesce the per-block refetches from every mounted read
// hook into a single JSON-RPC request per chain. Public fallbacks cover a
// primary-RPC outage — except when VITE_RPC_URL pins that chain to a fork.
const transports: Record<number, Transport> = {
  [polygon.id]:
    overrideChainId === polygon.id && rpcOverride
      ? http(rpcOverride, { batch: true })
      : fallback([
          http("https://polygon-bor-rpc.publicnode.com", { batch: true }),
          http(polygon.rpcUrls.default.http[0], { batch: true }),
        ]),
  [gnosis.id]:
    overrideChainId === gnosis.id && rpcOverride
      ? http(rpcOverride, { batch: true })
      : fallback([
          http(gnosis.rpcUrls.default.http[0], { batch: true }),
          http("https://gnosis-rpc.publicnode.com", { batch: true }),
          http("https://1rpc.io/gnosis", { batch: true }),
        ]),
  [arbitrum.id]:
    overrideChainId === arbitrum.id && rpcOverride
      ? http(rpcOverride, { batch: true })
      : fallback([
          http(arbitrum.rpcUrls.default.http[0], { batch: true }),
          http("https://arbitrum-one-rpc.publicnode.com", { batch: true }),
        ]),
};
if (testChain) {
  transports[testChain.id] = http(testChain.rpcUrls.default.http[0], {
    batch: true,
  });
}

export const wagmiConfig = createConfig({
  chains: appChains,
  connectors,
  pollingInterval: 4_000,
  transports,
});

/** The chain definition for a configured chainId (wrong-network banners,
 * RPC-outage copy). */
export function chainById(chainId: number): Chain | undefined {
  return appChains.find((c) => c.id === chainId);
}
