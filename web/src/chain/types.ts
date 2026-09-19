import type { Address } from "viem";

/** Mirrors CoverPool.Series (permissionless pool, src/CoverPool.sol). Both
 * live chains run the same contract version, so one shape serves every
 * deployment. Amounts are in pool-currency wei (18-dec WXDAI on Gnosis,
 * 6-dec USDC on Arbitrum) — format with the active deployment's decimals. */
export interface Series {
  /** Escrowed the capacity; sole holder of the series levers. */
  creator: Address;
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  settled: boolean;
  /** Creator refund taken while unsold; series permanently closed. */
  cancelled: boolean;
  saleEnd: bigint;
  obsStart: bigint;
  obsEnd: bigint;
  redeemEnd: bigint;
  /** Max sellable claim, backed 1:1 (zeroed by cancel). */
  escrow: bigint;
  /** Alias of `escrow` — the pre-registry components call it capacity. */
  capacity: bigint;
  sold: bigint;
  /** Per-series accounting: premiums pulled into this series' bucket. */
  premiumsAccrued: bigint;
  /** Per-series accounting: currency paid to redeemers. */
  paidOut: bigint;
  /** Per-series accounting: returned to the creator via withdrawResidual. */
  withdrawn: bigint;
  /** One-shot latch across the cancel and residual-withdrawal exits. */
  residualWithdrawn: boolean;
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
  if (s.cancelled) return "closed";
  if (s.settled) {
    return nowSec <= s.redeemEnd ? "redeem" : "closed";
  }
  if (nowSec > s.redeemEnd) return "closed";
  if (nowSec > s.obsEnd) return "awaiting-settlement";
  if (nowSec >= s.obsStart) {
    // saleEnd ≤ obsStart is a contract invariant; equality only at the boundary
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

/** ABI order of CoverPool.Series components (see chain/abi.ts). */
const SERIES_KEYS = [
  "creator",
  "strikeLowCents",
  "strikeHighCents",
  "premiumRateBps",
  "settled",
  "cancelled",
  "saleEnd",
  "obsStart",
  "obsEnd",
  "redeemEnd",
  "escrow",
  "sold",
  "premiumsAccrued",
  "paidOut",
  "withdrawn",
  "residualWithdrawn",
  "payoutRatioWad",
  "observationT",
  "emailId",
] as const;

/** Decode a Series tuple/struct result from a contract read defensively
 * (viem returns named structs as objects; array order matches the ABI). */
export function decodeSeries(raw: unknown): Series | undefined {
  if (raw == null) return undefined;
  const values: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? SERIES_KEYS.map((k) => (raw as Record<string, unknown>)[k])
      : [];
  if (values.length < SERIES_KEYS.length || values[0] === undefined) {
    return undefined;
  }
  const big = (v: unknown) => BigInt(v as string | number | bigint);
  const escrow = big(values[10]);
  return {
    creator: values[0] as Address,
    strikeLowCents: Number(values[1]),
    strikeHighCents: Number(values[2]),
    premiumRateBps: Number(values[3]),
    settled: Boolean(values[4]),
    cancelled: Boolean(values[5]),
    saleEnd: big(values[6]),
    obsStart: big(values[7]),
    obsEnd: big(values[8]),
    redeemEnd: big(values[9]),
    escrow,
    capacity: escrow,
    sold: big(values[11]),
    premiumsAccrued: big(values[12]),
    paidOut: big(values[13]),
    withdrawn: big(values[14]),
    residualWithdrawn: Boolean(values[15]),
    payoutRatioWad: big(values[16]),
    observationT: big(values[17]),
    emailId: values[18] as `0x${string}`,
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
