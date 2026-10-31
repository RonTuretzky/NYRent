/**
 * Shared pieces of the neighborhood-policy pages: chain constants from the
 * registry, data hooks that refetch on their own, the wallet gate (connect and
 * inline network switch), the funded-action step (balance, gas, approve) and
 * the small explanatory components every page repeats.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { type Address } from "viem";
import { useAccount, useBalance, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Button } from "@decentralpark/ui";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  APARTMENTS_CHAIN_ID,
  APARTMENTS_POOL,
  APARTMENTS_TOKEN,
  CURRENCY_DECIMALS,
  POLICY_CURRENCY,
  claimTokenAbi,
  policyCurrencyAbi,
} from "../../chain/apartments";
import { apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { isNetworkError } from "../../chain/errors";
import { DEPLOYMENTS } from "../../chain/registry";
import { chainById } from "../../chain/wagmi";
import { formatCurrency, formatTimestamp, nowSec } from "../../chain/format";
import { useTx, type TxState } from "../../chain/useTx";
import { Card, EmptyState, LoadingSkeleton } from "../../components/States";
import { TxStatus } from "../../components/TxStatus";
import { humanDelta, policyDates, policyError, type JourneyStep, type PolicyRow } from "../../lib/policy";
import catalog from "../../data/apartments-series.json";

export const chainId = APARTMENTS_CHAIN_ID;
export const pool = APARTMENTS_POOL as Address;
const deployment = DEPLOYMENTS[chainId];
export const symbol = deployment?.currency.symbol ?? "";
export const networkName = deployment?.name ?? `chain ${chainId}`;
export const nativeSymbol = chainById(chainId)?.nativeCurrency.symbol ?? "ETH";
export const explorerBase = deployment?.explorerBase ?? "";

export const inputClass =
  "w-full min-h-11 rounded-lg border-2 border-paper-2 focus:border-core-green focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-core-green px-3 py-2 font-parkBody bg-paper-0 text-base";

export const REFETCH_MS = 12_000;

export function money(wei: bigint) {
  return formatCurrency(wei, { decimals: CURRENCY_DECIMALS, symbol });
}

export function neighborhood(slug: string) {
  return catalog.series.find((s) => s.slug === slug);
}

export function txBusy(state: TxState) {
  return state.status === "simulating" || state.status === "wallet" || state.status === "pending";
}

/** Policy-language error rewrite for every useTx on these pages. */
export const txOpts = { transformError: (e: Parameters<typeof policyError>[0]) => policyError(e, nativeSymbol) };

