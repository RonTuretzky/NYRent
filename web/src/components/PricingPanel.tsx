import { CalculatorIcon } from "@phosphor-icons/react";
import { formatBps, formatCents, formatCurrency } from "../chain/format";

/**
 * Plain-language pricing panel. Leads with what the buyer actually pays and
 * where the money goes, in their own numbers; the full decomposition and the
 * strike-band math sit behind a collapsed "Show the math" disclosure, each
 * term explained in a sentence. (The documented loading from the economic
 * model: price = expected payouts × 1.25, so expected = price ÷ 1.25.)
 */
export interface PricingPanelProps {
  premiumRateBps: number;
  maxClaimWei: bigint;
  decimals: number;
  symbol: string;
  strikeLowCents: number;
  strikeHighCents: number;
}

/** 1 / 1.25 loading = 4/5, exact in bigint. */
function expectedPart(x: bigint): bigint {
  return (x * 4n) / 5n;
}

function Row({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 border-b border-paper-1 last:border-b-0">
      <span className="font-parkBody text-xs text-surface-grey-2">{label}</span>
      <span
        className={`font-parkBody text-xs text-text-standard text-right ${bold ? "font-bold" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

export function PricingPanel({
  premiumRateBps,
  maxClaimWei,
  decimals,
  symbol,
  strikeLowCents,
  strikeHighCents,
}: PricingPanelProps) {
  const hasAmount = maxClaimWei > 0n;
  const premium = (maxClaimWei * BigInt(premiumRateBps)) / 10_000n;
  const expected = expectedPart(premium);
  const margin = premium - expected;
  const fmt = (wei: bigint) => formatCurrency(wei, { symbol, decimals });

  // Percent view for when no amount is entered yet.
  const ratePct = formatBps(premiumRateBps);
  const expectedRateBps = (premiumRateBps * 4) / 5;
  const marginRateBps = premiumRateBps - expectedRateBps;

  // Strike-band math (only inside "Show the math"): the payout ramps from 0
  // at the low strike to full at the high strike.
  const bandCents = strikeHighCents - strikeLowCents;
  const exposure =
    bandCents > 0 ? (maxClaimWei * 10_000n) / BigInt(bandCents) : undefined;
  const exposureMultiplier = bandCents > 0 ? 10_000 / bandCents : undefined;

  return (
    <div
      className="rounded-xl border border-paper-2 bg-paper-0 px-4 py-3"
      data-testid="pricing-panel"
    >
      <p className="font-parkBody text-sm font-bold text-text-standard flex items-center gap-2">
        <CalculatorIcon size={18} className="text-core-green shrink-0" />
        {hasAmount ? <>Your price: {fmt(premium)}, paid once.</> : (
          <>Your price: {ratePct} of whatever you protect, paid once.</>
        )}
      </p>
      <p className="mt-1 font-parkBody text-xs text-surface-grey-2">
        Where it goes: most of it ({hasAmount ? fmt(expected) : formatBps(expectedRateBps)})
        covers expected payouts to buyers like you; the rest (
        {hasAmount ? fmt(margin) : formatBps(marginRateBps)}) pays whoever put
        up the money for taking the risk.
      </p>
      {!hasAmount ? (
        <p className="mt-1 font-parkBody text-xs text-surface-grey-2">
          Example: protect 100 {symbol} → pay{" "}
          {formatCurrency((100n * 10n ** BigInt(decimals) * BigInt(premiumRateBps)) / 10_000n, { symbol, decimals })}{" "}
          once. Enter an amount above to see your own numbers.
        </p>
      ) : null}

      <details className="mt-2" data-testid="pricing-breakdown">
        <summary className="cursor-pointer font-parkBody text-xs font-bold text-surface-grey-2 select-none">
          Show the math
        </summary>
        <div className="mt-2 space-y-1">
          <Row
            label={`Price rate — a fixed ${ratePct} of the amount you protect`}
            value={hasAmount ? fmt(premium) : ratePct}
            bold
          />
          <Row
            label={`Expected payouts (${formatBps(expectedRateBps)}) — the model's estimate of what buyers of this market will be paid on average`}
            value={hasAmount ? fmt(expected) : formatBps(expectedRateBps)}
          />
          <Row
            label={`Backer's share (${formatBps(marginRateBps)}) — the price is set at expected payouts × 1.25; this remainder compensates whoever escrowed the payout money`}
            value={hasAmount ? fmt(margin) : formatBps(marginRateBps)}
          />
          <p className="font-parkBody text-xs text-surface-grey-2 pt-2">
            This is a fixed, illustrative rate — not a live market price.
            Anyone can create a market at any rate; this breakdown just shows
            how the reference model prices one.
          </p>
          {exposure !== undefined && exposureMultiplier !== undefined ? (
            <p
              className="font-parkBody text-xs text-surface-grey-2 pt-1"
              data-testid="pricing-exposure"
            >
              How the payout ramps: you get nothing at or below{" "}
              {formatCents(strikeLowCents)}/SF, the full amount at or above{" "}
              {formatCents(strikeHighCents)}/SF, and a proportional share in
              between — a {formatCents(bandCents)}/SF band.{" "}
              {hasAmount ? (
                <>
                  Because the whole payout fits inside that band, your{" "}
                  {fmt(maxClaimWei)} of protection moves like roughly{" "}
                  {fmt(exposure)} of annual rent (×
                  {exposureMultiplier.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })}{" "}
                  per $100/SF of rent).
                </>
              ) : (
                <>
                  Because the whole payout fits inside that band, each unit of
                  protection moves like roughly{" "}
                  {exposureMultiplier.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })}{" "}
                  units of annual rent.
                </>
              )}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
