/**
 * Reading policies from both pools newest-first and rendering one as a card:
 * shared by the full list (/policies) and the home page preview. V2 policies
 * come first (every new policy goes there), then the V1 ones.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useReadContract, useReadContracts } from "wagmi";
import { APARTMENTS_ORACLE, POOL_V2, policyPoolAbi, type PolicyPool } from "../../chain/apartments";
import { apartmentsOracleAbi } from "../../chain/apartmentsAbi";
import { formatCents } from "../../chain/format";
import { Card, LoadingSkeleton, StatRow } from "../../components/States";
import { monthLabel } from "../../lib/googleAlert";
import { policyLabel, policyPath, policyStatus, type PolicyRow, type PoolVersion } from "../../lib/policy";
import { REFETCH_MS, chainId, isTransportFailure, money, neighborhood, useLastGood } from "./shared";

export interface PolicyItem {
  version: PoolVersion;
  pool: PolicyPool;
  id: bigint;
  series?: PolicyRow;
  slug?: string;
  paused: boolean;
  /** The oracle already holds this page's rent for the month. */
  recorded: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

function usePoolRows(pp: PolicyPool | null, limit?: number) {
  const address = pp?.address ?? ZERO;
  const count = useReadContract({
    address, abi: policyPoolAbi, chainId, functionName: "seriesCount",
    query: { enabled: Boolean(pp), refetchInterval: REFETCH_MS },
  });
  const total = pp ? Number(count.data ?? 0n) : 0;
  const ids = useMemo(() => {
    const newestFirst = Array.from({ length: total }, (_, i) => BigInt(total - 1 - i));
    return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
  }, [total, limit]);
  const rows = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address, abi: policyPoolAbi, chainId, functionName: "series", args: [id] } as const,
      { address, abi: policyPoolAbi, chainId, functionName: "seriesSlug", args: [id] } as const,
      { address, abi: policyPoolAbi, chainId, functionName: "seriesPaused", args: [id] } as const,
    ]),
    query: { enabled: ids.length > 0, refetchInterval: REFETCH_MS },
  });
  // A transport outage turns every multicall row into a failure; keep the last good set.
  const rowsFailed = rows.isError || Boolean(rows.data?.some((r) => isTransportFailure(r)));
  const goodRows = useLastGood(rowsFailed ? undefined : rows.data);
  const series = ids.map((_, i) => goodRows?.[i * 3]?.result as unknown as PolicyRow | undefined);
  // Whether each policy's month already has a recorded rent (stops V2 sales).
  const earliest = useReadContracts({
    contracts: series.map((s) => ({
      address: (APARTMENTS_ORACLE ?? ZERO), abi: apartmentsOracleAbi, chainId, functionName: "earliest",
      args: [s?.slugHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000", s?.obsMonth ?? 0],
    } as const)),
    query: { enabled: Boolean(APARTMENTS_ORACLE) && series.length > 0 && series.every(Boolean), refetchInterval: REFETCH_MS },
  });
  const items: PolicyItem[] = pp ? ids.map((id, i) => ({
    version: pp.version,
    pool: pp,
    id,
    series: series[i],
    slug: goodRows?.[i * 3 + 1]?.result as string | undefined,
    paused: Boolean(goodRows?.[i * 3 + 2]?.result),
    recorded: earliest.data?.[i]?.status === "success" ? (earliest.data[i].result as readonly [bigint, number, string])[0] !== 0n : false,
  })) : [];
  return {
    total,
    items,
    isLoading: Boolean(pp) && count.isLoading,
    rpcDown: Boolean(pp) && count.isError && count.data === undefined,
    stale: (count.isError && count.data !== undefined) || (rowsFailed && goodRows !== undefined),
    refetch: count.refetch,
  };
}

/** The newest `limit` policies (all of them when omitted), refetching on their own. */
export function usePolicyRows(limit?: number) {
  return usePoolRows(POOL_V2, limit);
}

/** One policy as a linked card; a skeleton until its row has loaded. */
export function PolicyCard({ item, now, testId }: { item: PolicyItem; now: bigint; testId: string }) {
  const { id, series, slug, paused, version, pool, recorded } = item;
  if (!series || !slug) return <Card><LoadingSkeleton lines={5} /></Card>;
  const status = policyStatus(series, now, paused, { rules: pool.rules, recorded });
  const left = series.escrow - series.sold;
  return (
    <Link to={policyPath(version, id)} data-testid={testId} className="block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green">
      <Card className="hover:border-core-green h-full">
        <p className="font-parkDisplay font-bold text-xl break-words">{neighborhood(slug)?.geography ?? slug}</p>
        <p className="font-parkBody text-sm mb-2">
          {monthLabel(series.obsMonth)} · <span className="text-surface-grey-2">Policy {policyLabel(version, id)}</span> · <span className="font-bold" data-testid="policy-status">{status.label}</span>
        </p>
        <StatRow label="Pays from" value={`${formatCents(series.strikeLowCents)}/mo`} />
        <StatRow label="Full payout at" value={`${formatCents(series.strikeHighCents)}/mo`} />
        <StatRow label="Premium" value={`${series.premiumRateBps / 100}% of max payout`} />
        <StatRow label="Still available" value={status.phase === "cancelled" ? "—" : money(left)} />
        <p className="font-parkBody text-xs text-surface-grey-2 mt-2 leading-relaxed">{status.next}</p>
      </Card>
    </Link>
  );
}

/** The testid a policy card carries: policy-12 for V2, policy-v1-0 for V1. */
export function cardTestId(prefix: string, item: PolicyItem): string {
  return item.version === "v1" ? `${prefix}-v1-${item.id}` : `${prefix}-${item.id}`;
}
