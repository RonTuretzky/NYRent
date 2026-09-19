import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon,
  ChartLineUpIcon,
  SealCheckIcon,
} from "@phosphor-icons/react";
import {
  isStandardShape,
  useSeriesIndex,
  type SeriesRow,
} from "../chain/poolHooks";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { addressUrl } from "../chain/explorer";
import { CapacityBar } from "../components/Bars";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  RpcStaleBanner,
} from "../components/States";
import { seriesPhase, type SeriesPhase } from "../chain/types";
import {
  formatCents,
  formatBps,
  formatRatioWad,
  formatDate,
  nowSec,
  truncateAddress,
} from "../chain/format";

const PHASE_LABEL: Record<SeriesPhase, { label: string; cls: string }> = {
  sale: { label: "Sale open", cls: "bg-green-0 text-green-2" },
  observation: {
    label: "Observation window",
    cls: "bg-paper-2 text-surface-grey-2",
  },
  "awaiting-settlement": {
    label: "Awaiting settlement",
    cls: "bg-sky-0 text-sky-2",
  },
  settled: { label: "Settled", cls: "bg-sky-0 text-sky-2" },
  redeem: { label: "Redeem open", cls: "bg-pine-0 text-pine-2" },
  closed: { label: "Closed", cls: "bg-paper-2 text-surface-grey" },
};

export function PhaseBadge({ phase }: { phase: SeriesPhase }) {
  const p = PHASE_LABEL[phase];
  return (
    <span
      className={`font-parkBody text-xs font-bold rounded-full px-3 py-1 ${p.cls}`}
    >
      {p.label}
    </span>
  );
}

function Pill({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span
      className={`font-parkBody text-xs font-bold rounded-full px-3 py-1 ${cls}`}
    >
      {children}
    </span>
  );
}

/** 'standard' badge: the reference shape the market curates around. */
export function StandardBadge() {
  return (
    <Pill cls="border border-core-green text-core-green bg-paper-0">
      <SealCheckIcon size={12} weight="fill" className="inline -mt-0.5 mr-1" />
      standard
    </Pill>
  );
}

function capacityLeftOf(row: SeriesRow): bigint {
  return row.series.cancelled ? 0n : row.series.escrow - row.series.sold;
}

