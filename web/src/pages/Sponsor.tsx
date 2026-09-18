import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Button } from "@decentralpark/ui";
import { deployment, isDeployed } from "../chain/deployment";
import { erc20Abi, poolAbi } from "../chain/contracts";
import {
  useCurrencyMeta,
  usePoolStats,
  useUserCurrency,
} from "../chain/hooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import { SolvencyBar } from "../components/Bars";
import { Card, EmptyState, LoadingSkeleton, StatRow } from "../components/States";
import { formatCurrency, parseCurrency, truncateAddress } from "../chain/format";

export function Sponsor() {
  const { stats, isLoading } = usePoolStats();
  const { symbol, decimals } = useCurrencyMeta();
  const { address, isConnected, chainId } = useAccount();
  const { balance, allowance, refetch: refetchCurrency } = useUserCurrency();

  const [fundInput, setFundInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");

  const approveTx = useTx();
  const fundTx = useTx();
  const withdrawTx = useTx();

  const fundAmount = parseCurrency(fundInput, decimals);
  const withdrawAmount = parseCurrency(withdrawInput, decimals);

  const isSponsor =
    !!address &&
    !!stats.sponsor &&
    address.toLowerCase() === stats.sponsor.toLowerCase();
  const wrongNetwork = isConnected && chainId !== deployment.chainId;

  const fundValidation = useMemo<string | null>(() => {
    if (fundInput.trim() === "") return null;
    if (fundAmount === null) return "Enter a valid decimal amount.";
    if (fundAmount <= 0n) return "Amount must be greater than zero.";
    if (balance !== undefined && fundAmount > balance) {
      return `Exceeds your balance of ${formatCurrency(balance, { symbol, decimals })}.`;
    }
    return null;
  }, [fundInput, fundAmount, balance, symbol, decimals]);

  const withdrawValidation = useMemo<string | null>(() => {
    if (withdrawInput.trim() === "") return null;
    if (withdrawAmount === null) return "Enter a valid decimal amount.";
    if (withdrawAmount <= 0n) return "Amount must be greater than zero.";
    if (stats.freeCapital !== undefined && withdrawAmount > stats.freeCapital) {
      return `Exceeds free capital of ${formatCurrency(stats.freeCapital, { symbol, decimals })} — reserved claims can't be withdrawn.`;
    }
    return null;
  }, [withdrawInput, withdrawAmount, stats.freeCapital, symbol, decimals]);

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Sponsor operations open once contracts are live.
      </EmptyState>
    );
  }

  const needsApproval =
    fundAmount !== null &&
    fundAmount > 0n &&
    allowance !== undefined &&
    allowance < fundAmount;

  const busy = (tx: typeof fundTx) =>
    tx.state.status === "simulating" ||
    tx.state.status === "wallet" ||
    tx.state.status === "pending";

  async function onApprove() {
    if (fundAmount === null) return;
    const r = await approveTx.send({
      abi: erc20Abi,
      address: deployment.currency,
      functionName: "approve",
      args: [deployment.pool, fundAmount],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  async function onFund() {
    if (fundAmount === null) return;
    const r = await fundTx.send({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "fundPool",
      args: [fundAmount],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  async function onWithdraw() {
    if (withdrawAmount === null) return;
    const r = await withdrawTx.send({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "withdrawExcess",
      args: [withdrawAmount],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Sponsor
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          The sponsor funds pool capital and may withdraw whatever isn't
          reserved for sold cover. Everything here is publicly readable.
        </p>
      </header>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">Pool state</h2>
        {isLoading ? (
          <LoadingSkeleton lines={3} />
        ) : (
          <>
            <StatRow
              label="Sponsor"
              value={
                stats.sponsor ? (
                  <>
                    {truncateAddress(stats.sponsor)}
                    {isSponsor ? (
                      <span className="ml-2 text-system-green">(you)</span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )
              }
              mono
            />
            <StatRow
              label="Pool balance"
              value={formatCurrency(stats.balance, { symbol, decimals })}
            />
            <StatRow
              label="Free capital"
              value={formatCurrency(stats.freeCapital, { symbol, decimals })}
            />
            <StatRow
              label="Reserved for claims"
              value={formatCurrency(stats.reserved, { symbol, decimals })}
            />
            {stats.reserved !== undefined && stats.balance !== undefined ? (
              <div className="mt-4">
                <SolvencyBar
                  reserved={stats.reserved}
                  balance={stats.balance}
                  symbol={symbol}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>

      {!isConnected ? (
        <Card>
          <p className="font-parkBody text-sm text-surface-grey-2">
            Connect the sponsor wallet to fund or withdraw. Viewing needs no
            wallet.
          </p>
        </Card>
      ) : !isSponsor ? (
        <Card>
          <p
            className="font-parkBody text-sm text-surface-grey-2"
            data-testid="not-sponsor-note"
          >
            You're connected as {address ? truncateAddress(address) : "—"},
            which is not the sponsor — fund/withdraw transactions below would
            revert with <code>NotSponsor</code>, so they stay disabled.
          </p>
        </Card>
      ) : null}

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Fund the pool
        </h2>
        <input
          type="text"
          inputMode="decimal"
          value={fundInput}
          onChange={(e) => {
            setFundInput(e.target.value);
            approveTx.reset();
            fundTx.reset();
          }}
          placeholder="0.02"
          data-testid="fund-amount"
          className="w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
        />
        {fundValidation ? (
          <p className="mt-2 font-parkBody text-sm text-system-red font-bold" role="alert">
            {fundValidation}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-3">
          {needsApproval ? (
            <>
              <Button
                app="fund"
                variant="secondary"
                disabled={
                  !isSponsor ||
                  wrongNetwork ||
                  fundValidation !== null ||
                  fundAmount === null ||
                  busy(approveTx)
                }
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
            disabled={
              !isSponsor ||
              wrongNetwork ||
              fundAmount === null ||
              fundValidation !== null ||
              needsApproval ||
              busy(fundTx)
            }
            onClick={onFund}
            data-testid="fund-button"
          >
            {needsApproval ? "2 · " : ""}Fund pool
          </Button>
          <TxStatus state={fundTx.state} label="Fund" />
        </div>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Withdraw excess
        </h2>
        <input
          type="text"
          inputMode="decimal"
          value={withdrawInput}
          onChange={(e) => {
            setWithdrawInput(e.target.value);
            withdrawTx.reset();
          }}
          placeholder="0.005"
          data-testid="withdraw-amount"
          className="w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
        />
        {withdrawValidation ? (
          <p className="mt-2 font-parkBody text-sm text-system-red font-bold" role="alert">
            {withdrawValidation}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-3">
          <Button
            app="fund"
            variant="burn"
            disabled={
              !isSponsor ||
              wrongNetwork ||
              withdrawAmount === null ||
              withdrawValidation !== null ||
              busy(withdrawTx)
            }
            onClick={onWithdraw}
            data-testid="withdraw-button"
          >
            Withdraw
          </Button>
          <TxStatus state={withdrawTx.state} label="Withdraw" />
        </div>
      </Card>
    </div>
  );
}
