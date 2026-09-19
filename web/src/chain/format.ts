import { formatUnits, parseUnits } from "viem";

export const WAD = 10n ** 18n;

/** "$92.88 / SF" style index value from integer cents. */
export function formatCents(cents: number | bigint): string {
  const n = Number(cents);
  return `$${(n / 100).toFixed(2)}`;
}

/** Currency amounts with sensible precision. `decimals`/`symbol` are
 * REQUIRED and must come from the active deployment's currency (18-dec vs
 * 6-dec chains render the same wei count wildly differently) — no defaults,
 * so tsc flags any call site that forgets. */
export function formatCurrency(
  wei: bigint | undefined,
  opts: { decimals: number; symbol: string; precision?: number },
): string {
  if (wei === undefined) return "—";
  const { decimals, symbol, precision = 6 } = opts;
  const asString = formatUnits(wei, decimals);
  const num = Number(asString);
  const shown =
    num === 0
      ? "0"
      : num < 10 ** -precision
        ? asString // tiny amounts: show exact
        : num.toLocaleString("en-US", { maximumFractionDigits: precision });
  return `${shown} ${symbol}`;
}

/** Decimal input → currency wei. `decimals` is REQUIRED (the active
 * deployment's currency decimals) — same rationale as formatCurrency. */
export function parseCurrency(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return null;
  }
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

export function formatRatioWad(ratioWad: bigint): string {
  return `${(Number(ratioWad) / 1e16).toFixed(1)}%`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatTimestamp(t: bigint | number | undefined): string {
  if (t === undefined || t === 0n || t === 0) return "—";
  return new Date(Number(t) * 1000).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function formatDate(t: bigint | number | undefined): string {
  if (t === undefined || t === 0n || t === 0) return "—";
  return new Date(Number(t) * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function truncateAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function truncateHex(hex: string, chars = 10): string {
  return hex.length > chars * 2 + 2
    ? `${hex.slice(0, chars + 2)}…${hex.slice(-chars)}`
    : hex;
}

export function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
