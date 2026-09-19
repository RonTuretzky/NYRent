/**
 * Page 4 — "/market-view" — price as a forecast. Because 1 RENT pays
 * ratio × $1, the price p is the market's expected payout ratio (plus a risk
 * margin): implied growth g* = 3% + 5% × p, implied Sept 2027 rent =
 * base × (1 + g*). Big number from the live rate, history from on-chain
 * ProtectionBought events (the market trades at a fixed rate today — labeled
 * honestly; the chart follows the live pool once it launches).
 */
import { useMemo } from "react";
import { V4PriceHistory } from "../components/V4PriceHistory";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { Card } from "../components/States";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { useActiveMarket } from "../chain/useActiveMarket";
import { formatCents, formatDate } from "../chain/format";
import {
  ACTIVE_SERIES_ID,
  COVERAGE_CEIL,
  COVERAGE_FLOOR,
  formatGrowth,
  impliedGrowth,
  impliedRentCents,
} from "../lib/market";

export function MarketView() {
  const m = useActiveMarket();
  const { deployment } = useActiveDeployment();
  const { symbol } = m;
  const gStar = impliedGrowth(m.p);
  const rentCents = impliedRentCents(m.baseCents, m.p);
  const floorPct = Math.round(COVERAGE_FLOOR * 100);
  const ceilPct = Math.round(COVERAGE_CEIL * 100);
  const history = usePriceHistory(m.source === "fixed");

  // Live event points when there are any; otherwise one "seed" point at the
  // current rate (which in demo mode is the 0.285 default).
  const points = useMemo<PricePoint[]>(() => {
    if (history.points && history.points.length > 0) return history.points;
    return [{ t: Math.floor(Date.now() / 1000), p: m.p }];
  }, [history.points, m.p]);
  const seedOnly = !history.points || history.points.length === 0;

  return (
    <div className="space-y-12">

      {/* the big number */}
      <section className="text-center max-w-3xl mx-auto pt-2 sm:pt-6">
        <h1 className="font-parkDisplay font-bold text-4xl tracking-tight text-text-standard">
          What the price is forecasting
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-4">
          Each RENT pays its payout ratio × $1 at settlement, so the price of
          RENT prices a capped payout. Mapping the price through the +{floorPct}% → +{ceilPct}% band gives a price-implied growth level, not expected rent growth. Different distributions of rent outcomes can produce the same RENT price.
        </p>
        <div className="mt-8 grid sm:grid-cols-3 gap-4 items-stretch">
          <BigStat
            label="RENT price now"
            value={m.isDemo ? "—" : `${m.p.toFixed(3)} ${symbol}`}
            sub={m.source === "v4" ? "Uniswap v4 spot price" : m.isDemo ? "Price unavailable" : "fixed-rate price, not a crowd forecast"}
          />
          <BigStat
            label="Price-implied growth"
            value={m.isDemo ? "—" : formatGrowth(gStar)}
            sub={`= ${floorPct}% + ${ceilPct - floorPct}% × price`}
            arrow
          />
          <BigStat
            label="Implied Sept 2027 rent"
            value={m.isDemo || m.baseIsDemo ? "—" : `${formatCents(rentCents)} /SF`}
            sub={m.isDemo ? "Requires a current market price" : `= base × (1 ${gStar >= 0 ? "+" : "−"} ${Math.abs(gStar * 100).toFixed(3)}%)`}
            arrow
            emphasis
          />
        </div>
        <p className="font-parkBody text-xs text-surface-grey mt-4">
          Risk margins, discounting and liquidity affect price; the adjustment need not be positive. This transformation is not E[g].
        </p>
      </section>

      {/* price history */}
      <section className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h2 className="font-parkDisplay font-bold text-2xl text-text-standard">
            Price history
          </h2>
        </div>
        {m.source === "v4" ? <V4PriceHistory /> : m.isDemo ? <Card><p className="font-parkBody text-sm text-surface-grey-2">Price history is unavailable on this network.</p></Card> : <Card>
          {history.isLoading ? (
            <div className="nrc-skeleton h-56 rounded-xl" aria-hidden="true" />
          ) : (
            <PriceHistoryChart
              points={points}
              baseCents={m.baseCents}
              symbol={symbol}
            />
          )}
          <p className="font-parkBody text-xs text-surface-grey-2 mt-3">
            {seedOnly
              ? "No purchase history is shown — the line marks the current configured rate, not an observed historical trade."
              : "Each point is a purchase in this market (on-chain ProtectionBought events) at its fixed rate."}{" "}
            When the live pool launches, this chart will follow the pool's
            trades instead — trades can move the price away from the insurer's initial quote.
          </p>
          {history.unavailable ? (
            <p className="font-parkBody text-xs text-system-red mt-1">
              Purchase history could not be loaded from the{" "}
              {deployment.name} RPC — showing the current rate only.
            </p>
          ) : null}
        </Card>}
        <p className="font-parkBody text-xs text-surface-grey text-center">
          Want that payout for yourself? Head to the renter view{" "}
          <ArrowRightIcon size={12} className="inline" aria-hidden="true" />{" "}
          it prices your exact coverage.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------- big number ------------------------------- */

function BigStat({
  label,
  value,
  sub,
  arrow = false,
  emphasis = false,
}: {
  label: string;
  value: string;
  sub?: string;
  arrow?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="relative bg-paper-0 border-2 border-paper-2 rounded-2xl px-4 py-5">
      {arrow ? (
        <ArrowRightIcon
          size={18}
          aria-hidden="true"
          className="hidden sm:block absolute -left-[15px] top-1/2 -translate-y-1/2 text-surface-grey"
        />
      ) : null}
      <div className="font-parkBody text-xs text-surface-grey-2 flex items-center justify-center gap-1.5">
        {label}
      </div>
      <div
        className={`font-parkDisplay font-bold mt-1 ${
          emphasis ? "text-4xl text-core-green" : "text-3xl text-text-standard"
        }`}
      >
        {value}
      </div>
      {sub ? (
        <div className="font-parkBody text-[11px] text-surface-grey mt-1">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ event history ------------------------------ */

interface PricePoint {
  /** unix seconds */
  t: number;
  /** price paid per RENT, as a 0–1 fraction of the currency */
  p: number;
}

const PROTECTION_BOUGHT = parseAbiItem(
  "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 maxClaim, uint256 premium)",
);

/** Realized purchase prices for the active market from ProtectionBought
 * events: p = premium / maxClaim (both in currency wei). Capped to the most
 * recent 60 purchases; block timestamps fetched per unique block. */
function usePriceHistory(matchingMarket: boolean): {
  points: PricePoint[] | undefined;
  isLoading: boolean;
  unavailable: boolean;
} {
  const { deployment } = useActiveDeployment();
  const live = matchingMarket && isLiveDeployment(deployment);
  const client = usePublicClient({ chainId: deployment.chainId });
  const query = useQuery({
    queryKey: ["rent-price-history", deployment.chainId, deployment.pool],
    enabled: live && !!client,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<PricePoint[]> => {
      const logs = await client!.getLogs({
        address: deployment.pool,
        event: PROTECTION_BOUGHT,
        args: { seriesId: BigInt(ACTIVE_SERIES_ID) },
        fromBlock: 0n,
        toBlock: "latest",
      });
      const recent = logs.slice(-60);
      const blockNumbers = [
        ...new Set(
          recent
            .map((l) => l.blockNumber)
            .filter((bn): bn is bigint => bn !== null),
        ),
      ];
      const blocks = await Promise.all(
        blockNumbers.map((bn) => client!.getBlock({ blockNumber: bn })),
      );
      const tByBlock = new Map(
        blocks.map((b) => [b.number, Number(b.timestamp)]),
      );
      return recent.flatMap((l) => {
        const { maxClaim, premium } = l.args;
        if (
          maxClaim === undefined ||
          premium === undefined ||
          maxClaim === 0n ||
          l.blockNumber === null
        ) {
          return [];
        }
        return [
          {
            t: tByBlock.get(l.blockNumber) ?? 0,
            p: Number(premium) / Number(maxClaim),
          },
        ];
      });
    },
  });
  return {
    points: live ? query.data : [],
    isLoading: live && query.isLoading,
    unavailable: live && query.isError,
  };
}

/* --------------------------------- chart ---------------------------------- */

/**
 * Price-over-time step chart. ONE measure, two units: the left axis is the
 * RENT price p; the right axis is the same gridline mapped through the
 * band — implied Sept 2027 rent = base × (1 + 3% + 5% × p).
 */
function PriceHistoryChart({
  points,
  baseCents,
  symbol,
}: {
  points: PricePoint[];
  baseCents: number;
  symbol: string;
}) {
  const W = 560;
  const H = 272;
  const pad = { left: 46, right: 66, top: 26, bottom: 40 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const maxP = Math.max(...sorted.map((d) => d.p));
  const yMax = Math.min(1, Math.max(0.4, Math.ceil((maxP * 1.25) / 0.1) * 0.1));
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  // A lone point sits centered on a dashed level line.
  const single = sorted.length === 1;

  const x = (t: number) =>
    single ? pad.left + iw / 2 : pad.left + ((t - t0) / span) * iw;
  const y = (p: number) => pad.top + (1 - p / yMax) * ih;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const stepPath = sorted
    .map((d, i) =>
      i === 0
        ? `M ${x(d.t)} ${y(d.p)}`
        : `H ${x(d.t)} V ${y(d.p)}`,
    )
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      role="img"
      aria-label={`RENT price history: ${sorted.length} recorded ${sorted.length === 1 ? "price" : "prices"}, latest ${sorted[sorted.length - 1].p.toFixed(3)} ${symbol} per RENT, implying a September 2027 rent of ${formatCents(impliedRentCents(baseCents, sorted[sorted.length - 1].p))} per square foot.`}
      data-testid="price-history-chart"
    >
      {/* axis captions */}
      <text
        x={pad.left}
        y={14}
        fontSize={11}
        fill="var(--color-surface-grey)"
        fontFamily="var(--font-parkBody)"
      >
        price per RENT ({symbol})
      </text>
      <text
        x={W - pad.right + 62}
        y={14}
        textAnchor="end"
        fontSize={11}
        fill="var(--color-surface-grey)"
        fontFamily="var(--font-parkBody)"
      >
        implied Sept 2027 rent ($/SF)
      </text>

      {/* gridlines: one scale, labeled in both units */}
      {ticks.map((p) => (
        <g key={p}>
          <line
            x1={pad.left}
            x2={W - pad.right}
            y1={y(p)}
            y2={y(p)}
            stroke="var(--color-paper-2)"
            strokeWidth={1}
            strokeDasharray={p === 0 ? undefined : "3 4"}
          />
          <text
            x={pad.left - 8}
            y={y(p) + 4}
            textAnchor="end"
            fontSize={11}
            fill="var(--color-surface-grey)"
            fontFamily="var(--font-parkBody)"
          >
            {p.toFixed(2)}
          </text>
          <text
            x={W - pad.right + 8}
            y={y(p) + 4}
            textAnchor="start"
            fontSize={11}
            fill="var(--color-surface-grey)"
            fontFamily="var(--font-parkBody)"
          >
            {formatCents(impliedRentCents(baseCents, p))}
          </text>
        </g>
      ))}

      {/* x labels: first and last time */}
      <text
        x={single ? pad.left + iw / 2 : pad.left}
        y={H - 10}
        textAnchor={single ? "middle" : "start"}
        fontSize={11}
        fill="var(--color-surface-grey)"
        fontFamily="var(--font-parkBody)"
      >
        {formatDate(t0)}
      </text>
      {single ? null : (
        <text
          x={W - pad.right}
          y={H - 10}
          textAnchor="end"
          fontSize={11}
          fill="var(--color-surface-grey)"
          fontFamily="var(--font-parkBody)"
        >
          {formatDate(t1)}
        </text>
      )}

      {/* the series */}
      {single ? (
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={y(sorted[0].p)}
          y2={y(sorted[0].p)}
          stroke="var(--color-core-green)"
          strokeWidth={2}
          strokeDasharray="6 5"
        />
      ) : (
        <path
          d={stepPath}
          fill="none"
          stroke="var(--color-core-green)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />
      )}
      {sorted.map((d, i) => (
        <circle
          key={`${d.t}-${i}`}
          cx={x(d.t)}
          cy={y(d.p)}
          r={i === 0 ? 6 : 4.5}
          fill={
            i === 0 ? "var(--color-primary-pine)" : "var(--color-core-green)"
          }
          stroke="var(--color-paper-0)"
          strokeWidth={2}
        >
          <title>
            {`${formatDate(d.t)} · ${d.p.toFixed(3)} ${symbol} per RENT → implies ${formatCents(impliedRentCents(baseCents, d.p))} /SF`}
          </title>
        </circle>
      ))}
      {/* seed label on the first point */}
      <text
        x={x(sorted[0].t) + 10}
        y={y(sorted[0].p) - 10}
        fontSize={11}
        fontWeight={700}
        fill="var(--color-primary-pine)"
        fontFamily="var(--font-parkBody)"
      >
        {single ? `current rate ${sorted[0].p.toFixed(3)}` : "first displayed price"}
      </text>
    </svg>
  );
}
