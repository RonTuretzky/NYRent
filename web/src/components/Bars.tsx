import { formatCurrency } from "../chain/format";

function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Math.min(100, Number((part * 10_000n) / whole) / 100);
}

/** capacity bar: sold vs capacity. `symbol`/`decimals` come from the active
 * deployment's currency (18-dec vs 6-dec chains). */
export function CapacityBar({
  sold,
  capacity,
  symbol,
  decimals,
}: {
  sold: bigint;
  capacity: bigint;
  symbol: string;
  decimals: number;
}) {
  const soldPct = pct(sold, capacity);
  return (
    <div data-testid="capacity-bar">
      <div className="flex justify-between font-parkBody text-xs text-surface-grey-2 mb-1">
        <span>
          Sold {formatCurrency(sold, { symbol, decimals })} (
          {soldPct.toFixed(1)}%)
        </span>
        <span>Capacity {formatCurrency(capacity, { symbol, decimals })}</span>
      </div>
      <div className="h-3 rounded-full bg-paper-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-core-green transition-all duration-700 ease-out"
          style={{ width: `${soldPct}%` }}
        />
      </div>
    </div>
  );
}
