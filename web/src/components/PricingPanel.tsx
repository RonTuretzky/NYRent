import { CalculatorIcon } from "@phosphor-icons/react";
import { formatBps, formatCents, formatCurrency } from "../chain/format";

/**
 * Pricing-transparency panel (PRD p4): decomposes the fixed premium rate into
 * its expected-claim and aggregate-margin components using the documented
 * loading from the economic model — rate = expected claim × 1.25, so
 * expected = rate / 1.25 and margin = rate − expected. For 2850 bps on a
 * $10,000 max claim: $2,850 premium = $2,280 expected claim + $570 margin.
 *
 * The band-implied notional is derived from the series' OWN strikes: the
 * payout ramps 0→100% across the covered band, so per $100/SF of rent the
 * band spans bandCents/10,000 of it — multiplier = 10,000 / bandCents
 * (×12.5 for the demo's $8.00 band).
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
  const expectedRateBps = (premiumRateBps * 4) / 5;
  const marginRateBps = premiumRateBps - expectedRateBps;

  const hasAmount = maxClaimWei > 0n;
  const premium = (maxClaimWei * BigInt(premiumRateBps)) / 10_000n;
  const expected = expectedPart(premium);
  const margin = premium - expected;

  // Band-implied notional from the series' actual strikes (never hardcoded):
  // multiplier = 10,000 / bandCents in cents terms.
  const bandCents = strikeHighCents - strikeLowCents;
  const exposureMultiplier = bandCents > 0 ? 10_000 / bandCents : undefined;
  const exposure =
    bandCents > 0 ? (maxClaimWei * 10_000n) / BigInt(bandCents) : undefined;
  const multiplierLabel =
    exposureMultiplier !== undefined
      ? exposureMultiplier.toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })
      : undefined;

  const fmt = (wei: bigint) => formatCurrency(wei, { symbol, decimals });

  // Illustration in whole "dollars" when no amount is entered — the PRD's
  // canonical example scaled from the rate.
  const illuPremium = premiumRateBps; // per $10,000 of max claim, bps == $
  const illuExpected = (illuPremium * 4) / 5;
  const illuMargin = illuPremium - illuExpected;

  return (
    <details
      className="rounded-xl border border-paper-2 bg-paper-0 px-4 py-3"
      data-testid="pricing-panel"
    >
      <summary className="cursor-pointer font-parkBody text-sm font-bold text-text-standard flex items-center gap-2 select-none">
        <CalculatorIcon size={18} className="text-core-green shrink-0" />
        How the {formatBps(premiumRateBps)} premium is priced
      </summary>
      <div className="mt-3 space-y-1">
        <p className="font-parkBody text-xs text-surface-grey-2">
          <span className="font-bold text-text-standard">
            Illustrative, fixed-rate — not a live market price.
          </span>{" "}
          For agent-priced series the rate is administered from the pricing
          model as expected claim × 1.25 loading (sponsor-created series may
          use any rate):
        </p>
        {hasAmount ? (
          <div className="mt-2" data-testid="pricing-breakdown">
            <Row
              label={`Premium (${formatBps(premiumRateBps)} of max claim)`}
              value={fmt(premium)}
              bold
            />
            <Row
              label={`Expected claim (${formatBps(expectedRateBps)})`}
              value={fmt(expected)}
            />
            <Row
              label={`Aggregate risk margin (${formatBps(marginRateBps)})`}
              value={fmt(margin)}
            />
          </div>
        ) : (
          <div className="mt-2" data-testid="pricing-breakdown">
            <Row
              label="Premium per $10,000 of max claim"
              value={`$${illuPremium.toLocaleString("en-US")}`}
              bold
            />
            <Row
              label={`Expected claim (${formatBps(expectedRateBps)})`}
              value={`$${illuExpected.toLocaleString("en-US")}`}
            />
            <Row
              label={`Aggregate risk margin (${formatBps(marginRateBps)})`}
              value={`$${illuMargin.toLocaleString("en-US")}`}
            />
          </div>
        )}
        {exposure !== undefined && multiplierLabel !== undefined ? (
          <p
            className="font-parkBody text-xs text-surface-grey-2 pt-2"
            data-testid="pricing-exposure"
          >
            {hasAmount ? (
              <>
                {fmt(maxClaimWei)} max claim ≈ ~{fmt(exposure)} band-implied
                notional of annual rent (payout ramps across this series'{" "}
                {formatCents(bandCents)}/SF band → ×{multiplierLabel} per
                $100/SF of rent).
              </>
            ) : (
              <>
                $10,000 of max claim ≈ ~$
                {(10_000 * (exposureMultiplier ?? 0)).toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })}{" "}
                band-implied notional of annual rent (payout ramps across this
                series' {formatCents(bandCents)}/SF band → ×{multiplierLabel}{" "}
                per $100/SF of rent).
              </>
            )}
          </p>
        ) : null}
      </div>
    </details>
  );
}
