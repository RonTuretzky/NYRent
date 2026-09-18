/** Mirrors CoverPool.Series (SPEC §2.4, frozen). */
export interface Series {
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  saleEnd: bigint;
  obsStart: bigint;
  obsEnd: bigint;
  redeemEnd: bigint;
  capacity: bigint;
  sold: bigint;
  settled: boolean;
  payoutRatioWad: bigint;
  observationT: bigint;
  emailId: `0x${string}`;
}

/** Mirrors CredailyRentOracle.Observation (SPEC §2.2, frozen). */
export interface Observation {
  index: number;
  t: bigint;
  cents: number;
  emailId: `0x${string}`;
}

export type SeriesPhase =
  | "sale"
  | "observation"
  | "awaiting-settlement"
  | "settled"
  | "redeem"
  | "closed";

export function seriesPhase(s: Series, nowSec: bigint): SeriesPhase {
  if (s.settled) {
    return nowSec <= s.redeemEnd ? "redeem" : "closed";
  }
  if (nowSec > s.redeemEnd) return "closed";
  if (nowSec > s.obsEnd) return "awaiting-settlement";
  if (nowSec >= s.obsStart) {
    // demo series intentionally sells during the observation window
    return nowSec <= s.saleEnd ? "sale" : "observation";
  }
  return nowSec <= s.saleEnd ? "sale" : "observation";
}

const WAD = 10n ** 18n;

export function payoutRatioWadFor(s: Series, cents: number): bigint {
  const low = BigInt(s.strikeLowCents);
  const high = BigInt(s.strikeHighCents);
  const c = BigInt(cents);
  if (c <= low) return 0n;
  if (c >= high) return WAD;
  return ((c - low) * WAD) / (high - low);
}

/** Decode a Series tuple/struct result from a contract read defensively. */
export function decodeSeries(raw: unknown): Series | undefined {
  if (raw == null) return undefined;
  const values: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? [
          (raw as Record<string, unknown>).strikeLowCents,
          (raw as Record<string, unknown>).strikeHighCents,
          (raw as Record<string, unknown>).premiumRateBps,
          (raw as Record<string, unknown>).saleEnd,
          (raw as Record<string, unknown>).obsStart,
          (raw as Record<string, unknown>).obsEnd,
          (raw as Record<string, unknown>).redeemEnd,
          (raw as Record<string, unknown>).capacity,
          (raw as Record<string, unknown>).sold,
          (raw as Record<string, unknown>).settled,
          (raw as Record<string, unknown>).payoutRatioWad,
          (raw as Record<string, unknown>).observationT,
          (raw as Record<string, unknown>).emailId,
        ]
      : [];
  if (values.length < 13 || values[0] === undefined) return undefined;
  return {
    strikeLowCents: Number(values[0]),
    strikeHighCents: Number(values[1]),
    premiumRateBps: Number(values[2]),
    saleEnd: BigInt(values[3] as string | number | bigint),
    obsStart: BigInt(values[4] as string | number | bigint),
    obsEnd: BigInt(values[5] as string | number | bigint),
    redeemEnd: BigInt(values[6] as string | number | bigint),
    capacity: BigInt(values[7] as string | number | bigint),
    sold: BigInt(values[8] as string | number | bigint),
    settled: Boolean(values[9]),
    payoutRatioWad: BigInt(values[10] as string | number | bigint),
    observationT: BigInt(values[11] as string | number | bigint),
    emailId: values[12] as `0x${string}`,
  };
}

export function decodeObservation(
  raw: unknown,
  index: number,
): Observation | undefined {
  if (raw == null) return undefined;
  const values: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? [
          (raw as Record<string, unknown>).t,
          (raw as Record<string, unknown>).cents,
          (raw as Record<string, unknown>).emailId,
        ]
      : [];
  if (values.length < 3 || values[0] === undefined) return undefined;
  return {
    index,
    t: BigInt(values[0] as string | number | bigint),
    cents: Number(values[1]),
    emailId: values[2] as `0x${string}`,
  };
}
