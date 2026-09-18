import { formatCurrency } from "../chain/format";

function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Math.min(100, Number((part * 10_000n) / whole) / 100);
}

/** capacity bar: sold vs capacity. */
export function CapacityBar({
  sold,
  capacity,
  symbol,
}: {
  sold: bigint;
  capacity: bigint;
  symbol: string;
}) {
  const soldPct = pct(sold, capacity);
  return (
    <div data-testid="capacity-bar">
      <div className="flex justify-between font-parkBody text-xs text-surface-grey-2 mb-1">
        <span>
          Sold {formatCurrency(sold, { symbol })} ({soldPct.toFixed(1)}%)
        </span>
        <span>Capacity {formatCurrency(capacity, { symbol })}</span>
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

/**
 * Solvency bar: every sold claim must stay fully backed by pool balance.
 * Shows reserved vs balance; over-reservation (should be impossible on-chain)
 * would render red.
 */
export function SolvencyBar({
  reserved,
  balance,
  symbol,
}: {
  reserved: bigint;
  balance: bigint;
  symbol: string;
}) {
  const reservedPct = pct(reserved, balance > 0n ? balance : 1n);
  const solvent = reserved <= balance;
  return (
    <div data-testid="solvency-bar">
      <div className="flex justify-between font-parkBody text-xs text-surface-grey-2 mb-1">
        <span>
          Reserved {formatCurrency(reserved, { symbol })} (
          {reservedPct.toFixed(1)}% of balance)
        </span>
        <span>Pool balance {formatCurrency(balance, { symbol })}</span>
      </div>
      <div className="h-3 rounded-full bg-paper-2 overflow-hidden relative">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            solvent ? "bg-primary-pine" : "bg-system-red"
          }`}
          style={{ width: `${reservedPct}%` }}
        />
      </div>
      <p className="font-parkBody text-xs mt-1">
        {solvent ? (
          <span className="text-system-green font-bold">
            Fully collateralized — reserves never exceed the pool balance.
          </span>
        ) : (
          <span className="text-system-red font-bold">
            Reserves exceed balance — this should be impossible.
          </span>
        )}
      </p>
    </div>
  );
}
