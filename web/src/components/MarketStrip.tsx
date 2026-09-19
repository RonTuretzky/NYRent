/**
 * MarketStrip (SHARED CONTRACT) — the persistent header strip every page
 * renders: the one market's name, base value, coverage band and windows.
 * Live values from useActiveMarket, demo badges when a value is a fallback.
 */
import { formatCents, formatDate } from "../chain/format";
import { useActiveMarket } from "../chain/useActiveMarket";
import { COVERAGE_CEIL, COVERAGE_FLOOR } from "../lib/market";
import { DemoBadge } from "./DemoBadge";

function Term({
  label,
  value,
  demo = false,
}: {
  label: string;
  value: string;
  demo?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-parkBody text-xs text-surface-grey-2">
        {label}
      </span>
      <span className="font-parkBody text-xs font-bold text-text-standard whitespace-nowrap">
        {value}
      </span>
      {demo ? <DemoBadge /> : null}
    </div>
  );
}

export function MarketStrip() {
  const m = useActiveMarket();
  return (
    <section
      aria-label="Market terms"
      data-testid="market-strip"
      className="rounded-2xl border-2 border-paper-2 bg-paper-0 px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5"
    >
      <span className="font-parkDisplay text-sm font-bold text-text-standard">
        {m.name}
      </span>
      {m.isDemo ? <DemoBadge label="demo market" /> : null}
      <Term
        label="Base (Sep 2026)"
        value={`${formatCents(m.baseCents)} /SF`}
        demo={m.baseIsDemo}
      />
      <Term
        label="Covers"
        value={`+${Math.round(COVERAGE_FLOOR * 100)}% → +${Math.round(
          COVERAGE_CEIL * 100,
        )}% (${formatCents(m.strikeLowCents)} → ${formatCents(m.strikeHighCents)})`}
      />
      <Term label="Sale closes" value={formatDate(m.saleEnd)} />
      <Term
        label="Measured"
        value={`${formatDate(m.obsStart)} – ${formatDate(m.obsEnd)}`}
      />
      <Term label="Claim by" value={formatDate(m.redeemEnd)} />
    </section>
  );
}
