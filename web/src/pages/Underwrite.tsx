import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { decodeEventLog } from "viem";
import { Button } from "@decentralpark/ui";
import {
  PauseCircleIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { erc20Abi, poolAbi } from "../chain/contracts";
import {
  isStandardShape,
  useSeriesIndex,
  useWalletCurrency,
  type SeriesRow,
} from "../chain/poolHooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import { CapacityBar } from "../components/Bars";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  RpcStaleBanner,
  StatRow,
} from "../components/States";
import { StandardBadge } from "./SeriesList";
import { seriesPhase } from "../chain/types";
import {
  formatCents,
  formatCurrency,
  formatTimestamp,
  nowSec,
  parseCurrency,
} from "../chain/format";

/** Mirrors CoverPool.MIN_REDEEM_WINDOW (7 days, in seconds). */
const MIN_REDEEM_WINDOW = 7n * 86_400n;

/** "$88.00" per-SF input → integer cents, or null when invalid. */
function parseCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return cents > 0 && cents <= 0xffffffff ? cents : null;
}

/** "28.50" percent input → integer bps (≤ 100%), or null when invalid. */
function parseRateBps(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return bps > 0 && bps <= 10_000 ? bps : null;
}

/** datetime-local value → epoch seconds (local timezone), or null. */
function parseTs(input: string): bigint | null {
  if (input.trim() === "") return null;
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}