/** A clock that ticks so sale and claim windows flip without a reload. */
export function useNow(intervalMs = 15_000): bigint {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Serialises an async click handler: a second click while one runs is ignored. */
export function useLock() {
  const busy = useRef(false);
  return useCallback(async (fn: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remembers the last defined value, so a page keeps showing real data (with a
 * stale banner) when a background refetch fails. Multicall reads with
 * allowFailure return per-call failures on a transport outage instead of
 * throwing, so react-query alone would not keep the previous data for them.
 */
export function useLastGood<T>(value: T | undefined): T | undefined {
  const [last, setLast] = useState(value);
  useEffect(() => {
    if (value !== undefined) setLast(value);
  }, [value]);
  return value ?? last;
}

type ReadFailure = { status: "failure"; error: Error };

/** True when a per-call failure is the RPC being unreachable rather than a revert. */
export function isTransportFailure(result: { status: string; error?: unknown } | undefined): boolean {
  return result?.status === "failure" && isNetworkError((result as ReadFailure).error);
}

export function useSeries(id: bigint | null) {
  const read = useReadContracts({
    contracts: [
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "series", args: [id ?? 0n] },
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesSlug", args: [id ?? 0n] },
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesPaused", args: [id ?? 0n] },
    ],
    query: { enabled: Boolean(APARTMENTS_POOL) && id !== null, refetchInterval: REFETCH_MS },
  });
  const row = read.data?.[0];
  const fresh = row?.status === "success"
    ? {
        series: row.result as unknown as PolicyRow,
        slug: read.data?.[1]?.status === "success" ? (read.data[1].result as string) : undefined,
        paused: read.data?.[2]?.status === "success" ? Boolean(read.data[2].result) : false,
      }
    : undefined;
  const good = useLastGood(fresh);
  const network = read.isError || isTransportFailure(row);
  return {
    series: good?.series,
    slug: good?.slug,
    paused: good?.paused ?? false,
    /** The call reverted (InvalidSeries): the id is beyond the contract's range. */
    notFound: row?.status === "failure" && !network,
    refetch: read.refetch,
    isLoading: read.isLoading,
    rpcDown: network && !good,
    stale: network && Boolean(good),
  };
}

export function useClaims(id: bigint | null) {
  const { address } = useAccount();
  return useReadContract({
    address: APARTMENTS_TOKEN as Address, abi: claimTokenAbi, chainId, functionName: "balanceOf",
    args: address && id !== null ? [address, id] : undefined,
    query: { enabled: Boolean(APARTMENTS_TOKEN && address && id !== null), refetchInterval: REFETCH_MS },
  });
}

export type FundsStage = "connect" | "network" | "loading" | "noGas" | "noFunds" | "approve" | "ready";

/** Everything the funded-action step needs, plus which stage the user is on. */
export function useWalletFunds(need: bigint) {
  const account = useAccount();
  const address = account.address;
  const balance = useReadContract({
    address: POLICY_CURRENCY, abi: policyCurrencyAbi, chainId, functionName: "balanceOf", args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: REFETCH_MS },
  });
  const allowance = useReadContract({
    address: POLICY_CURRENCY, abi: policyCurrencyAbi, chainId, functionName: "allowance", args: address ? [address, pool] : undefined,
    query: { enabled: Boolean(address), refetchInterval: REFETCH_MS },
  });
  const native = useBalance({ address, chainId, query: { enabled: Boolean(address), refetchInterval: REFETCH_MS } });
  const refetch = useCallback(() => Promise.all([balance.refetch(), allowance.refetch(), native.refetch()]), [balance, allowance, native]);

  let stage: FundsStage;
  if (!address) stage = "connect";
  else if (account.chainId !== chainId) stage = "network";
  else if (balance.data === undefined || allowance.data === undefined || native.data === undefined) stage = "loading";
  else if (native.data.value === 0n) stage = "noGas";
  else if (need > 0n && balance.data < need) stage = "noFunds";
  else if (need > 0n && allowance.data < need) stage = "approve";
  else stage = "ready";

  return {
    address,
    stage,
    balance: balance.data,
    allowance: allowance.data,
    native: native.data?.value,
    shortfall: need - (balance.data ?? 0n),
    rpcDown: (balance.isError || allowance.isError || native.isError) && balance.data === undefined,
    refetch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation
// ─────────────────────────────────────────────────────────────────────────────

export function NotDeployed() {
  return <EmptyState title="Not deployed yet">Neighborhood policies open once the contracts are live.</EmptyState>;
}

/** "You are on step N of M" with every step named. */
export function StepBar({ steps, current, title }: { steps: JourneyStep[]; current: number; title: string }) {
  const idx = Math.min(Math.max(current, 1), steps.length);
  return (
    <nav aria-label={`${title} progress`} className="min-w-0" data-testid="step-bar" data-step={idx}>
      <p className="font-parkBody text-sm">
        <span className="font-bold">Step {idx} of {steps.length}:</span> {steps[idx - 1].title}
      </p>
      <ol className="mt-2 flex gap-1.5" aria-label="Steps">
        {steps.map((s, i) => {
          const n = i + 1;
          const state = n < idx ? "done" : n === idx ? "current" : "todo";
          return (
            <li
              key={s.title}
              aria-current={state === "current" ? "step" : undefined}
              title={`${n}. ${s.title}`}
              className={`h-2 flex-1 rounded-full ${state === "done" ? "bg-core-green" : state === "current" ? "bg-primary-pine" : "bg-paper-2"}`}
            >
              <span className="sr-only">{n}. {s.title}{state === "done" ? " (done)" : state === "current" ? " (current)" : ""}</span>
            </li>
          );
        })}
      </ol>
      <p className="font-parkBody text-sm text-surface-grey-2 mt-2" data-testid="step-next">
        <span className="font-bold text-text-standard">Next:</span> {steps[idx - 1].detail}
      </p>
    </nav>
  );
}

export function Notice({ children, tone = "info", testId }: { children: ReactNode; tone?: "info" | "warn" | "error" | "ok"; testId?: string }) {
  const cls = tone === "error" ? "bg-red-0 text-red-main border-red-main/30"
    : tone === "warn" ? "bg-system-warning/10 border-system-warning/40"
    : tone === "ok" ? "bg-green-0 border-core-green/40"
    : "bg-paper-1 border-paper-2";
  return (
    <div role={tone === "error" || tone === "warn" ? "alert" : "status"} data-testid={testId}
      className={`rounded-lg border-2 px-3 py-2.5 font-parkBody text-sm leading-relaxed break-words ${cls}`}>
      {children}
    </div>
  );
}

/** Stated before anyone commits money. */
export function RiskNotice({ side }: { side: "buy" | "create" }) {
  return (
    <Notice tone="warn" testId="risk-notice">
      <p className="font-bold flex items-center gap-1.5"><WarningCircleIcon size={18} weight="fill" />Read before you {side === "buy" ? "pay" : "escrow"}</p>
      <ul className="list-disc pl-5 mt-1 space-y-1">
        <li>The contracts are <strong>unaudited</strong> and <strong>cannot be changed</strong>, so nobody can fix a mistake or return funds.</li>
        <li>The rent is one publisher's headline figure (Apartments.com, relayed in a Google Alert email). It can be wrong or change, and no one checks it.</li>
        <li>It does <strong>not</strong> pay based on your own lease or what you actually pay. It pays only on that headline number.</li>
        <li>This is not insurance and nothing is guaranteed. Only use money you can afford to lose.</li>
      </ul>
    </Notice>
  );
}

export function KeyDates({ series, now }: { series: Pick<PolicyRow, "saleEnd" | "finalizeAt" | "redeemEnd" | "obsMonth">; now: bigint }) {
  return (
    <ol className="space-y-2" data-testid="key-dates">
      {policyDates(series).map((d) => (
        <li key={d.label} className="grid grid-cols-[auto_1fr] gap-x-3 items-baseline">
          <span className="font-parkBody text-sm font-bold whitespace-nowrap">{d.label}</span>
          <span className="font-parkBody text-sm break-words">{formatTimestamp(d.at)} <span className="text-surface-grey-2">({humanDelta(d.at, now)})</span></span>
          <span className="col-start-2 font-parkBody text-xs text-surface-grey-2 leading-relaxed">{d.note}</span>
        </li>
      ))}
    </ol>
  );
}

export function GuideLink({ tab, children }: { tab: "renter" | "creator" | "record"; children: ReactNode }) {
  return <Link className="underline font-bold text-core-green inline-flex min-h-11 items-center" to={`/policies/guide?tab=${tab}`}>{children}</Link>;
}

/**
 * Connect and network gate: an unconnected visitor gets a connect button with
 * a reason, a wallet on another network gets an inline switch button (the
 * header banner compares against the header's chain, not this one).
 */
export function WalletGate({ children, why }: { children: ReactNode; why: string }) {
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending, error } = useSwitchChain();
  if (!account.address) {
    return (
      <div className="space-y-2" data-testid="wallet-gate-connect">
        <p className="font-parkBody text-sm">Connect a wallet {why}. A wallet is the app that holds your {symbol} and signs your approval.</p>
        <Button onClick={() => openConnectModal?.()} data-testid="connect-wallet">Connect wallet</Button>
      </div>
    );
  }
  if (account.chainId !== chainId) {
    return (
      <div className="space-y-2" data-testid="wallet-gate-network" role="alert">
        <p className="font-parkBody text-sm">
          Your wallet is on a different network. Policies live on <strong>{networkName}</strong>, so the wallet has to be there too; switching costs nothing.
        </p>
        <Button onClick={() => switchChain({ chainId })} isLoading={isPending} data-testid="switch-network">Switch to {networkName}</Button>
        {error ? <p className="font-parkBody text-xs">The wallet refused the switch. Open it and pick {networkName} yourself, then come back.</p> : null}
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * The step before any action that pulls {symbol}: shows the exact shortfall,
 * a missing gas balance, or the approve button with an explanation, and only
 * then renders `children` (the real action). Refetches the allowance after
 * approving so the next button appears without a reload.
 */
export function FundedAction({ need, funds, what, children }: {
  need: bigint;
  funds: ReturnType<typeof useWalletFunds>;
  /** "the premium" / "your escrow" */
  what: string;
  children: ReactNode;
}) {
  const approve = useTx({ label: `Approve ${symbol}` });
  const lock = useLock();
  if (funds.stage === "loading") return <LoadingSkeleton lines={2} />;
  if (funds.stage === "noGas") {
    return (
      <Notice tone="warn" testId="no-gas">
        <p className="font-bold">Your wallet has no {nativeSymbol} on {networkName}.</p>
        <p className="mt-1">Every transaction pays a small network fee in {nativeSymbol}, even when you are spending {symbol}. A few dollars' worth covers many transactions. <GuideLink tab="renter">How to get {symbol} and {nativeSymbol} here</GuideLink>.</p>
      </Notice>
    );
  }
  if (funds.stage === "noFunds") {
    const none = (funds.balance ?? 0n) === 0n;
    return (
      <Notice tone="warn" testId="no-funds">
        <p className="font-bold">{none ? `You have no ${symbol} in this wallet.` : `You need ${money(funds.shortfall)} more.`}</p>
        <p className="mt-1">
          {what[0].toUpperCase() + what.slice(1)} is {money(need)}{none ? "" : ` and this wallet holds ${money(funds.balance ?? 0n)}`}. Send {symbol} to this wallet on {networkName}, and the button appears here as soon as it lands. <GuideLink tab="renter">How to get {symbol} on {networkName}</GuideLink>.
        </p>
      </Notice>
    );
  }
  if (funds.stage === "approve") {
    const busy = txBusy(approve.state);
    return (
      <div className="space-y-2" data-testid="approve-step">
        <p className="font-parkBody text-sm">
          <strong>First, approve.</strong> This tells the {symbol} contract that the policy contract may take exactly {money(need)} from your wallet in the next step. It moves nothing by itself and costs only a network fee.
        </p>
        <Button
          data-testid="approve-button"
          disabled={busy}
          isLoading={busy}
          showChildrenWhenLoading
          onClick={() => void lock(async () => {
            const r = await approve.send(
              { abi: policyCurrencyAbi, address: POLICY_CURRENCY, chainId, functionName: "approve", args: [pool, need], account: funds.address },
              txOpts,
            );
            if (r.status === "confirmed") await funds.refetch();
          })}
        >
          {busy ? "Approving…" : `Approve ${money(need)}`}
        </Button>
        <TxStatus state={approve.state} />
        {approve.state.status === "reverted" && <p className="font-parkBody text-xs">Nothing was charged. Fix the cause above and click Approve again; it will not send twice.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {need > 0n && funds.stage === "ready" && (
        <p className="font-parkBody text-sm flex items-center gap-1.5 text-core-green" data-testid="approved-ok"><CheckCircleIcon size={18} weight="fill" />Approved. Your {symbol} stays in your wallet until you confirm the next step.</p>
      )}
      {children}
    </div>
  );
}

export function SkeletonCard({ lines = 4 }: { lines?: number }) {
  return <Card><LoadingSkeleton lines={lines} /></Card>;
}

export function ActionFailureHint({ state }: { state: TxState }) {
  if (state.status === "reverted") {
    return <p className="font-parkBody text-xs text-surface-grey-2" data-testid="retry-hint">Nothing happened on-chain unless a transaction link is shown. The page refreshed its numbers; you can try again, and a retry never sends twice.</p>;
  }
  if (state.status === "stillPending") {
    return <p className="font-parkBody text-xs text-surface-grey-2" data-testid="still-pending-hint">Your wallet already sent this. Do not send it again: open the link to watch it, then refresh this page.</p>;
  }
  return null;
}
