/**
 * Reading the pool's policies newest-first and rendering one as a card: shared
 * by the full list (/policies) and the home page preview.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useReadContract, useReadContracts } from "wagmi";
import { APARTMENTS_POOL } from "../../chain/apartments";
import { apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { formatCents } from "../../chain/format";
import { Card, LoadingSkeleton, StatRow } from "../../components/States";
import { monthLabel } from "../../lib/googleAlert";
import { policyStatus, type PolicyRow } from "../../lib/policy";
import { REFETCH_MS, chainId, isTransportFailure, money, neighborhood, pool, useLastGood } from "./shared";

export interface PolicyItem {
  id: bigint;
  series?: PolicyRow;
  slug?: string;
  paused: boolean;
}

/** The newest `limit` policies (all of them when omitted), refetching on their own. */
export function usePolicyRows(limit?: number) {
  const count = useReadContract({
    address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesCount",
    query: { enabled: Boolean(APARTMENTS_POOL), refetchInterval: REFETCH_MS },
  });
  const total = Number(count.data ?? 0n);
  const ids = useMemo(() => {
    const newestFirst = Array.from({ length: total }, (_, i) => BigInt(total - 1 - i));
    return limit === undefined ? newestFirst : newestFirst.slice(0, limit);
  }, [total, limit]);
  const rows = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "series", args: [id] } as const,
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesSlug", args: [id] } as const,
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesPaused", args: [id] } as const,
    ]),
    query: { enabled: ids.length > 0, refetchInterval: REFETCH_MS },
  });
  // A transport outage turns every multicall row into a failure; keep the last good set.
  const rowsFailed = rows.isError || Boolean(rows.data?.some((r) => isTransportFailure(r)));
  const goodRows = useLastGood(rowsFailed ? undefined : rows.data);
  const items: PolicyItem[] = ids.map((id, i) => ({
    id,
    series: goodRows?.[i * 3]?.result as unknown as PolicyRow | undefined,
    slug: goodRows?.[i * 3 + 1]?.result as string | undefined,
    paused: Boolean(goodRows?.[i * 3 + 2]?.result),
  }));
  return {
    total,
    items,
    isLoading: count.isLoading,
    rpcDown: count.isError && count.data === undefined,
    stale: (count.isError && count.data !== undefined) || (rowsFailed && goodRows !== undefined),
    refetch: count.refetch,
  };
}

/** One policy as a linked card; a skeleton until its row has loaded. */
export function PolicyCard({ item, now, testId }: { item: PolicyItem; now: bigint; testId: string }) {
  const { id, series, slug, paused } = item;
  if (!series || !slug) return <Card><LoadingSkeleton lines={5} /></Card>;
  const status = policyStatus(series, now, paused);
  const left = series.escrow - series.sold;
  return (
    <Link to={`/policies/${id}`} data-testid={testId} className="block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green">
      <Card className="hover:border-core-green h-full">
        <p className="font-parkDisplay font-bold text-xl break-words">{neighborhood(slug)?.geography ?? slug}</p>
        <p className="font-parkBody text-sm mb-2">
          {monthLabel(series.obsMonth)} · <span className="font-bold" data-testid="policy-status">{status.label}</span>
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
