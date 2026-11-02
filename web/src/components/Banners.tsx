import { PlugsIcon } from "@phosphor-icons/react";
import { useAccount, useSwitchChain } from "wagmi";
import { Button } from "@decentralpark/ui";
import { NETWORK } from "../chain/apartments";

/**
 * Wrong-network banner: shown while a connected wallet sits on any chain other
 * than the app's one network, with a one-click switch.
 */
export function WrongNetworkBanner() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected || chainId === NETWORK.chainId) return null;

  return (
    <div
      data-testid="wrong-network-banner"
      className="bg-system-red text-white px-4 py-3 flex flex-wrap items-center gap-3"
      role="alert"
    >
      <PlugsIcon size={22} weight="fill" className="shrink-0" />
      <span className="font-parkBody text-sm flex-1 min-w-48">
        Your wallet is on a different network. RentSafe policies live on{" "}
        <span className="font-bold">{NETWORK.name}</span> (chain {NETWORK.chainId}).
      </span>
      <Button
        app="fund"
        size="sm"
        variant="light"
        isLoading={isPending}
        onClick={() => switchChain({ chainId: NETWORK.chainId })}
      >
        Switch to {NETWORK.name}
      </Button>
      {error ? (
        <span className="font-parkBody text-xs basis-full">
          Switch failed: {error.message.split("\n")[0]}. Switch to {NETWORK.name} in your wallet instead.
        </span>
      ) : null}
    </div>
  );
}
