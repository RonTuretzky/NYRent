/**
 * useActiveMarket (SHARED CONTRACT) — the ONE market the app exposes:
 * seriesId ACTIVE_SERIES_ID on the active deployment. Reads live chain state
 * (series terms, escrow, sold, settlement + the oracle's base observation)
 * and falls back to the demo constants in lib/market.ts per value, flagging
 * each fallback so pages can render "demo" badges.
 */
import { useMemo } from "react";
import {
  ACTIVE_SERIES_ID,
  DEMO_BASE_CENTS,
  DEMO_OBS_END,
  DEMO_OBS_START,
  DEMO_PREMIUM_P,
  DEMO_REDEEM_END,
  DEMO_SALE_END,
  DEMO_STRIKE_HIGH_CENTS,
  DEMO_STRIKE_LOW_CENTS,
  MARKET_NAME,
  strikeHighCentsFor,
  strikeLowCentsFor,
} from "../lib/market";
import { useOracleObservations, useSeriesRow } from "./poolHooks";
import type { Series } from "./types";
import { useV4Market } from "./v4";
import { useActiveDeployment } from "./registry";

export interface ActiveMarket {
  seriesId: number;
  name: string;
  /** The live series, when the read succeeded on the active chain. */
  series?: Series;
  /** True when the market itself is a demo fallback (no live series). */
  isDemo: boolean;
  /** True when the base print is the demo fixture (no live observation). */
  baseIsDemo: boolean;
  /** Base = first qualifying Sept 2026 oracle observation, index cents. */
  baseCents: number;
  strikeLowCents: number;
  strikeHighCents: number;
  /** RENT price / premium rate as a 0–1 fraction (live premiumRateBps/10000). */
  p: number;
  saleEnd: bigint;
  obsStart: bigint;
  obsEnd: bigint;
  redeemEnd: bigint;
  /** Live-only (undefined in demo mode), in pool-currency wei. */
  escrow?: bigint;
  sold?: bigint;
  /** All redeemable v4 inventory, including insurer and LP inventory. */
  supply?: bigint;
  source: "v4" | "fixed" | "demo";
  symbol: string;
  decimals: number;
  settled: boolean;
  payoutRatioWad?: bigint;
  isLoading: boolean;
  rpcError: boolean;
}

export function useActiveMarket(): ActiveMarket {
  const row = useSeriesRow(ACTIVE_SERIES_ID);
  const obs = useOracleObservations();
  const v4 = useV4Market();
  const { deployment } = useActiveDeployment();

  return useMemo<ActiveMarket>(() => {
    const v4State = v4.data;
    if (v4.deployment && v4State && v4State.baseVerified &&
      v4State.obsStart === DEMO_OBS_START &&
      v4State.obsEnd === DEMO_OBS_END &&
      v4State.strikeLowCents === strikeLowCentsFor(v4State.baseCents) &&
      v4State.strikeHighCents === strikeHighCentsFor(v4State.baseCents)) {
      return {
        seriesId: ACTIVE_SERIES_ID, name: MARKET_NAME, source: "v4",
        symbol: v4.deployment.symbol, decimals: v4.deployment.decimals,
        isDemo: false, baseIsDemo: false,
        baseCents: v4State.baseCents, strikeLowCents: v4State.strikeLowCents,
        strikeHighCents: v4State.strikeHighCents, p: v4State.p,
        saleEnd: v4State.saleEnd, obsStart: v4State.obsStart,
        obsEnd: v4State.obsEnd, redeemEnd: v4State.redeemEnd,
        escrow: v4State.escrow, supply: v4State.supply, settled: v4State.settled,
        payoutRatioWad: v4State.settled ? v4State.payoutRatioWad : undefined,
        isLoading: v4.isLoading, rpcError: v4.isError,
      };
    }
    // Never relabel a historical market as the locked Sep 2026–Sep 2027 one.
    // Insertion order is oracle order: first qualifying recorded observation.
    const baseObs = obs.observations.find(
      (o) => o.t >= 1_788_220_800n && o.t < 1_790_812_800n,
    );
    const baseCents = baseObs?.cents ?? DEMO_BASE_CENTS;
    const candidate = row.series;
    const series = !v4.deployment && candidate &&
      candidate.obsStart === DEMO_OBS_START &&
      candidate.obsEnd === DEMO_OBS_END &&
      candidate.saleEnd <= candidate.obsStart &&
      candidate.strikeLowCents === strikeLowCentsFor(baseCents) &&
      candidate.strikeHighCents === strikeHighCentsFor(baseCents)
      ? candidate : undefined;
    const obsStart = series?.obsStart ?? DEMO_OBS_START;
    return {
      seriesId: ACTIVE_SERIES_ID,
      name: MARKET_NAME,
      source: series ? "fixed" : "demo",
      symbol: v4.deployment?.symbol ?? deployment.currency.symbol,
      decimals: v4.deployment?.decimals ?? deployment.currency.decimals,
      series,
      isDemo: !series,
      baseIsDemo: !baseObs,
      baseCents,
      strikeLowCents:
        series?.strikeLowCents ??
        (baseObs ? strikeLowCentsFor(baseCents) : DEMO_STRIKE_LOW_CENTS),
      strikeHighCents:
        series?.strikeHighCents ??
        (baseObs ? strikeHighCentsFor(baseCents) : DEMO_STRIKE_HIGH_CENTS),
      p: series ? series.premiumRateBps / 10_000 : DEMO_PREMIUM_P,
      saleEnd: series?.saleEnd ?? DEMO_SALE_END,
      obsStart,
      obsEnd: series?.obsEnd ?? DEMO_OBS_END,
      redeemEnd: series?.redeemEnd ?? DEMO_REDEEM_END,
      escrow: series?.escrow,
      sold: series?.sold,
      settled: series?.settled ?? false,
      payoutRatioWad: series?.settled ? series.payoutRatioWad : undefined,
      isLoading: v4.deployment ? v4.isLoading : row.isLoading || obs.isLoading,
      rpcError: v4.deployment ? v4.isError : row.rpcError || obs.rpcError,
    };
  }, [row.series, row.isLoading, row.rpcError, obs.observations, obs.isLoading, obs.rpcError, v4.data, v4.deployment, v4.isLoading, v4.isError, deployment.currency]);
}
