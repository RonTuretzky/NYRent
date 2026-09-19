import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { Button } from "@decentralpark/ui";
import { deployment, isDeployed } from "../chain/deployment";
import { poolAbi } from "../chain/contracts";
import {
  useCoverBalance,
  useCurrencyMeta,
  useSeries,
  useUserCurrency,
} from "../chain/hooks";
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
  const { series: s, isLoading, rpcError } = useSeries(seriesId);
  const { symbol, decimals } = useCurrencyMeta();
  const { address, isConnected, chainId } = useAccount();
  const { balance: coverBalance, refetch: refetchCover } =
    useCoverBalance(seriesId);
  const { refetch: refetchCurrency } = useUserCurrency();

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
      return `You only hold ${formatCurrency(coverBalance, { symbol, decimals })} of cover in this series.`;
    }
    return null;
  }, [s, amountInput, amount, coverBalance, symbol, decimals]);

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Redemption opens once contracts are live.
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
        functionName: "redeem",
        args: [BigInt(seriesId!), amount],
        account: address,
      },
      { label: "Redeem cover" },
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
          Redeem · series #{seriesId}
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Burn cover tokens, receive maxClaim × payout ratio. Redemption can
          never be paused.
        </p>
      </header>

      {rpcError ? <RpcStaleBanner /> : null}

      {!s.settled ? (
        <EmptyState title="Not settled yet">
          This series hasn't settled.{" "}
          <Link className="underline" to={`/settle/${seriesId}`}>
            Settle it with the CRE Daily email
          </Link>{" "}
          first.
        </EmptyState>
      ) : now > s.redeemEnd ? (
        <EmptyState title="Redemption window closed">
          The claim window ended {formatTimestamp(s.redeemEnd)}. Remaining
          reserves have been released to the pool's free capital.
        </EmptyState>
      ) : (
        <Card>
          <StatRow
            label="Payout ratio"
            value={formatRatioWad(s.payoutRatioWad)}
          />
          <StatRow
            label="Your cover balance"
            value={formatCurrency(coverBalance, { symbol, decimals })}
          />
          <StatRow
            label="Redeem until"
            value={formatTimestamp(s.redeemEnd)}
          />

          <label className="block mt-4">
            <span className="font-parkBody text-sm text-surface-grey-2">
              Amount of cover to redeem
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
              </span>
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
              Connect the wallet holding your cover tokens.
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
              Redeem
            </Button>
            <TxStatus state={redeemTx.state} label="Redeem" />
          </div>
        </Card>
      )}
    </div>
  );
}
