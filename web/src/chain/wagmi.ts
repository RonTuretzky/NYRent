import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { gnosis } from "wagmi/chains";
import { defineChain, type Chain } from "viem";
import { deployment } from "./deployment";

// The app always targets deployment.json's chainId. Gnosis (100) is the
// production chain; anything else (e.g. a local anvil during e2e) gets a
// minimal chain definition so wagmi/RainbowKit still work unmodified.
const rpcOverride: string | undefined = import.meta.env.VITE_RPC_URL;

export const appChain: Chain =
  deployment.chainId === gnosis.id
    ? rpcOverride
      ? { ...gnosis, rpcUrls: { default: { http: [rpcOverride] } } }
      : gnosis
    : defineChain({
        id: deployment.chainId,
        name: `Local chain ${deployment.chainId}`,
        nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
        rpcUrls: {
          default: { http: [rpcOverride ?? "http://127.0.0.1:8547"] },
        },
      });

// Injected-only connector set. RainbowKit's option type requires a projectId
// string, but it is only consumed by WalletConnect-based wallets — none are
// configured here, so the app runs with NO WalletConnect projectId and makes
// no WalletConnect network calls.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: [injectedWallet],
    },
  ],
  {
    appName: "NY Rent Cover",
    projectId: "UNUSED_INJECTED_ONLY",
  },
);

export const wagmiConfig = createConfig({
  chains: [appChain],
  connectors,
  transports: {
    [appChain.id]: http(appChain.rpcUrls.default.http[0]),
  },
});
