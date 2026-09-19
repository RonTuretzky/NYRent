import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, fallback, http } from "wagmi";
import { gnosis } from "wagmi/chains";
import { defineChain, type Chain } from "viem";
import { deployment } from "./deployment";
import { EXPLORER } from "./explorer";

// The app always targets deployment.json's chainId. Gnosis (100) is the
// production chain; anything else (e.g. a local anvil during e2e) gets a
// minimal chain definition so wagmi/RainbowKit still work unmodified.
const rpcOverride: string | undefined = import.meta.env.VITE_RPC_URL;

// Blockscout is the single explorer source (chain/explorer.ts) so viem-derived
// links match the app's own explorer links.
const blockExplorers = {
  default: { name: "Blockscout", url: EXPLORER },
} as const;

export const appChain: Chain =
  deployment.chainId === gnosis.id
    ? {
        ...gnosis,
        blockExplorers,
        ...(rpcOverride
          ? { rpcUrls: { default: { http: [rpcOverride] } } }
          : {}),
      }
    : defineChain({
        id: deployment.chainId,
        name: `Local chain ${deployment.chainId}`,
        nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
        rpcUrls: {
          default: { http: [rpcOverride ?? "http://127.0.0.1:8547"] },
        },
      });

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
    appName: "NY Rent Cover",
    projectId: walletConnectProjectId ?? "UNUSED_INJECTED_ONLY",
  },
);

// Batched transports coalesce the per-block refetches from every mounted read
// hook into a single JSON-RPC request. On Gnosis, two public fallbacks cover a
// primary-RPC outage; reads keep working even when rpc.gnosischain.com is down.
// An explicit VITE_RPC_URL is authoritative: no public fallbacks are appended,
// so a fork/private endpoint can never silently fail over to real Gnosis
// (same chainId, different state) mid-suite or mid-session.
const transport =
  deployment.chainId === gnosis.id && !rpcOverride
    ? fallback([
        http(appChain.rpcUrls.default.http[0], { batch: true }),
        http("https://gnosis-rpc.publicnode.com", { batch: true }),
        http("https://1rpc.io/gnosis", { batch: true }),
      ])
    : http(appChain.rpcUrls.default.http[0], { batch: true });

export const wagmiConfig = createConfig({
  chains: [appChain],
  connectors,
  pollingInterval: 4_000,
  transports: {
    [appChain.id]: transport,
  },
});
