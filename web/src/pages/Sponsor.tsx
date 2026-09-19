import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { decodeEventLog } from "viem";
import { Button } from "@decentralpark/ui";
import { PauseCircleIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { deployment, isDeployed } from "../chain/deployment";
import { erc20Abi, poolAbi } from "../chain/contracts";
import { addressUrl } from "../chain/explorer";
import {
  useAllSeries,
  useCurrencyMeta,
  usePoolStats,
  useUserCurrency,
} from "../chain/hooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import { SolvencyBar } from "../components/Bars";
import { AccountingCard } from "../components/Accounting";
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
  nowSec,
  parseCurrency,
  truncateAddress,
} from "../chain/format";

/** "$88.00" per-SF input → integer cents, or null when invalid. */
function parseCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return cents > 0 && cents <= 0xffffffff ? cents : null;
}

/** "28.50" percent input → integer bps (uint16), or null when invalid. */
function parseRateBps(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return bps > 0 && bps <= 0xffff ? bps : null;
}

/** datetime-local value → epoch seconds (local timezone), or null. */
function parseTs(input: string): bigint | null {
  if (input.trim() === "") return null;
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-parkBody text-sm text-surface-grey-2">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? (
        <span className="font-parkBody text-xs text-surface-grey">{hint}</span>
      ) : null}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0";

