import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, fallback, http } from "wagmi";
import { arbitrum } from "wagmi/chains";
import type { Chain } from "viem";

// Arbitrum One is the only chain. An explicit VITE_RPC_URL (the policy e2e
// suite's anvil fork) is authoritative: it replaces the public endpoints
// outright, so a fork build can never fail over to a public RPC that has the
// same chainId but different state.
const rpcOverride: string | undefined = import.meta.env.VITE_RPC_URL || undefined;

export const appChain: Chain = rpcOverride
  ? { ...arbitrum, rpcUrls: { default: { http: [rpcOverride] } } }
  : arbitrum;

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

// Batched transport coalesces the per-block refetches from every mounted read
// hook into one JSON-RPC request; the public fallback covers a primary outage.
const transport = rpcOverride
  ? http(rpcOverride, { batch: true })
  : fallback([
      http(arbitrum.rpcUrls.default.http[0], { batch: true }),
      http("https://arbitrum-one-rpc.publicnode.com", { batch: true }),
    ]);

export const wagmiConfig = createConfig({
  chains: [appChain],
  connectors,
  pollingInterval: 4_000,
  transports: { [arbitrum.id]: transport },
});
