import { Link, useParams } from "react-router-dom";
import { Button } from "@decentralpark/ui";
import {
  useCoverBalance,
  useCurrencyMeta,
  useObservations,
  usePoolStats,
  useSeries,
} from "../chain/hooks";
import { isDeployed } from "../chain/deployment";
import { CapacityBar, SolvencyBar } from "../components/Bars";
import { PayoutCurve } from "../components/PayoutCurve";
import { SeriesTimeline } from "../components/Timeline";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  RpcStaleBanner,
  StatRow,
} from "../components/States";
import { AccountingCard } from "../components/Accounting";
import { PricingPanel } from "../components/PricingPanel";
import { PhaseBadge } from "./SeriesList";
import { seriesPhase } from "../chain/types";
import {
  formatBps,
  formatCents,
  formatCurrency,
  formatRatioWad,
  formatTimestamp,
  nowSec,
  truncateHex,
} from "../chain/format";

export function SeriesDetail() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : undefined;
  const { series: s, isLoading, rpcError } = useSeries(seriesId);
  const { stats } = usePoolStats();
  const { symbol, decimals } = useCurrencyMeta();
  const { balance: coverBalance } = useCoverBalance(seriesId);
  const { observations } = useObservations();
  const now = nowSec();

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Series data will appear once contracts are live.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid series id" />;
  }
  if (isLoading) {
    return (
      <Card className="max-w-4xl mx-auto">
        <LoadingSkeleton lines={6} />
      </Card>
    );
  }
  // Full-page outage state only when nothing is cached — a transient refetch
  // failure keeps the rendered page with a slim stale banner instead.
  if (!s && rpcError) {
    return (
      <div className="max-w-4xl mx-auto">
        <RpcDownState />
      </div>
    );
  }
  if (!s) {
    return (
      <EmptyState title={`Series #${seriesId} not found`}>
        Nothing is stored at this id in the pool.
      </EmptyState>
    );
  }

  const phase = seriesPhase(s, now);
  const settledCents = s.settled
    ? s.strikeLowCents +
      Math.round(
        (Number(s.payoutRatioWad) / 1e18) *
          (s.strikeHighCents - s.strikeLowCents),
      )
    : undefined;
  const settlementObs = s.settled
    ? observations.find((o) => o.emailId === s.emailId)
    : undefined;
  const qualifying = observations.filter(
    (o) => o.t >= s.obsStart && o.t <= s.obsEnd,
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {rpcError ? <RpcStaleBanner /> : null}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Series #{seriesId}
          </h1>
          <p className="font-parkBody text-surface-grey-2">
            {formatCents(s.strikeLowCents)} → {formatCents(s.strikeHighCents)}{" "}
            · premium {formatBps(s.premiumRateBps)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <PhaseBadge phase={phase} />
        </div>
      </header>

      {/* actions */}
      <div className="flex flex-wrap gap-3">
        <Link to={`/buy/${seriesId}`}>
          <Button app="fund" disabled={now > s.saleEnd}>
            Buy protection
          </Button>
        </Link>
        <Link to={`/settle/${seriesId}`}>
          <Button app="fund" variant="secondary" disabled={s.settled}>
            {s.settled ? "Settled" : "Settle with email"}
          </Button>
        </Link>
        <Link to={`/redeem/${seriesId}`}>
          <Button
            app="fund"
            variant="positive"
            disabled={!s.settled || now > s.redeemEnd}
          >
            Redeem
          </Button>
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Card>
          <h2 className="font-parkDisplay font-bold text-lg mb-3">
            Payout curve
          </h2>
          <PayoutCurve
            lowCents={s.strikeLowCents}
            highCents={s.strikeHighCents}
            settledCents={settledCents}
            ratioWad={s.settled ? s.payoutRatioWad : undefined}
          />
          {!s.settled ? (
            <p className="font-parkBody text-xs text-surface-grey mt-2">
              Not settled yet — the dot appears once an in-window email settles
              this series.
            </p>
          ) : null}
        </Card>

        <Card>
          <h2 className="font-parkDisplay font-bold text-lg mb-3">Lifecycle</h2>
          <SeriesTimeline series={s} />
        </Card>

        <Card>
          <h2 className="font-parkDisplay font-bold text-lg mb-3">
            Capacity & solvency
          </h2>
          <div className="space-y-5">
            <CapacityBar sold={s.sold} capacity={s.capacity} symbol={symbol} />
            {stats.reserved !== undefined && stats.balance !== undefined ? (
              <SolvencyBar
                reserved={stats.reserved}
                balance={stats.balance}
                symbol={symbol}
              />
            ) : (
              <LoadingSkeleton lines={1} />
            )}
          </div>
        </Card>

        <Card>
          <h2 className="font-parkDisplay font-bold text-lg mb-3">Terms</h2>
          <StatRow
            label="Strikes"
            value={`${formatCents(s.strikeLowCents)} / ${formatCents(s.strikeHighCents)}`}
          />
          <StatRow label="Premium rate" value={formatBps(s.premiumRateBps)} />
          <StatRow label="Sale ends" value={formatTimestamp(s.saleEnd)} />
          <StatRow
            label="Observation window"
            value={`${formatTimestamp(s.obsStart)} → ${formatTimestamp(s.obsEnd)}`}
          />
          <StatRow label="Redeem until" value={formatTimestamp(s.redeemEnd)} />
          <StatRow
            label="Capacity"
            value={formatCurrency(s.capacity, { symbol })}
          />
          <StatRow label="Sold" value={formatCurrency(s.sold, { symbol })} />
          {s.settled ? (
            <>
              <StatRow
                label="Payout ratio"
                value={formatRatioWad(s.payoutRatioWad)}
              />
              <StatRow
                label="Observation time"
                value={formatTimestamp(s.observationT)}
              />
              <StatRow label="Email id" value={truncateHex(s.emailId)} mono />
            </>
          ) : null}
          {coverBalance !== undefined && coverBalance > 0n ? (
            <StatRow
              label="Your cover"
              value={formatCurrency(coverBalance, { symbol: `max-claim ${symbol}` })}
            />
          ) : null}
        </Card>

        {s.settled ? (
          <AccountingCard
            entries={[{ id: seriesId, series: s }]}
            symbol={symbol}
            decimals={decimals}
          />
        ) : null}
      </div>

      <PricingPanel
        premiumRateBps={s.premiumRateBps}
        maxClaimWei={0n}
        decimals={decimals}
        symbol={symbol}
        strikeLowCents={s.strikeLowCents}
        strikeHighCents={s.strikeHighCents}
      />

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Oracle observations
        </h2>
        {observations.length === 0 ? (
          <EmptyState title="No observations recorded yet">
            Once someone submits an authentic CRE Daily snapshot email, it
            shows up here.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-parkBody text-sm">
              <thead>
                <tr className="text-left text-surface-grey-2 border-b border-paper-2">
                  <th className="py-2 pr-4">#</th>
                  <th className="py-2 pr-4">Signed at (t)</th>
                  <th className="py-2 pr-4">Value</th>
                  <th className="py-2 pr-4">Email id</th>
                  <th className="py-2">In window?</th>
                </tr>
              </thead>
              <tbody>
                {observations.map((o) => (
                  <tr key={o.index} className="border-b border-paper-1">
                    <td className="py-2 pr-4">{o.index}</td>
                    <td className="py-2 pr-4">{formatTimestamp(o.t)}</td>
                    <td className="py-2 pr-4 font-bold">
                      {formatCents(o.cents)} / SF
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {truncateHex(o.emailId, 6)}
                      {settlementObs?.index === o.index ? (
                        <span className="ml-2 text-sky-2 font-bold font-parkBody">
                          settled this series
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      {qualifying.some((q) => q.index === o.index) ? (
                        <span className="text-system-green font-bold">yes</span>
                      ) : (
                        <span className="text-surface-grey">no</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
