import { WarningIcon, PlugsIcon } from "@phosphor-icons/react";
import { useAccount, useSwitchChain } from "wagmi";
import { Button } from "@decentralpark/ui";
import { deployment, isDeployed, ZERO_ADDRESS } from "../chain/deployment";
import { appChain } from "../chain/wagmi";

/** Unmistakable banner while the app is inert, naming the actual cause:
 * zero-address placeholders in deployment.json, or the production guard
 * refusing a deployment.json that points at a non-Gnosis chain. */
export function NotDeployedBanner() {
  if (isDeployed) return null;
  const hasZeroAddress =
    deployment.oracle === ZERO_ADDRESS ||
    deployment.pool === ZERO_ADDRESS ||
    deployment.token === ZERO_ADDRESS ||
    deployment.currency === ZERO_ADDRESS;
  return (
    <div
      data-testid="not-deployed-banner"
      className="bg-system-warning text-white px-4 py-3 flex items-start gap-3"
      role="alert"
    >
      <WarningIcon size={22} weight="fill" className="shrink-0 mt-0.5" />
      <div className="font-parkBody text-sm">
        <span className="font-bold">Not deployed yet.</span>{" "}
        {hasZeroAddress ? (
          <>
            The contract addresses in <code>deployment.json</code> are zero
            placeholders — nothing is on-chain for this app yet. All figures
            below are unavailable until the operator deploys and writes real
            addresses.
          </>
        ) : (
          <>
            This production build's <code>deployment.json</code> points at
            chain {deployment.chainId}, not Gnosis (100), so the wrong-chain
            guard keeps the app inert. Rebuild against a Gnosis deployment —
            test builds may opt out with <code>VITE_ALLOW_TEST_CHAIN=1</code>.
          </>
        )}
      </div>
    </div>
  );
}

/** Wrong-network banner with a one-click switch to the app chain (Gnosis). */
export function WrongNetworkBanner() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected || chainId === deployment.chainId) return null;

  return (
    <div
      data-testid="wrong-network-banner"
      className="bg-system-red text-white px-4 py-3 flex flex-wrap items-center gap-3"
      role="alert"
    >
      <PlugsIcon size={22} weight="fill" className="shrink-0" />
      <span className="font-parkBody text-sm flex-1 min-w-48">
        Your wallet is on the wrong network — NY Rent Cover lives on{" "}
        <span className="font-bold">{appChain.name}</span> (chain{" "}
        {deployment.chainId}).
      </span>
      <Button
        app="fund"
        size="sm"
        variant="light"
        isLoading={isPending}
        onClick={() => switchChain({ chainId: deployment.chainId })}
      >
        Switch to {appChain.name}
      </Button>
      {error ? (
        <span className="font-parkBody text-xs basis-full">
          Switch failed: {error.message.split("\n")[0]} — switch networks in
          your wallet instead.
        </span>
      ) : null}
    </div>
  );
}