/** "in 3d 4h" countdown copy for the residual unlock. */
function countdown(until: bigint, now: bigint): string {
  const secs = Number(until - now);
  if (secs <= 0) return "now";
  const days = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  if (days > 0) return `in ${days}d ${hours}h`;
  const mins = Math.max(1, Math.floor((secs % 3_600) / 60));
  return hours > 0 ? `in ${hours}h ${mins}m` : `in ${mins}m`;
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

const busyTx = (tx: ReturnType<typeof useTx>) =>
  tx.state.status === "simulating" ||
  tx.state.status === "wallet" ||
  tx.state.status === "pending";

/** One of the connected creator's series: accounting + the four levers. */
function YourSeriesCard({ row }: { row: SeriesRow }) {
  const { deployment } = useActiveDeployment();
  const { symbol, decimals } = deployment.currency;
  const { address, isConnected, chainId } = useAccount();
  const { allowance, refetch: refetchCurrency } = useWalletCurrency();
  const wrongNetwork = isConnected && chainId !== deployment.chainId;

  const { id, series: s, paused } = row;
  const now = nowSec();
  const phase = seriesPhase(s, now);

  const pauseTx = useTx({ label: `Market #${id} sales switch` });
  const approveTopUpTx = useTx({ label: "Approve top-up" });
  const addCapacityTx = useTx({ label: "Add capacity" });
  const cancelTx = useTx({ label: "Cancel market" });
  const withdrawTx = useTx({ label: "Withdraw residual" });

  const [topUpInput, setTopUpInput] = useState("");
  const topUp = parseCurrency(topUpInput, decimals);
  const needsTopUpApproval =
    topUp !== null &&
    topUp > 0n &&
    allowance !== undefined &&
    allowance < topUp;

  const saleOpen = !s.settled && !s.cancelled && now <= s.saleEnd;
  const unsold = s.sold === 0n;
  const residual = s.escrow + s.premiumsAccrued - s.paidOut - s.withdrawn;
  const residualUnlocked = now > s.redeemEnd;
  const gate = !isConnected || wrongNetwork;

  async function onTogglePause() {
    await pauseTx.send({
      abi: poolAbi,
      address: deployment.pool,
      chainId: deployment.chainId,
      functionName: "setSeriesPaused",
      args: [BigInt(id), !paused],
      account: address,
    });
  }

  async function onApproveTopUp() {
    if (topUp === null) return;
    const r = await approveTopUpTx.send({
      abi: erc20Abi,
      address: deployment.currency.address,
      chainId: deployment.chainId,
      functionName: "approve",
      args: [deployment.pool, topUp],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  async function onAddCapacity() {
    if (topUp === null) return;
    const r = await addCapacityTx.send({
      abi: poolAbi,
      address: deployment.pool,
      chainId: deployment.chainId,
      functionName: "addCapacity",
      args: [BigInt(id), topUp],
      account: address,
    });
    if (r.status === "confirmed") {
      setTopUpInput("");
      refetchCurrency();
    }
  }

  async function onCancel() {
    const r = await cancelTx.send({
      abi: poolAbi,
      address: deployment.pool,
      chainId: deployment.chainId,
      functionName: "cancelSeries",
      args: [BigInt(id)],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  async function onWithdrawResidual() {
    const r = await withdrawTx.send({
      abi: poolAbi,
      address: deployment.pool,
      chainId: deployment.chainId,
      functionName: "withdrawResidual",
      args: [BigInt(id)],
      account: address,
    });
    if (r.status === "confirmed") refetchCurrency();
  }

  return (
    <Card data-testid={`your-series-${id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-parkDisplay font-bold text-lg">
          Market #{id} · {formatCents(s.strikeLowCents)} →{" "}
          {formatCents(s.strikeHighCents)}
        </h3>
        <div className="flex items-center gap-2">
          {isStandardShape(s) ? <StandardBadge /> : null}
          <span className="font-parkBody text-xs font-bold rounded-full px-3 py-1 bg-paper-2 text-surface-grey-2">
            {s.cancelled ? "cancelled" : phase}
          </span>
        </div>
      </div>

      <StatRow
        label="Escrow (your deposit backing payouts)"
        value={formatCurrency(s.escrow, { symbol, decimals })}
      />
      <StatRow
        label="Protection sold"
        value={formatCurrency(s.sold, { symbol, decimals })}
      />
      <StatRow
        label="Premiums accrued to you"
        value={formatCurrency(s.premiumsAccrued, { symbol, decimals })}
      />
      <StatRow
        label="Paid out to holders"
        value={formatCurrency(s.paidOut, { symbol, decimals })}
      />
      {!s.cancelled ? (
        <div className="mt-3">
          <CapacityBar
            sold={s.sold}
            capacity={s.escrow}
            symbol={symbol}
            decimals={decimals}
          />
        </div>
      ) : null}

      {s.cancelled ? (
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
          Cancelled — your full escrow was refunded when you cancelled, and
          this market is permanently closed.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {/* pause */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              app="fund"
              variant="secondary"
              size="sm"
              disabled={gate || s.settled || busyTx(pauseTx)}
              onClick={onTogglePause}
              data-testid={`pause-toggle-${id}`}
            >
              {paused ? (
                <>
                  <PlayCircleIcon size={18} className="inline mr-1 -mt-0.5" />
                  Resume sales
                </>
              ) : (
                <>
                  <PauseCircleIcon size={18} className="inline mr-1 -mt-0.5" />
                  Pause sales
                </>
              )}
            </Button>
            <span className="font-parkBody text-xs text-surface-grey-2">
              Pausing stops new purchases of this market only — it never
              blocks settlement or holders' payouts.
            </span>
          </div>
          <TxStatus state={pauseTx.state} label="Sales switch" />

          {/* add capacity */}
          {saleOpen ? (
            <div>
              <Field
                label={`Add capacity (${symbol})`}
                hint="pulls more of your money into escrow so more protection can be sold — only before the sale ends"
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={topUpInput}
                  onChange={(e) => {
                    setTopUpInput(e.target.value);
                    approveTopUpTx.reset();
                    addCapacityTx.reset();
                  }}
                  placeholder="0.01"
                  data-testid={`add-capacity-amount-${id}`}
                  className={inputCls}
                />
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                {needsTopUpApproval ? (
                  <Button
                    app="fund"
                    variant="secondary"
                    size="sm"
                    disabled={gate || topUp === null || busyTx(approveTopUpTx)}
                    onClick={onApproveTopUp}
                    data-testid={`add-capacity-approve-${id}`}
                  >
                    1 · Approve {symbol}
                  </Button>
                ) : null}
                <Button
                  app="fund"
                  size="sm"
                  disabled={
                    gate ||
                    topUp === null ||
                    topUp <= 0n ||
                    needsTopUpApproval ||
                    busyTx(addCapacityTx)
                  }
                  onClick={onAddCapacity}
                  data-testid={`add-capacity-button-${id}`}
                >
                  {needsTopUpApproval ? "2 · " : ""}Add capacity
                </Button>
              </div>
              <TxStatus state={approveTopUpTx.state} label="Approve" />
              <TxStatus state={addCapacityTx.state} label="Add capacity" />
            </div>
          ) : null}

          {/* cancel */}
          {!s.settled && unsold ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                app="fund"
                variant="burn"
                size="sm"
                disabled={gate || busyTx(cancelTx)}
                onClick={onCancel}
                data-testid={`cancel-button-${id}`}
              >
                Cancel & refund escrow
              </Button>
              <span className="font-parkBody text-xs text-surface-grey-2">
                Only possible while nothing has sold: your full{" "}
                {formatCurrency(s.escrow, { symbol, decimals })} escrow comes
                straight back and the market closes forever.
              </span>
            </div>
          ) : null}
          <TxStatus state={cancelTx.state} label="Cancel" />

          {/* withdraw residual */}
          {!s.residualWithdrawn ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                app="fund"
                variant="positive"
                size="sm"
                disabled={gate || !residualUnlocked || busyTx(withdrawTx)}
                onClick={onWithdrawResidual}
                data-testid="withdraw-button"
              >
                Withdraw residual
              </Button>
              <span className="font-parkBody text-xs text-surface-grey-2">
                {residualUnlocked ? (
                  <>
                    Claim window closed — your residual (
                    {formatCurrency(residual, { symbol, decimals })}: escrow +
                    premiums − payouts) is withdrawable now.
                  </>
                ) : (
                  <>
                    Unlocks {countdown(s.redeemEnd, now)} (after the claim
                    window closes {formatTimestamp(s.redeemEnd)}). Whatever
                    holders never claim returns to you with your premiums.
                  </>
                )}
              </span>
            </div>
          ) : (
            <p className="font-parkBody text-xs text-surface-grey-2">
              Residual withdrawn:{" "}
              {formatCurrency(s.withdrawn, { symbol, decimals })} returned to
              you.
            </p>
          )}
          <TxStatus state={withdrawTx.state} label="Withdraw" />
        </div>
      )}
    </Card>
  );
}

export function Underwrite() {
  const { deployment } = useActiveDeployment();
  const { symbol, decimals } = deployment.currency;
  const { rows, isLoading, rpcError } = useSeriesIndex();
  const { address, isConnected, chainId } = useAccount();
  const { balance, allowance, refetch: refetchCurrency } = useWalletCurrency();
  const wrongNetwork = isConnected && chainId !== deployment.chainId;

  const [strikeLowInput, setStrikeLowInput] = useState("");
  const [strikeHighInput, setStrikeHighInput] = useState("");
  const [rateInput, setRateInput] = useState("");
  const [saleEndInput, setSaleEndInput] = useState("");
  const [obsStartInput, setObsStartInput] = useState("");
  const [obsEndInput, setObsEndInput] = useState("");
  const [redeemEndInput, setRedeemEndInput] = useState("");
  const [capacityInput, setCapacityInput] = useState("");
  const [createdId, setCreatedId] = useState<bigint | undefined>(undefined);

  const approveTx = useTx({ label: "Approve escrow" });
  const createTx = useTx({ label: "Create market" });

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

  // Client-side mirror of every on-chain createSeries rule, with copy that
  // explains WHY each rule exists (the contract reverts with InvalidParams).
  const createValidation = useMemo<string | null>(() => {
    if (!createFilled) return null;
    const now = nowSec();
    if (strikeLow === null)
      return "Strike low must be a positive $/SF value (two decimals max).";
    if (strikeHigh === null)
      return "Strike high must be a positive $/SF value (two decimals max).";
    if (strikeLow >= strikeHigh) {
      return "Strike low must be below strike high — the contract rejects an empty band (InvalidParams: strikes).";
    }
    if (rateBps === null)
      return "Premium rate must be a percentage between 0.01% and 100%.";
    if (
      saleEnd === null ||
      obsStart === null ||
      obsEnd === null ||
      redeemEnd === null
    ) {
      return "Fill every timestamp.";
    }
    if (saleEnd <= now) return "Sale end must be in the future.";
    if (saleEnd > obsStart) {
      return "Sales must close before the rent-reading window opens (saleEnd ≤ obsStart, enforced on-chain). Otherwise buyers could purchase after a qualifying rent print already exists — trading on a known outcome against your escrow.";
    }
    if (!(obsStart < obsEnd))
      return "Observation start must be before observation end.";
    if (!(obsEnd < redeemEnd))
      return "The claim window must open after the observation window closes.";
    if (redeemEnd < obsEnd + MIN_REDEEM_WINDOW) {
      return "The claim window must last at least 7 days after the observation window (MIN_REDEEM_WINDOW, enforced on-chain) — holders always get a real chance to settle and claim.";
    }
    if (capacity === null || capacity <= 0n)
      return "Capacity must be a positive amount.";
    if (balance !== undefined && capacity > balance) {
      return `You deposit the full capacity as escrow — ${formatCurrency(capacity, { symbol, decimals })} exceeds your balance of ${formatCurrency(balance, { symbol, decimals })}.`;
    }
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
    balance,
    symbol,
    decimals,
  ]);

  const needsApproval =
    capacity !== null &&
    capacity > 0n &&
    allowance !== undefined &&
    allowance < capacity;

  async function onApprove() {
    if (capacity === null) return;
    const r = await approveTx.send({
      abi: erc20Abi,
      address: deployment.currency.address,
      chainId: deployment.chainId,
      functionName: "approve",
      args: [deployment.pool, capacity],
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
      chainId: deployment.chainId,
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
      refetchCurrency();
      for (const log of r.receipt.logs) {
        if (log.address.toLowerCase() !== deployment.pool.toLowerCase())
          continue;
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

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Underwriting opens once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }

  if (rpcError && rows.length === 0 && !isLoading) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <header>
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Underwrite
          </h1>
        </header>
        <RpcDownState />
      </div>
    );
  }

  const yourSeries = address
    ? rows.filter(
        (r) => r.series.creator.toLowerCase() === address.toLowerCase(),
      )
    : [];

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Underwrite
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Anyone can be the other side of this market: deposit money as
          escrow, set the terms, sell protection, keep the premiums. No
          permission needed — there are no roles in the contract at all.
        </p>
      </header>

      {rpcError ? <RpcStaleBanner /> : null}

      {/* underwriting explained */}
      <Card>
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheckIcon size={24} className="text-core-green" />
          <h2 className="font-parkDisplay font-bold text-lg">
            How underwriting works
          </h2>
        </div>
        <ul className="font-parkBody text-sm text-surface-grey-2 space-y-1.5 list-disc pl-5">
          <li>
            Your escrow backs your market 1:1 — buyers can never be sold more
            protection than you deposited, so claims are always payable.
          </li>
          <li>
            Claims are paid ONLY from your own market' escrow. Other market
            can never touch your money, and you can never touch theirs.
          </li>
          <li>
            After the claim window closes, whatever wasn't claimed comes back
            to you — escrow residual plus every premium buyers paid.
          </li>
          <li>
            Your levers: pause your market' sales, top up capacity before the
            sale ends, cancel while nothing has sold (full refund), and
            withdraw the residual at the end. Nothing else — terms are
            immutable once created.
          </li>
        </ul>
      </Card>

      {!isConnected ? (
        <Card>
          <p className="font-parkBody text-sm text-surface-grey-2">
            Connect a wallet to create a market or manage the ones you've
            underwritten. Viewing needs no wallet.
          </p>
        </Card>
      ) : null}

      {/* create form */}
      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-1">
          Create a market
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 mb-4">
          Terms are immutable once created — no setter exists at all. The
          index your market settles on tracks Manhattan office rent
          (commercial, not residential).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Strike low ($/SF)" hint="payout starts above this">
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
          <Field label="Strike high ($/SF)" hint="full payout at or above this">
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
          <Field
            label="Premium rate (% of protection sold)"
            hint="what buyers pay you, once, up front"
          >
            <input
              type="text"
              inputMode="decimal"
              value={rateInput}
              onChange={(e) => {
                setRateInput(e.target.value);
                createTx.reset();
              }}
              placeholder="11.33"
              data-testid="create-rate"
              className={inputCls}
            />
          </Field>
          <Field
            label={`Capacity (${symbol})`}
            hint="YOU DEPOSIT THIS — escrowed 1:1 until the market ends"
          >
            <input
              type="text"
              inputMode="decimal"
              value={capacityInput}
              onChange={(e) => {
                setCapacityInput(e.target.value);
                approveTx.reset();
                createTx.reset();
              }}
              placeholder="0.02"
              data-testid="create-capacity"
              className={inputCls}
            />
          </Field>
          <Field
            label="Sale ends"
            hint="must be before the rent-reading window opens"
          >
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
          <Field
            label="Claims until"
            hint="at least 7 days after observation ends (on-chain rule)"
          >
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

        {capacity !== null && capacity > 0n && createValidation === null ? (
          <p
            className="mt-3 font-parkBody text-sm font-bold text-text-standard border-l-4 border-core-green pl-3 py-1"
            data-testid="create-escrow-note"
          >
            You deposit{" "}
            <span className="text-core-green">
              {formatCurrency(capacity, { symbol, decimals })}
            </span>{" "}
            as escrow when you create this market. It backs every claim 1:1
            and returns to you (plus premiums, minus payouts) after the claim
            window.
          </p>
        ) : null}

        {createValidation ? (
          <p
            className="mt-3 font-parkBody text-sm text-system-red font-bold"
            role="alert"
            data-testid="create-validation"
          >
            {createValidation}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-3">
          {needsApproval ? (
            <>
              <StatRow
                label="Current allowance"
                value={`${formatCurrency(allowance, { symbol, decimals })} — approving ${formatCurrency(capacity, { symbol, decimals })}`}
              />
              <Button
                app="fund"
                variant="secondary"
                disabled={
                  !isConnected ||
                  wrongNetwork ||
                  createValidation !== null ||
                  capacity === null ||
                  busyTx(approveTx)
                }
                onClick={onApprove}
                data-testid="approve-button"
              >
                1 · Approve {symbol} escrow
              </Button>
              <TxStatus state={approveTx.state} label="Approve" />
            </>
          ) : null}
          <Button
            app="fund"
            disabled={
              !isConnected ||
              wrongNetwork ||
              !createFilled ||
              createValidation !== null ||
              needsApproval ||
              busyTx(createTx)
            }
            onClick={onCreateSeries}
            data-testid="create-series-button"
          >
            {needsApproval ? "2 · " : ""}Create market & deposit escrow
          </Button>
          <TxStatus state={createTx.state} label="Create" />
          {createTx.state.status === "confirmed" && createdId !== undefined ? (
            <p className="font-parkBody text-sm text-system-green">
              Market #{createdId.toString()} created — your escrow is
              deposited and the sale is live.
            </p>
          ) : null}
        </div>
      </Card>

      {/* your series */}
      <section className="space-y-4">
        <h2 className="font-parkDisplay font-bold text-xl text-text-standard">
          Your market
        </h2>
        {!isConnected ? (
          <p className="font-parkBody text-sm text-surface-grey-2">
            Connect to see the market you've underwritten.
          </p>
        ) : isLoading ? (
          <Card>
            <LoadingSkeleton lines={3} />
          </Card>
        ) : yourSeries.length === 0 ? (
          <EmptyState title="No market underwritten by this wallet yet">
            Create one above — the escrow, terms and premiums are all yours.
          </EmptyState>
        ) : (
          yourSeries.map((row) => <YourSeriesCard key={row.id} row={row} />)
        )}
      </section>
    </div>
  );
}