function SeriesCard({
  row,
  symbol,
  decimals,
  explorerBase,
  now,
}: {
  row: SeriesRow;
  symbol: string;
  decimals: number;
  explorerBase: string;
  now: bigint;
}) {
  const { id, series: s, paused } = row;
  const phase = seriesPhase(s, now);
  return (
    <Card
      className="transition-all hover:border-core-green hover:shadow-md"
      data-testid={`series-card-${id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="bg-green-0/40 text-green-2 h-11 w-11 rounded-xl flex items-center justify-center">
            <ChartLineUpIcon size={24} weight="bold" />
          </div>
          <div>
            <Link
              to={`/market/${id}`}
              className="font-parkDisplay font-bold text-lg text-text-standard hover:text-core-green"
            >
              Market #{id} · pays above {formatCents(s.strikeLowCents)}, full
              at {formatCents(s.strikeHighCents)}
            </Link>
            <p className="font-parkBody text-xs text-surface-grey-2">
              one-time price {formatBps(s.premiumRateBps)} of your protection
              amount · rent reading {formatDate(s.obsStart)} –{" "}
              {formatDate(s.obsEnd)}
              {s.settled
                ? ` · settled at ${formatRatioWad(s.payoutRatioWad)}`
                : ""}
            </p>
            <p className="font-parkBody text-xs text-surface-grey mt-0.5">
              Underwritten by{" "}
              <a
                href={addressUrl(s.creator, explorerBase)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted font-mono"
              >
                {truncateAddress(s.creator)}
              </a>{" "}
              — payouts come from their escrowed deposit.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isStandardShape(s) ? <StandardBadge /> : null}
          {s.cancelled ? (
            <Pill cls="bg-paper-2 text-surface-grey">Cancelled</Pill>
          ) : paused ? (
            <Pill cls="bg-system-warning/15 text-system-warning">
              Paused by creator
            </Pill>
          ) : null}
          {!s.cancelled ? <PhaseBadge phase={phase} /> : null}
          <Link to={`/market/${id}`} aria-label={`Open market ${id}`}>
            <ArrowRightIcon
              size={20}
              className="text-surface-grey hover:text-core-green transition-colors"
            />
          </Link>
        </div>
      </div>
      {!s.cancelled ? (
        <div className="mt-4">
          <CapacityBar
            sold={s.sold}
            capacity={s.escrow}
            symbol={symbol}
            decimals={decimals}
          />
        </div>
      ) : (
        <p className="font-parkBody text-xs text-surface-grey mt-3">
          Cancelled by its creator before anything sold — the escrow was
          refunded and nothing can be bought or claimed here.
        </p>
      )}
    </Card>
  );
}

export function SeriesList() {
  const { deployment } = useActiveDeployment();
  const { rows, isLoading, rpcError } = useSeriesIndex();
  const [showAll, setShowAll] = useState(false);
  const now = nowSec();
  const { symbol, decimals } = deployment.currency;
  const live = isLiveDeployment(deployment);

  // Curated default: open-for-sale series grouped by strike band, cheapest
  // first — the storefront view. "All series" shows the raw unfiltered list.
  const open = useMemo(
    () =>
      rows.filter(
        (r) =>
          !r.series.cancelled &&
          !r.series.settled &&
          !r.paused &&
          now <= r.series.saleEnd &&
          capacityLeftOf(r) > 0n,
      ),
    [rows, now],
  );

  const bands = useMemo(() => {
    const byBand = new Map<string, SeriesRow[]>();
    for (const r of open) {
      const key = `${r.series.strikeLowCents}-${r.series.strikeHighCents}`;
      const list = byBand.get(key) ?? [];
      list.push(r);
      byBand.set(key, list);
    }
    const groups = Array.from(byBand.values());
    for (const g of groups) {
      g.sort((a, b) => a.series.premiumRateBps - b.series.premiumRateBps);
    }
    groups.sort(
      (a, b) => a[0].series.premiumRateBps - b[0].series.premiumRateBps,
    );
    return groups;
  }, [open]);

  const activeRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          !r.series.cancelled && seriesPhase(r.series, now) !== "closed",
      ),
    [rows, now],
  );
  const closedRows = useMemo(
    () =>
      rows.filter(
        (r) => r.series.cancelled || seriesPhase(r.series, now) === "closed",
      ),
    [rows, now],
  );

  const toggle = (
    <div
      className="inline-flex rounded-full border-2 border-paper-2 bg-paper-0 p-0.5"
      role="group"
      aria-label="Market view"
    >
      {(
        [
          [false, "Open market"],
          [true, "All market"],
        ] as const
      ).map(([all, label]) => (
        <button
          key={label}
          type="button"
          aria-pressed={showAll === all}
          onClick={() => setShowAll(all)}
          data-testid={all ? "series-view-all" : "series-view-open"}
          className={`font-parkBody text-sm rounded-full px-4 py-1.5 transition-colors ${
            showAll === all
              ? "bg-core-green text-white font-bold"
              : "text-text-standard hover:text-core-green"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Protection market
          </h1>
          <p className="font-parkBody text-surface-grey-2 mt-1">
            Each market pays you when the reported rent index rises past its
            level. Pick one, or{" "}
            <Link to="/choose" className="underline decoration-dotted">
              let us help you choose
            </Link>
            .
          </p>
          <p className="font-parkBody text-xs text-surface-grey mt-1">
            The index behind every market tracks Manhattan office rent
            (commercial, not residential).
          </p>
        </div>
        {toggle}
      </header>

      {!live ? (
        <EmptyState title="No on-chain market yet">
          The contracts have not been deployed on {deployment.name} — market
          will appear here once real addresses are baked in.
        </EmptyState>
      ) : isLoading ? (
        <Card>
          <LoadingSkeleton lines={4} />
        </Card>
      ) : rpcError && rows.length === 0 ? (
        // Full-page outage state only when nothing is cached; a failed
        // background refetch keeps the last-good list plus a stale banner.
        <RpcDownState />
      ) : rows.length === 0 ? (
        <EmptyState title="No market yet — the market is open">
          Anyone can underwrite the first market: deposit the payout money as
          escrow, set the terms, earn the premiums.{" "}
          <Link to="/underwrite" className="underline">
            Start on the Underwrite page
          </Link>
          .
        </EmptyState>
      ) : !showAll ? (
        open.length === 0 ? (
          <EmptyState title="Nothing is on sale right now">
            {rows.length} market exist but none are currently open for
            purchase — check{" "}
            <button
              type="button"
              className="underline"
              onClick={() => setShowAll(true)}
            >
              all market
            </button>{" "}
            for settled and upcoming ones, or{" "}
            <Link to="/underwrite" className="underline">
              underwrite a new one
            </Link>{" "}
            yourself: anyone can.
          </EmptyState>
        ) : (
          <div className="space-y-6" data-testid="series-list">
            {rpcError ? <RpcStaleBanner /> : null}
            {bands.map((group) => {
              const s0 = group[0].series;
              return (
                <section
                  key={`${s0.strikeLowCents}-${s0.strikeHighCents}`}
                  className="space-y-3"
                >
                  <h2 className="font-parkDisplay font-bold text-sm text-surface-grey-2 uppercase tracking-wide">
                    Pays from {formatCents(s0.strikeLowCents)} to{" "}
                    {formatCents(s0.strikeHighCents)} — cheapest first
                  </h2>
                  {group.map((row) => (
                    <SeriesCard
                      key={row.id}
                      row={row}
                      symbol={symbol}
                      decimals={decimals}
                      explorerBase={deployment.explorerBase}
                      now={now}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )
      ) : (
        <div className="space-y-4" data-testid="series-list">
          {rpcError ? <RpcStaleBanner /> : null}
          {activeRows.map((row) => (
            <SeriesCard
              key={row.id}
              row={row}
              symbol={symbol}
              decimals={decimals}
              explorerBase={deployment.explorerBase}
              now={now}
            />
          ))}
          {closedRows.length > 0 ? (
            <details
              className="border-2 border-paper-2 rounded-2xl bg-paper-0"
              data-testid="closed-series"
            >
              <summary className="font-parkBody text-sm font-bold text-surface-grey-2 cursor-pointer px-5 py-3">
                Settled, closed & cancelled ({closedRows.length})
              </summary>
              <div className="space-y-4 px-5 pb-5">
                {closedRows.map((row) => (
                  <SeriesCard
                    key={row.id}
                    row={row}
                    symbol={symbol}
                    decimals={decimals}
                    explorerBase={deployment.explorerBase}
                    now={now}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
