import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { Button } from "@decentralpark/ui";
import { deployment, isDeployed } from "../chain/deployment";
import { erc20Abi, poolAbi } from "../chain/contracts";
import {
  useCoverBalance,
  useCurrencyMeta,
  usePoolStats,
  useQuote,
  useSeries,
  useUserCurrency,
} from "../chain/hooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import { Card, EmptyState, LoadingSkeleton, StatRow } from "../components/States";
import {
  formatBps,
  formatCurrency,
  nowSec,
  parseCurrency,
} from "../chain/format";

export function Buy() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : undefined;
  const { series: s, isLoading } = useSeries(seriesId);
  const { symbol, decimals } = useCurrencyMeta();
  const { stats } = usePoolStats();
  const { address, isConnected, chainId } = useAccount();
  const { balance, allowance, refetch: refetchCurrency } = useUserCurrency();
  const { balance: coverBalance, refetch: refetchCover } =
    useCoverBalance(seriesId);

  const [amountInput, setAmountInput] = useState("");
  const [slippagePct, setSlippagePct] = useState("1");

  const approveTx = useTx();
  const buyTx = useTx();

  const maxClaim = parseCurrency(amountInput, decimals);
  const premium = useQuote(seriesId, maxClaim, s?.premiumRateBps);

  const maxPremium = useMemo(() => {
    if (premium === undefined) return undefined;
    const pct = Number(slippagePct);
    if (!Number.isFinite(pct) || pct < 0) return undefined;
    return premium + (premium * BigInt(Math.round(pct * 100))) / 10_000n;
  }, [premium, slippagePct]);

  const now = nowSec();

  // ---- client-side validation (SPEC: > balance, > capacity, > maxPremium) --
  const validation = useMemo<string | null>(() => {
    if (!s) return null;
    if (amountInput.trim() === "") return null;
    if (maxClaim === null) return "Enter a valid decimal amount.";
    if (maxClaim <= 0n) return "Amount must be greater than zero.";
    const remainingCapacity = s.capacity - s.sold;
    if (maxClaim > remainingCapacity) {
      return `Exceeds remaining capacity of ${formatCurrency(remainingCapacity, { symbol, decimals })}.`;
    }
    if (stats.freeCapital !== undefined && premium !== undefined) {
      // issuance must keep Σ reserved ≤ balance after collecting the premium
      const headroom = stats.freeCapital + premium;
      if (maxClaim > headroom) {
        return `Exceeds pool solvency headroom of ${formatCurrency(headroom, { symbol, decimals })} — the sponsor must fund more capital first.`;
      }
    }
    if (
      premium !== undefined &&
      balance !== undefined &&
      premium > balance
    ) {
      return `Premium ${formatCurrency(premium, { symbol, decimals })} exceeds your balance of ${formatCurrency(balance, { symbol, decimals })}.`;
    }
    if (maxPremium === undefined) {
      return "Enter a valid slippage percentage.";
    }
    return null;
  }, [
    s,
    amountInput,
    maxClaim,
    premium,
    maxPremium,
    balance,
    stats.freeCapital,
    symbol,
    decimals,
  ]);

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Buying opens once contracts are live.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid series id" />;
  }
  if (isLoading) {
    return (
      <Card className="max-w-xl mx-auto">
        <LoadingSkeleton lines={5} />
      </Card>
    );
  }
  if (!s) {
    return <EmptyState title={`Series #${seriesId} not found`} />;
  }

  // Mirrors buyProtection's own guards: time window AND not settled AND not paused
  // (buying a settled series is buying a known outcome — the chain reverts either way).
  const saleOpen = now <= s.saleEnd && !s.settled && stats.salesPaused !== true;
  const needsApproval =
    maxPremium !== undefined &&
    allowance !== undefined &&
    allowance < maxPremium;
  const wrongNetwork = isConnected && chainId !== deployment.chainId;
  const busy =
    approveTx.state.status === "simulating" ||
    approveTx.state.status === "wallet" ||
    approveTx.state.status === "pending" ||
    buyTx.state.status === "simulating" ||
    buyTx.state.status === "wallet" ||
    buyTx.state.status === "pending";

  const canSubmit =
    saleOpen &&
    isConnected &&
    !wrongNetwork &&
    maxClaim !== null &&
    maxClaim > 0n &&
    maxPremium !== undefined &&
    validation === null &&
    !busy;

  async function onApprove() {
    if (maxPremium === undefined) return;
    const result = await approveTx.send({
      abi: erc20Abi,
      address: deployment.currency,
      functionName: "approve",
      args: [deployment.pool, maxPremium],
      account: address,
    });
    if (result.status === "confirmed") refetchCurrency();
  }

  async function onBuy() {
    if (maxClaim === null || maxPremium === undefined) return;
    const result = await buyTx.send({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "buyProtection",
      args: [BigInt(seriesId!), maxClaim, maxPremium],
      account: address,
    });
    if (result.status === "confirmed") {
      refetchCurrency();
      refetchCover();
    }
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Buy protection · series #{seriesId}
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Pay a {formatBps(s.premiumRateBps)} premium, receive cover tokens
          redeemable for maxClaim × settlement ratio.
        </p>
      </header>

      {!saleOpen ? (
        <EmptyState
          title={
            s.settled
              ? "Series settled"
              : stats.salesPaused
                ? "Sales paused"
                : "Sale closed"
          }
        >
          {s.settled
            ? "This series has settled — the outcome is known, so protection can no longer be bought. You can still "
            : stats.salesPaused
              ? "The sponsor has paused new sales. Existing cover is unaffected — you can still "
              : "The sale window for this series ended. You can still "}{" "}
          <Link className="underline" to={`/settle/${seriesId}`}>
            settle
          </Link>{" "}
          or{" "}
          <Link className="underline" to={`/redeem/${seriesId}`}>
            redeem
          </Link>
          .
        </EmptyState>
      ) : (
        <Card>
          <label className="block">
            <span className="font-parkBody text-sm text-surface-grey-2">
              Max claim ({symbol} wei-equivalent units)
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => {
                setAmountInput(e.target.value);
                approveTx.reset();
                buyTx.reset();
              }}
              placeholder="0.001"
              data-testid="buy-amount"
              className="mt-1 w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
            />
          </label>
          <div className="mt-3 flex items-center gap-2">
            <span className="font-parkBody text-sm text-surface-grey-2">
              Premium slippage allowance
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
              className="w-16 rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-2 py-1 font-parkBody text-sm bg-paper-0"
              aria-label="Slippage percent"
            />
            <span className="font-parkBody text-sm text-surface-grey-2">%</span>
          </div>

          <div className="mt-4 border-t border-paper-1 pt-3">
            <StatRow
              label="Your balance"
              value={formatCurrency(balance, { symbol, decimals })}
            />
            <StatRow
              label="Remaining capacity"
              value={formatCurrency(s.capacity - s.sold, { symbol, decimals })}
            />
            <StatRow
              label="Quoted premium"
              value={
                premium !== undefined
                  ? formatCurrency(premium, { symbol, decimals })
                  : "—"
              }
            />
            <StatRow
              label="Max premium (with slippage)"
              value={
                maxPremium !== undefined
                  ? formatCurrency(maxPremium, { symbol, decimals })
                  : "—"
              }
            />
            {coverBalance !== undefined && coverBalance > 0n ? (
              <StatRow
                label="Cover you already hold"
                value={formatCurrency(coverBalance, { symbol, decimals })}
              />
            ) : null}
          </div>

          {validation ? (
            <p
              className="mt-3 font-parkBody text-sm text-system-red font-bold"
              data-testid="buy-validation"
              role="alert"
            >
              {validation}
            </p>
          ) : null}

          {!isConnected ? (
            <p className="mt-3 font-parkBody text-sm text-surface-grey-2">
              Connect a wallet to buy.
            </p>
          ) : null}

          <div className="mt-5 flex flex-col gap-3">
            {needsApproval ? (
              <>
                <Button
                  app="fund"
                  variant="secondary"
                  disabled={!canSubmit}
                  onClick={onApprove}
                  data-testid="approve-button"
                >
                  1 · Approve {symbol}
                </Button>
                <TxStatus state={approveTx.state} label="Approve" />
              </>
            ) : null}
            <Button
              app="fund"
              disabled={!canSubmit || needsApproval}
              onClick={onBuy}
              data-testid="buy-button"
            >
              {needsApproval ? "2 · " : ""}Buy protection
            </Button>
            <TxStatus state={buyTx.state} label="Buy" />
            {buyTx.state.status === "confirmed" ? (
              <p className="font-parkBody text-sm text-system-green">
                Cover minted. See{" "}
                <Link className="underline font-bold" to={`/series/${seriesId}`}>
                  series #{seriesId}
                </Link>{" "}
                or head to{" "}
                <Link className="underline font-bold" to={`/redeem/${seriesId}`}>
                  redeem
                </Link>{" "}
                after settlement.
              </p>
            ) : null}
          </div>
        </Card>
      )}
    </div>
  );
}
