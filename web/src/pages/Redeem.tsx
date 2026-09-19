import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { Button } from "@decentralpark/ui";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { poolAbi } from "../chain/contracts";
import {
  useCoverUnits,
  useSeriesRow,
  useWalletCurrency,
} from "../chain/poolHooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  RpcStaleBanner,
  StatRow,
} from "../components/States";
import {
  formatCurrency,
  formatRatioWad,
  formatTimestamp,
  nowSec,
  parseCurrency,
  WAD,
} from "../chain/format";

export function Redeem() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : undefined;
  const { deployment } = useActiveDeployment();
  const { series: s, isLoading, rpcError } = useSeriesRow(seriesId);
  const { symbol, decimals } = deployment.currency;
  const { address, isConnected, chainId } = useAccount();
  const { balance: coverBalance, refetch: refetchCover } =
    useCoverUnits(seriesId);
  const { refetch: refetchCurrency } = useWalletCurrency();

  const [amountInput, setAmountInput] = useState("");
  const redeemTx = useTx();

  const amount = parseCurrency(amountInput, decimals);
  const payout =
    amount !== null && s ? (amount * s.payoutRatioWad) / WAD : null;

  const now = nowSec();
  const wrongNetwork = isConnected && chainId !== deployment.chainId;

  const validation = useMemo<string | null>(() => {
    if (!s || amountInput.trim() === "") return null;
    if (amount === null) return "Enter a valid decimal amount.";
    if (amount <= 0n) return "Amount must be greater than zero.";
    if (coverBalance !== undefined && amount > coverBalance) {
      return `You only hold ${formatCurrency(coverBalance, { symbol, decimals })} of protection in this series.`;
    }
    return null;
  }, [s, amountInput, amount, coverBalance, symbol, decimals]);

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Payouts open once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid series id" />;
  }
  if (isLoading) {
    return (
      <Card className="max-w-xl mx-auto">
        <LoadingSkeleton lines={4} />
      </Card>
    );
  }
  // Full-page outage state only when there is nothing to render; a failed
  // background refetch keeps the cached page (with a slim stale banner) so
  // component state (typed amounts, in-flight TxStatus) survives RPC blips.
  if (!s && rpcError) {
    return (
      <div className="max-w-xl mx-auto">
        <RpcDownState />
      </div>
    );
  }
  if (!s) {
    return <EmptyState title={`Series #${seriesId} not found`} />;
  }

  const windowOpen = s.settled && now <= s.redeemEnd;
  const busy =
    redeemTx.state.status === "simulating" ||
    redeemTx.state.status === "wallet" ||
    redeemTx.state.status === "pending";

  async function onRedeem() {
    if (amount === null) return;
    const result = await redeemTx.send(
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "redeem",
        args: [BigInt(seriesId!), amount],
        account: address,
      },
      { label: "Claim payout" },
    );
    if (result.status === "confirmed") {
      refetchCover();
      refetchCurrency();
    }
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Claim payout · series #{seriesId}
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          This series has a settled result. Turn in your protection and the
          contract pays you your share directly — claiming can never be
          paused, and nobody can take the money out from under you.
        </p>
      </header>

      {rpcError ? <RpcStaleBanner /> : null}

      {s.cancelled ? (
        <EmptyState title="This series was cancelled">
          It was cancelled by its creator before anything sold — there is
          nothing to claim.
        </EmptyState>
      ) : !s.settled ? (
        <EmptyState title="Not settled yet">
          This series doesn't have a result yet.{" "}
          <Link className="underline" to={`/settle/${seriesId}`}>
            Settle it with the signed rent newsletter
          </Link>{" "}
          first.
        </EmptyState>
      ) : now > s.redeemEnd ? (
        <EmptyState title="The claim window has closed">
          Claims were open until {formatTimestamp(s.redeemEnd)}. Anything left
          unclaimed returns to the series creator who escrowed the money.
        </EmptyState>
      ) : (
        <Card>
          <StatRow
            label="Payout ratio (what each unit pays)"
            value={formatRatioWad(s.payoutRatioWad)}
          />
          <StatRow
            label="Your protection in this series"
            value={formatCurrency(coverBalance, { symbol, decimals })}
          />
          <StatRow
            label="Claim before"
            value={formatTimestamp(s.redeemEnd)}
          />

          <label className="block mt-4">
            <span className="font-parkBody text-sm text-surface-grey-2">
              How much protection to turn in
            </span>
            <div className="flex gap-2 mt-1">
              <input
                type="text"
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => {
                  setAmountInput(e.target.value);
                  redeemTx.reset();
                }}
                placeholder="0.001"
                data-testid="redeem-amount"
                className="flex-1 rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
              />
              <Button
                app="fund"
                variant="light"
                size="sm"
                disabled={coverBalance === undefined || coverBalance === 0n}
                onClick={() => {
                  if (coverBalance !== undefined) {
                    setAmountInput(formatUnits(coverBalance, decimals));
                  }
                }}
              >
                Max
              </Button>
            </div>
          </label>

          {payout !== null && validation === null ? (
            <p className="font-parkBody text-sm mt-3" data-testid="payout-preview">
              You will receive{" "}
              <span className="font-bold text-core-green">
                {formatCurrency(payout, { symbol, decimals })}
              </span>{" "}
              straight to your wallet.
            </p>
          ) : null}

          {validation ? (
            <p
              className="mt-3 font-parkBody text-sm text-system-red font-bold"
              role="alert"
              data-testid="redeem-validation"
            >
              {validation}
            </p>
          ) : null}

          {!isConnected ? (
            <p className="mt-3 font-parkBody text-sm text-surface-grey-2">
              Connect the wallet that bought the protection — payouts go only
              to the holder.
            </p>
          ) : null}

          <div className="mt-5 flex flex-col gap-3">
            <Button
              app="fund"
              variant="positive"
              disabled={
                !windowOpen ||
                !isConnected ||
                wrongNetwork ||
                amount === null ||
                amount <= 0n ||
                validation !== null ||
                busy
              }
              onClick={onRedeem}
              data-testid="redeem-button"
            >
              Claim payout
            </Button>
            <TxStatus state={redeemTx.state} label="Claim" />
          </div>
        </Card>
      )}
    </div>
  );
}
