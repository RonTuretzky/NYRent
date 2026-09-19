import { Link } from "react-router-dom";
import { ArrowRightIcon, ChartLineUpIcon } from "@phosphor-icons/react";
import { useAllSeries, useCurrencyMeta } from "../chain/hooks";
import { isDeployed } from "../chain/deployment";
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

export function SeriesList() {
  const { series, isLoading, rpcError } = useAllSeries();
  const { symbol } = useCurrencyMeta();
  const now = nowSec();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Cover series
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Each series is one strike range on the CRE Daily Manhattan office
          rent print, with its own sale, observation and claim windows.
        </p>
      </header>

      {!isDeployed ? (
        <EmptyState title="No on-chain series yet">
          The contracts have not been deployed — series will appear here once
          deployment.json carries real addresses.
        </EmptyState>
      ) : isLoading ? (
        <Card>
          <LoadingSkeleton lines={4} />
        </Card>
      ) : rpcError && series.length === 0 ? (
        // Full-page outage state only when nothing is cached; a failed
        // background refetch keeps the last-good list plus a stale banner.
        <RpcDownState />
      ) : series.length === 0 ? (
        <EmptyState title="No series found">
          The pool exists but no series could be read from it.
        </EmptyState>
      ) : (
        <div className="space-y-4" data-testid="series-list">
          {rpcError ? <RpcStaleBanner /> : null}
          {series.map(({ id, series: s }) => {
            const phase = seriesPhase(s, now);
            return (
              <Link
                key={id}
                to={`/series/${id}`}
                className="block group"
                data-testid={`series-card-${id}`}
              >
                <Card className="transition-all group-hover:border-core-green group-hover:shadow-md">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="bg-green-0/40 text-green-2 h-11 w-11 rounded-xl flex items-center justify-center">
                        <ChartLineUpIcon size={24} weight="bold" />
                      </div>
                      <div>
                        <h2 className="font-parkDisplay font-bold text-lg text-text-standard">
                          Series #{id} · {formatCents(s.strikeLowCents)} →{" "}
                          {formatCents(s.strikeHighCents)}
                        </h2>
                        <p className="font-parkBody text-xs text-surface-grey-2">
                          premium {formatBps(s.premiumRateBps)} of max claim ·
                          obs {formatDate(s.obsStart)} – {formatDate(s.obsEnd)}
                          {s.settled
                            ? ` · settled at ${formatRatioWad(s.payoutRatioWad)}`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <PhaseBadge phase={phase} />
                      <ArrowRightIcon
                        size={20}
                        className="text-surface-grey group-hover:text-core-green transition-colors"
                      />
                    </div>
                  </div>
                  <div className="mt-4">
                    <CapacityBar
                      sold={s.sold}
                      capacity={s.capacity}
                      symbol={symbol}
                    />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