export function Sponsor() {
  const { stats, isLoading, rpcError } = usePoolStats();
  const { series: allSeries } = useAllSeries();
  const { symbol, decimals } = useCurrencyMeta();
  const { address, isConnected, chainId } = useAccount();
  const { balance, allowance, refetch: refetchCurrency } = useUserCurrency();

  const [fundInput, setFundInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");

  const [strikeLowInput, setStrikeLowInput] = useState("");
  const [strikeHighInput, setStrikeHighInput] = useState("");
  const [rateInput, setRateInput] = useState("");
  const [saleEndInput, setSaleEndInput] = useState("");
  const [obsStartInput, setObsStartInput] = useState("");
  const [obsEndInput, setObsEndInput] = useState("");
  const [redeemEndInput, setRedeemEndInput] = useState("");
  const [capacityInput, setCapacityInput] = useState("");
  const [createdId, setCreatedId] = useState<bigint | undefined>(undefined);

  const approveTx = useTx({ label: "Approve" });
  const fundTx = useTx({ label: "Fund pool" });
  const withdrawTx = useTx({ label: "Withdraw" });
  const createTx = useTx({ label: "Create series" });
  const pauseTx = useTx({ label: "Sales switch" });

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

  const strikeLow = parseCents(strikeLowInput);
  const strikeHigh = parseCents(strikeHighInput);
  const rateBps = parseRateBps(rateInput);
  const saleEnd = parseTs(saleEndInput);
  const obsStart = parseTs(obsStartInput);
  const obsEnd = parseTs(obsEndInput);
  const redeemEnd = parseTs(redeemEndInput);
  const capacity = parseCurrency(capacityInput, decimals);

  const createFilled =
    strikeLowInput.trim() !== "" &&
    strikeHighInput.trim() !== "" &&
    rateInput.trim() !== "" &&
    saleEndInput.trim() !== "" &&
    obsStartInput.trim() !== "" &&
    obsEndInput.trim() !== "" &&
    redeemEndInput.trim() !== "" &&
    capacityInput.trim() !== "";

  const createValidation = useMemo<string | null>(() => {
    if (!createFilled) return null;
    const now = nowSec();
    if (strikeLow === null) return "Strike low must be a positive $/SF value (two decimals max).";
    if (strikeHigh === null) return "Strike high must be a positive $/SF value (two decimals max).";
    if (strikeLow >= strikeHigh) {
      return "Strike low must be below strike high — the contract rejects an empty band (InvalidParams: strikes).";
    }
    if (rateBps === null) return "Premium rate must be a percentage between 0.01% and 655.35%.";
    if (saleEnd === null || obsStart === null || obsEnd === null || redeemEnd === null) {
      return "Fill every timestamp.";
    }
    if (saleEnd <= now) return "Sale end must be in the future.";
    if (saleEnd > obsStart) {
      return "Sale must end before the observation window opens (saleEnd ≤ obsStart). Selling while a qualifying rent print may already exist would let buyers trade on a known outcome — the live demo series has this flaw; new series must not.";
    }
    if (!(obsStart < obsEnd)) return "Observation start must be before observation end.";
    if (!(obsEnd < redeemEnd)) return "Redeem end must be after the observation window closes.";
    if (capacity === null || capacity <= 0n) return "Capacity must be a positive amount.";
    return null;
  }, [
    createFilled,
    strikeLow,
    strikeHigh,
    rateBps,
    saleEnd,
    obsStart,
    obsEnd,
    redeemEnd,
    capacity,
  ]);

  const capacityHint =
    createValidation === null &&
    capacity !== null &&
    stats.freeCapital !== undefined &&
    capacity > stats.freeCapital
      ? `Heads-up: capacity ${formatCurrency(capacity, { symbol, decimals })} exceeds current free capital ${formatCurrency(stats.freeCapital, { symbol, decimals })}. Creation will succeed, but sales stop at the solvency guard until more capital is funded.`
      : null;

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Sponsor operations open once contracts are live.
      </EmptyState>
    );
  }

  // Full-page outage state only when no pool data was ever loaded; a failed
  // background refetch keeps the rendered page (typed amounts, in-flight
  // TxStatus panels) with a slim stale banner instead.
  if (rpcError && stats.sponsor === undefined) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <header>
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Sponsor
          </h1>
        </header>
        <RpcDownState />
      </div>
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

  const sponsorGateDisabled = !isSponsor || wrongNetwork;

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

  async function onCreateSeries() {
    if (
      strikeLow === null ||
      strikeHigh === null ||
      rateBps === null ||
      saleEnd === null ||
      obsStart === null ||
      obsEnd === null ||
      redeemEnd === null ||
      capacity === null
    ) {
      return;
    }
    setCreatedId(undefined);
    const r = await createTx.send({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "createSeries",
      args: [
        strikeLow,
        strikeHigh,
        rateBps,
        saleEnd,
        obsStart,
        obsEnd,
        redeemEnd,
        capacity,
      ],
      account: address,
    });
    if (r.status === "confirmed") {
      for (const log of r.receipt.logs) {
        if (log.address.toLowerCase() !== deployment.pool.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({
            abi: poolAbi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (ev.eventName === "SeriesCreated") {
            const args = ev.args as unknown as { seriesId: bigint };
            setCreatedId(args.seriesId);
          }
        } catch {
          /* other event */
        }
      }
    }
  }

  async function onTogglePause() {
    if (stats.salesPaused === undefined) return;
    await pauseTx.send({
      abi: poolAbi,
      address: deployment.pool,
      functionName: "setSalesPaused",
      args: [!stats.salesPaused],
      account: address,
    });
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Sponsor
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          The sponsor funds pool capital, creates series, pauses sales, and may
          withdraw whatever isn't reserved for sold cover. Everything here is
          publicly readable.
        </p>
      </header>

      {rpcError ? <RpcStaleBanner /> : null}

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
                    <a
                      href={addressUrl(stats.sponsor)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-dotted"
                    >
                      {truncateAddress(stats.sponsor)}
                    </a>
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
            <StatRow
              label="Sales"
              value={
                stats.salesPaused === undefined ? (
                  "—"
                ) : stats.salesPaused ? (
                  <span className="text-system-red">paused</span>
                ) : (
                  <span className="text-system-green">open</span>
                )
              }
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

      {allSeries.length > 0 ? (
        <AccountingCard
          entries={allSeries}
          symbol={symbol}
          decimals={decimals}
        />
      ) : null}

      {!isConnected ? (
        <Card>
          <p className="font-parkBody text-sm text-surface-grey-2">
            Connect the sponsor wallet to fund, create series, pause sales or
            withdraw. Viewing needs no wallet.
          </p>
        </Card>
      ) : !isSponsor ? (
        <Card>
          <p
            className="font-parkBody text-sm text-surface-grey-2"
            data-testid="not-sponsor-note"
          >
            You're connected as {address ? truncateAddress(address) : "—"},
            which is not the sponsor — the transactions below would revert with{" "}
            <code>NotSponsor</code>, so they stay disabled. Everything remains
            readable.
          </p>
        </Card>
      ) : null}

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Fund the pool
        </h2>
        <Field label={`Amount to fund (${symbol})`}>
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
            className={inputCls}
          />
        </Field>
        {fundValidation ? (
          <p className="mt-2 font-parkBody text-sm text-system-red font-bold" role="alert">
            {fundValidation}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-3">
          {needsApproval ? (
            <>
              <StatRow
                label="Current allowance"
                value={`${formatCurrency(allowance, { symbol, decimals })} — approving ${formatCurrency(fundAmount, { symbol, decimals })}`}
              />
              <Button
                app="fund"
                variant="secondary"
                disabled={
                  sponsorGateDisabled ||
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
              sponsorGateDisabled ||
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
        <Field label={`Amount to withdraw (${symbol})`}>
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
            className={inputCls}
          />
        </Field>
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
              sponsorGateDisabled ||
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

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-parkDisplay font-bold text-lg">Sales switch</h2>
          {stats.salesPaused ? (
            <PauseCircleIcon size={24} className="text-system-red" />
          ) : (
            <PlayCircleIcon size={24} className="text-system-green" />
          )}
        </div>
        <p className="font-parkBody text-sm text-surface-grey-2">
          Sales are currently{" "}
          <span className="font-bold">
            {stats.salesPaused === undefined
              ? "—"
              : stats.salesPaused
                ? "paused"
                : "open"}
          </span>
          . Pausing stops new purchases only — settlement and redemption can
          never be paused.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <Button
            app="fund"
            variant="secondary"
            disabled={
              sponsorGateDisabled ||
              stats.salesPaused === undefined ||
              busy(pauseTx)
            }
            onClick={onTogglePause}
            data-testid="pause-toggle"
          >
            {stats.salesPaused ? "Resume sales" : "Pause sales"}
          </Button>
          <TxStatus state={pauseTx.state} label="Sales switch" />
        </div>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-1">
          Create a series
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 mb-4">
          Parameters are immutable once created — no setter exists at all.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Strike low ($/SF)">
            <input
              type="text"
              inputMode="decimal"
              value={strikeLowInput}
              onChange={(e) => {
                setStrikeLowInput(e.target.value);
                createTx.reset();
              }}
              placeholder="88.00"
              data-testid="create-strike-low"
              className={inputCls}
            />
          </Field>
          <Field label="Strike high ($/SF)">
            <input
              type="text"
              inputMode="decimal"
              value={strikeHighInput}
              onChange={(e) => {
                setStrikeHighInput(e.target.value);
                createTx.reset();
              }}
              placeholder="96.00"
              data-testid="create-strike-high"
              className={inputCls}
            />
          </Field>
          <Field label="Premium rate (% of max claim)">
            <input
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => {
                setRateInput(e.target.value);
                createTx.reset();
              }}
              placeholder="28.50"
              data-testid="create-rate"
              className={inputCls}
            />
          </Field>
          <Field label={`Capacity (${symbol})`}>
            <input
              type="text"
              inputMode="decimal"
              value={capacityInput}
              onChange={(e) => {
                setCapacityInput(e.target.value);
                createTx.reset();
              }}
              placeholder="0.02"
              data-testid="create-capacity"
              className={inputCls}
            />
          </Field>
          <Field label="Sale ends" hint="must be before observation starts">
            <input
              type="datetime-local"
              value={saleEndInput}
              onChange={(e) => {
                setSaleEndInput(e.target.value);
                createTx.reset();
              }}
              data-testid="create-sale-end"
              className={inputCls}
            />
          </Field>
          <Field label="Observation starts">
            <input
              type="datetime-local"
              value={obsStartInput}
              onChange={(e) => {
                setObsStartInput(e.target.value);
                createTx.reset();
              }}
              data-testid="create-obs-start"
              className={inputCls}
            />
          </Field>
          <Field label="Observation ends">
            <input
              type="datetime-local"
              value={obsEndInput}
              onChange={(e) => {
                setObsEndInput(e.target.value);
                createTx.reset();
              }}
              data-testid="create-obs-end"
              className={inputCls}
            />
          </Field>
          <Field label="Redeem until">
            <input
              type="datetime-local"
              value={redeemEndInput}
              onChange={(e) => {
                setRedeemEndInput(e.target.value);
                createTx.reset();
              }}
              data-testid="create-redeem-end"
              className={inputCls}
            />
          </Field>
        </div>
        {createValidation ? (
          <p
            className="mt-3 font-parkBody text-sm text-system-red font-bold"
            role="alert"
            data-testid="create-validation"
          >
            {createValidation}
          </p>
        ) : null}
        {capacityHint ? (
          <p
            className="mt-3 font-parkBody text-sm text-system-warning font-bold"
            data-testid="create-capacity-hint"
          >
            {capacityHint}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-3">
          <Button
            app="fund"
            disabled={
              sponsorGateDisabled ||
              !createFilled ||
              createValidation !== null ||
              busy(createTx)
            }
            onClick={onCreateSeries}
            data-testid="create-series-button"
          >
            Create series
          </Button>
          <TxStatus state={createTx.state} label="Create" />
          {createTx.state.status === "confirmed" && createdId !== undefined ? (
            <p className="font-parkBody text-sm text-system-green">
              Series #{createdId.toString()} created.
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
