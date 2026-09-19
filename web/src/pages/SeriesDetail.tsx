import { Link, useParams } from "react-router-dom";
import { Button } from "@decentralpark/ui";
import {
  isStandardShape,
  useCoverUnits,
  useOracleObservations,
  useSeriesRow,
} from "../chain/poolHooks";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { addressUrl } from "../chain/explorer";
import { CapacityBar } from "../components/Bars";
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
import { PhaseBadge, StandardBadge } from "./SeriesList";
import { seriesPhase } from "../chain/types";
import {
  formatBps,
  formatCents,
  formatCurrency,
  formatRatioWad,
  formatTimestamp,
  nowSec,
  truncateAddress,
  truncateHex,
} from "../chain/format";

export function SeriesDetail() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : undefined;
  const { deployment } = useActiveDeployment();
  const { series: s, paused, isLoading, rpcError } = useSeriesRow(seriesId);
  const { balance: coverBalance } = useCoverUnits(seriesId);
  const { observations } = useOracleObservations();
  const now = nowSec();
  const { symbol, decimals } = deployment.currency;

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Market data will appear once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid market id" />;
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
      <EmptyState title={`Market #${seriesId} not found`}>
        Nothing is stored at this id in the pool on {deployment.name}.
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
  const residual =
    s.escrow + s.premiumsAccrued - s.paidOut - s.withdrawn;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {rpcError ? <RpcStaleBanner /> : null}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Market #{seriesId}
          </h1>
          <p className="font-parkBody text-surface-grey-2">
            Starts paying above {formatCents(s.strikeLowCents)}, pays in full
            at {formatCents(s.strikeHighCents)} · one-time price{" "}
            {formatBps(s.premiumRateBps)} of your protection amount
          </p>
          <p className="font-parkBody text-xs text-surface-grey mt-1">
            Underwritten by{" "}
            <a
              href={addressUrl(s.creator, deployment.explorerBase)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted font-mono"
            >
              {truncateAddress(s.creator)}
            </a>{" "}
            — every payout comes from the money they escrowed up front.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isStandardShape(s) ? <StandardBadge /> : null}
          {s.cancelled ? (
            <span className="font-parkBody text-xs font-bold rounded-full px-3 py-1 bg-paper-2 text-surface-grey">
              Cancelled
            </span>
          ) : paused ? (
            <span className="font-parkBody text-xs font-bold rounded-full px-3 py-1 bg-system-warning/15 text-system-warning">
              Paused by creator
            </span>
          ) : null}
          {!s.cancelled ? <PhaseBadge phase={phase} /> : null}
        </div>
      </header>

      {s.cancelled ? (
        <EmptyState title="This market was cancelled">
          Its creator cancelled it before anything sold; the escrow was
          refunded and nothing can be bought or claimed here.
        </EmptyState>
      ) : (
        <>
          {/* actions */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-3">
              <Link to={`/buy/${seriesId}`}>
                <Button
                  app="fund"
                  disabled={now > s.saleEnd || s.settled || paused}
                >
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
                  Claim payout
                </Button>
              </Link>
            </div>
            {paused && now <= s.saleEnd && !s.settled ? (
              <p className="font-parkBody text-xs text-system-warning font-bold">
                Sales are paused by the market creator right now. Settlement
                and payouts can never be paused.
              </p>
            ) : null}
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
                  Not settled yet — the dot appears once an in-window rent
                  reading settles this market.
                </p>
              ) : null}
            </Card>

            <Card>
              <h2 className="font-parkDisplay font-bold text-lg mb-3">
                Lifecycle
              </h2>
              <SeriesTimeline series={s} />
            </Card>

            <Card>
              <h2 className="font-parkDisplay font-bold text-lg mb-3">
                Capacity
              </h2>
              <div className="space-y-4">
                <CapacityBar
                  sold={s.sold}
                  capacity={s.escrow}
                  symbol={symbol}
                  decimals={decimals}
                />
                <p className="font-parkBody text-xs text-surface-grey-2">
                  The creator escrowed{" "}
                  {formatCurrency(s.escrow, { symbol, decimals })} up front, so
                  every unit of protection sold here is backed 1:1 by money
                  already in the contract. Nobody — not even the creator — can
                  take it out while claims are possible.
                </p>
              </div>
            </Card>

            <Card>
              <h2 className="font-parkDisplay font-bold text-lg mb-3">
                Market accounting
              </h2>
              <StatRow
                label="Escrow (backs all payouts)"
                value={formatCurrency(s.escrow, { symbol, decimals })}
              />
              <StatRow
                label="Protection sold"
                value={formatCurrency(s.sold, { symbol, decimals })}
              />
              <StatRow
                label="Premiums collected"
                value={formatCurrency(s.premiumsAccrued, { symbol, decimals })}
              />
              <StatRow
                label="Paid out to holders"
                value={formatCurrency(s.paidOut, { symbol, decimals })}
              />
              <StatRow
                label={
                  s.residualWithdrawn
                    ? "Returned to creator"
                    : "Residual (returns to creator after the claim window)"
                }
                value={formatCurrency(
                  s.residualWithdrawn ? s.withdrawn : residual,
                  { symbol, decimals },
                )}
              />
            </Card>

            <Card>
              <h2 className="font-parkDisplay font-bold text-lg mb-3">Terms</h2>
              <StatRow
                label="Pays from / in full at"
                value={`${formatCents(s.strikeLowCents)} / ${formatCents(s.strikeHighCents)}`}
              />
              <StatRow
                label="One-time price"
                value={`${formatBps(s.premiumRateBps)} of your protection amount`}
              />
              <StatRow label="Sale ends" value={formatTimestamp(s.saleEnd)} />
              <StatRow
                label="Rent reading window"
                value={`${formatTimestamp(s.obsStart)} → ${formatTimestamp(s.obsEnd)}`}
              />
              <StatRow
                label="Claim payouts until"
                value={formatTimestamp(s.redeemEnd)}
              />
              {s.settled ? (
                <>
                  <StatRow
                    label="Payout ratio"
                    value={formatRatioWad(s.payoutRatioWad)}
                  />
                  <StatRow
                    label="Rent reading time"
                    value={formatTimestamp(s.observationT)}
                  />
                  <StatRow
                    label="Email id"
                    value={truncateHex(s.emailId)}
                    mono
                  />
                </>
              ) : null}
              {coverBalance !== undefined && coverBalance > 0n ? (
                <StatRow
                  label="Your protection here"
                  value={formatCurrency(coverBalance, { symbol, decimals })}
                />
              ) : null}
              <p className="font-parkBody text-xs text-surface-grey mt-3">
                What settles this market: the average effective rent
                snapshot ($/SF) printed in CRE Daily's Market Snapshot
                newsletter, whose DKIM signature is verified on-chain.
              </p>
            </Card>
          </div>

          <Card>
            <h2 className="font-parkDisplay font-bold text-lg mb-3">
              Oracle observations
            </h2>
            {observations.length === 0 ? (
              <EmptyState title="No observations recorded yet">
                Once someone submits an authentic, cryptographically signed
                rent newsletter, its reading shows up here.
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
                              settled this market
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2">
                          {qualifying.some((q) => q.index === o.index) ? (
                            <span className="text-system-green font-bold">
                              yes
                            </span>
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
        </>
      )}
    </div>
  );
}
