/**
 * /renter — payout visualizer for the RENTER role of the one active market.
 * All math comes from lib/market.ts; the price prefills from the live market
 * (demo-badged otherwise) and the buy button hands off to the existing buy
 * flow with the coverage amount prefilled.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LiftedButton } from "@decentralpark/ui";
import { useActiveMarket } from "../chain/useActiveMarket";
import {
  DEMO_PREMIUM_P,
  OUTCOME_GRID,
  formatGrowth,
  renterPayoutAt,
  renterQuote,
  settleCentsAt,
} from "../lib/market";
import { formatCount, formatDollars } from "../lib/dollars";
import { Card, StatRow } from "../components/States";
import { SliderInput } from "../components/SliderInput";
import { GrowthChart } from "../components/GrowthChart";
import { DemoBadge } from "../components/DemoBadge";

const DEFAULT_ANNUAL_RENT = 60_000;

export function RenterVisualizer() {
  const navigate = useNavigate();
  const market = useActiveMarket();
  const symbol = market.symbol;

  const [annualRent, setAnnualRent] = useState(DEFAULT_ANNUAL_RENT);
  const [p, setP] = useState(DEMO_PREMIUM_P);
  const [pTouched, setPTouched] = useState(false);

  // The price input follows the live market until the user edits it.
  useEffect(() => {
    if (!pTouched) setP(market.p);
  }, [market.p, pTouched]);

  const q = renterQuote(annualRent, p);
  const rows = OUTCOME_GRID.map((g) => {
    const payout = renterPayoutAt(g, q.units);
    return {
      g,
      settleCents: settleCentsAt(market.baseCents, g),
      payout,
      net: payout - q.cost,
      rentIncrease: annualRent * Math.max(g, 0),
    };
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          What would this cover pay you?
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          You buy RENT once, now. Each RENT pays up to $1 if the Manhattan rent
          index climbs past 3% year over year — reaching the full $1 at 8%. If
          rent stays flat, you lose only what you paid.
        </p>
      </header>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard mb-3">
          Your coverage
        </h2>
        <div className="grid gap-8 sm:grid-cols-2">
          <SliderInput
            label="Your annual rent"
            value={annualRent}
            onChange={setAnnualRent}
            min={6_000}
            max={300_000}
            step={1_000}
            unit={symbol}
            testId="renter-rent"
          />
          <SliderInput
            label="Price per RENT"
            value={p}
            onChange={(next) => {
              setPTouched(true);
              setP(next);
            }}
            min={0}
            max={1}
            step={0.005}
            unit="per RENT"
            hint={
              market.isDemo
                ? "Demo price — the live market price fills in once deployed."
                : "Prefilled from the live market price — edit to explore."
            }
            testId="renter-price"
          />
        </div>

        <div className="mt-4 border-t border-paper-1 pt-3">
          <StatRow
            label="RENT for full band coverage (N = R × 5%)"
            value={`${formatCount(q.units)} RENT`}
          />
          <StatRow
            label="Your cost, paid once (N × p)"
            value={formatDollars(q.cost)}
          />
          <StatRow
            label="Breakeven growth (3% + 5% × p)"
            value={formatGrowth(q.breakevenGrowth)}
          />
          <StatRow
            label="Maximum payout (N, at 8%+ growth)"
            value={formatDollars(q.maxPayout)}
          />
        </div>
        <p className="mt-2 font-parkBody text-xs text-surface-grey-2">
          Why N = R × 5%? The market covers rent growth between 3% and 8% — a
          5-percentage-point band. The covered slice is 5% of R; holding {formatCount(q.units)} RENT pays
          exactly that {formatDollars(q.units)} back. Below 3% you absorb the
          increase (it pays nothing); above 8% the payout stays capped at{" "}
          {formatDollars(q.maxPayout)}.
        </p>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard mb-2">
          Payout across rent outcomes
        </h2>
        <GrowthChart
          ariaLabel={`Renter payout across rent-growth outcomes: payout reaches ${formatDollars(q.maxPayout)} at 8% growth; you break even once growth passes ${formatGrowth(q.breakevenGrowth)}.`}
          testId="renter-chart"
          breakevenG={q.breakevenGrowth}
          breakevenLabel={`breakeven ${formatGrowth(q.breakevenGrowth)}`}
          lines={[
            {
              label: "Payout (N × r)",
              color: "var(--color-core-green)",
              points: rows.map((r) => ({ g: r.g, value: r.payout })),
            },
            {
              label: "Net (payout − cost)",
              color: "var(--color-primary-pine)",
              points: rows.map((r) => ({ g: r.g, value: r.net })),
            },
            {
              label: "Illustrative rent increase (R × max(g, 0))",
              color: "var(--color-primary-sky)",
              dashed: true,
              points: rows.map((r) => ({ g: r.g, value: r.rentIncrease })),
            },
          ]}
        />
        <ul className="mt-3 space-y-1 font-parkBody text-sm text-surface-grey-2 list-disc list-inside">
          <li>
            {p >= 1 ? "At this price the payout cannot exceed your premium. The model's price-equivalent growth is " : "Your payout exceeds the premium once index growth passes "}
            <span className="font-bold text-text-standard">
              {formatGrowth(q.breakevenGrowth)}
            </span>{" "}
            (3% + 5% × the price you paid; it does not include your remaining rent increase).
          </li>
          <li>
            Your payout maxes out at{" "}
            <span className="font-bold text-text-standard">
              {formatDollars(q.maxPayout)}
            </span>{" "}
            — growth beyond 8% doesn't pay more.
          </li>
          <li data-testid="basis-risk">
            Plainly: the payout follows the market's rent index, not your own
            lease. If your landlord raises your rent but the index stays flat,
            this pays nothing — and if the index jumps while your rent doesn't,
            you get paid anyway. You keep the RENT and its payout regardless of
            what happens to your lease.
          </li>
        </ul>
      </Card>

      <Card>
        <div className="flex flex-col gap-3">
          <LiftedButton
            width="full"
            onClick={() =>
              navigate(
                `/buy?amount=${encodeURIComponent(String(q.units))}`,
              )
            }
            data-testid="renter-buy"
          >
            Buy {formatCount(q.units)} RENT
          </LiftedButton>
          <p className="font-parkBody text-xs text-surface-grey-2">
            Continues to the checkout with {formatDollars(q.units)} of coverage
            prefilled — you can adjust it there and pay with {symbol} or
            another token. At your modeled price it costs about{" "}
            {formatDollars(q.cost)}. Checkout uses the live price, which may differ. {market.isDemo ? <DemoBadge /> : null}
          </p>
        </div>
      </Card>
    </div>
  );
}
