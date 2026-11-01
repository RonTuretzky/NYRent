import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useReadContract, useReadContracts } from "wagmi";
import { Button } from "@decentralpark/ui";
import { APARTMENTS_POOL } from "../../chain/apartments";
import { apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { formatCents } from "../../chain/format";
import { Card, EmptyState, LoadingSkeleton, RpcDownState, RpcStaleBanner, StatRow } from "../../components/States";
import { monthLabel } from "../../lib/googleAlert";
import { policyStatus, type PolicyRow } from "../../lib/policy";
import { NotDeployed, REFETCH_MS, chainId, isTransportFailure, money, neighborhood, networkName, pool, symbol, useLastGood, useNow } from "./shared";

export function PolicyList() {
  const count = useReadContract({
    address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesCount",
    query: { enabled: Boolean(APARTMENTS_POOL), refetchInterval: REFETCH_MS },
  });
  const ids = useMemo(() => Array.from({ length: Number(count.data ?? 0n) }, (_, i) => BigInt(i)).reverse(), [count.data]);
  const rows = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "series", args: [id] } as const,
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesSlug", args: [id] } as const,
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesPaused", args: [id] } as const,
    ]),
    query: { enabled: ids.length > 0, refetchInterval: REFETCH_MS },
  });
  const now = useNow();
  // A transport outage turns every multicall row into a failure; keep the last good set.
  const rowsFailed = rows.isError || Boolean(rows.data?.some((r) => isTransportFailure(r)));
  const goodRows = useLastGood(rowsFailed ? undefined : rows.data);
  if (!APARTMENTS_POOL) return <NotDeployed />;
  const rpcDown = count.isError && count.data === undefined;
  const stale = (count.isError && count.data !== undefined) || (rowsFailed && goodRows !== undefined);
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 min-w-0">
      <div>
        <p className="font-parkBody font-bold">Permissionless rent protection on {networkName}</p>
        <h1 className="font-parkDisplay font-bold text-3xl sm:text-4xl mt-2">Neighborhood rent policies</h1>
        <p className="font-parkBody mt-4 leading-relaxed">
          Each policy names an Apartments.com neighborhood page and a month. Someone escrows {symbol} and sets a premium; renters
          buy protection; the first Google-signed alert of that month sets the headline rent, and the rent decides who gets paid.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/policies/guide"><Button>Step-by-step guide</Button></Link>
        <Link to="/policies/new"><Button variant="secondary">Create a policy</Button></Link>
        <Link to="/policies/submit"><Button variant="secondary">Record a rent</Button></Link>
      </div>
      <Card>
        <p className="font-parkBody text-sm leading-relaxed">
          These contracts are unaudited, ownerless and cannot be changed. This is not insurance and it does not pay based on your
          own lease: it pays on one publisher's headline figure. A policy that receives no qualifying email voids, so buyers get
          their premium back and the creator gets the escrow back. Only use money you can afford to lose.
        </p>
      </Card>
      {stale && <RpcStaleBanner />}
      {rpcDown ? <RpcDownState chainId={chainId} onRetry={() => void count.refetch()} /> : count.isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4" aria-busy="true">
          {[0, 1].map((i) => <Card key={i}><LoadingSkeleton lines={5} /></Card>)}
        </div>
      ) : ids.length === 0 ? (
        <EmptyState title="No policies yet">
          <p>Nobody has opened a policy on {networkName}. <Link className="underline font-bold text-core-green" to="/policies/new">Create the first one</Link> or read the <Link className="underline font-bold text-core-green" to="/policies/guide">guide</Link>.</p>
        </EmptyState>
      ) : (
        <ul className="grid sm:grid-cols-2 gap-4 list-none p-0 m-0">
          {ids.map((id, i) => {
            const series = goodRows?.[i * 3]?.result as unknown as PolicyRow | undefined;
            const slug = goodRows?.[i * 3 + 1]?.result as string | undefined;
            const paused = Boolean(goodRows?.[i * 3 + 2]?.result);
            if (!series || !slug) return <li key={String(id)}><Card><LoadingSkeleton lines={5} /></Card></li>;
            const status = policyStatus(series, now, paused);
            const left = series.escrow - series.sold;
            return (
              <li key={String(id)} className="min-w-0">
                <Link to={`/policies/${id}`} data-testid={`policy-${id}`} className="block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green">
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
