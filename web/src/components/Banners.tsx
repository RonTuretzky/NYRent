import { WarningIcon, PlugsIcon } from "@phosphor-icons/react";
import { useAccount, useSwitchChain } from "wagmi";
import { Button } from "@decentralpark/ui";
import {
  TEST_DEPLOYMENT,
  isLiveDeployment,
  useActiveDeployment,
} from "../chain/registry";

import { V4_DEPLOYMENTS } from "../chain/v4";

/**
 * Dev/e2e nicety: deployment.json points at a local chain but still carries
 * zero-address placeholders, so the registry refused to serve it and the app
 * fell back to the baked production deployments. Production builds never see
 * this (their deployments are baked real).
 */
export function NotDeployedBanner() {
  const { deployment } = useActiveDeployment();
  if (!isLiveDeployment(deployment) && !V4_DEPLOYMENTS[String(deployment.chainId)]) {
    return (
      <div data-testid="deployment-target-banner" role="status" className="bg-paper-1 border-b border-paper-2 px-4 py-3 font-parkBody text-sm text-center">
        {deployment.name} is a deployment target. Its RENT market is not live yet; calculators show demo examples.
      </div>
    );
  }
  if (!TEST_DEPLOYMENT || isLiveDeployment(TEST_DEPLOYMENT)) return null;
  return (
    <div
      data-testid="not-deployed-banner"
      className="bg-system-warning text-white px-4 py-3 flex items-start gap-3"
      role="alert"
    >
      <WarningIcon size={22} weight="fill" className="shrink-0 mt-0.5" />
      <div className="font-parkBody text-sm">
        <span className="font-bold">Local deployment not ready.</span>{" "}
        <code>deployment.json</code> points at chain {TEST_DEPLOYMENT.chainId}{" "}
        but its contract addresses are zero placeholders, so this test chain
        is not being served — the app is showing the baked production
        deployments instead. Run the deploy script to write real addresses.
      </div>
    </div>
  );
}

/**
 * Wrong-network banner: compares the WALLET chain to the ACTIVE deployment
 * (the chain the header switcher selected) and offers a one-click
 * switchChain to it.
 */
export function WrongNetworkBanner() {
  const { deployment } = useActiveDeployment();
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
        Your wallet is on a different network — RentSafe is reading{" "}
        <span className="font-bold">{deployment.name}</span> (chain{" "}
        {deployment.chainId}).
      </span>
      <Button
        app="fund"
        size="sm"
        variant="light"
        isLoading={isPending}
        onClick={() => switchChain({ chainId: deployment.chainId })}
      >
        Switch to {deployment.name}
      </Button>
      {error ? (
        <span className="font-parkBody text-xs basis-full">
          Switch failed: {error.message.split("\n")[0]} — switch networks in
          your wallet instead, or pick your wallet's network in the header.
        </span>
      ) : null}
    </div>
  );
}
