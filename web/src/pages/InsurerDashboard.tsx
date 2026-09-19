/**
 * /insurer — interactive dashboard for the INSURER role of the one active
 * market. Every number comes from lib/market.ts (the shared single source of
 * truth); live chain values (pool price, base print) prefill the inputs via
 * useActiveMarket, with editable assumptions for calculator scenarios.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useActiveMarket } from "../chain/useActiveMarket";
import { formatCents } from "../chain/format";
import {
  DEMO_PREMIUM_P,
  DEMO_YIELD_RATE,
  OUTCOME_GRID,
  formatGrowth,
  insurerClaimsAt,
  insurerNetAt,
  insurerQuote,
  payoutRatioFromGrowth,
  settleCentsAt,
} from "../lib/market";
import { formatCount, formatDollars } from "../lib/dollars";
import { Card, StatRow } from "../components/States";
import { SliderInput } from "../components/SliderInput";
import { GrowthChart } from "../components/GrowthChart";
import { V4Trade } from "./V4Trade";

const DEFAULT_CAPITAL = 100_000;
const DEFAULT_SOLD_PCT = 10;

export function InsurerDashboard() {
  const market = useActiveMarket();
  const symbol = market.symbol;

  const [capital, setCapital] = useState(DEFAULT_CAPITAL);
  const [p, setP] = useState(DEMO_PREMIUM_P);
  const [pTouched, setPTouched] = useState(false);
  const [yieldPct, setYieldPct] = useState(DEMO_YIELD_RATE * 100);
  const [soldPct, setSoldPct] = useState(DEFAULT_SOLD_PCT);

  // The price input follows the live market until the user edits it.
  useEffect(() => {
    if (!pTouched) setP(market.p);
  }, [market.p, pTouched]);

  const y = yieldPct / 100;
  const u = soldPct / 100;
  const q = insurerQuote(capital, p, y, u);
  const rows = OUTCOME_GRID.map((g) => {
    const net = insurerNetAt(g, capital, p, y, u);
    return {
      g,
      settleCents: settleCentsAt(market.baseCents, g),
      r: payoutRatioFromGrowth(g),
      claims: insurerClaimsAt(g, capital, u),
      net,
      endingCapital: capital + net,
      returnOnCapital: capital > 0 ? net / capital : 0,
    };
  });

  return (
    <div className="max-w-4xl mx-auto space-y-6">

      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Back this market as the insurer
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          You deposit capital; RENT is minted 1:1 against it and you sell it at
          the price you choose. You keep the premiums plus the planned yield on
          escrow — in exchange you pay every sold RENT up to $1 per token if
          the rent index rises past 3%.
        </p>
      </header>
      {market.source === "v4" ? <V4Trade mode="underwrite" /> : null}

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard mb-3">
          Your position
        </h2>
        <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
          <SliderInput
            label="Capital you put in"
            value={capital}
            onChange={setCapital}
            min={1_000}
            max={1_000_000}
            step={1_000}
            unit={symbol}
            testId="insurer-capital"
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
                ? "Set a price to explore costs and payouts."
                : "Prefilled from the live market price — edit to explore."
            }
            testId="insurer-price"
          />
          <SliderInput
            label="Annual yield · planned"
            value={yieldPct}
            onChange={setYieldPct}
            min={0}
            max={10}
            step={0.1}
            unit="%"
            testId="insurer-yield"
          />
          <SliderInput
            label="Share of RENT sold"
            value={soldPct}
            onChange={setSoldPct}
            min={0}
            max={100}
            step={1}
            unit="%"
            testId="insurer-sold"
          />
        </div>

        <div className="mt-4 border-t border-paper-1 pt-3">
          <StatRow
            label="RENT minted (1 per unit of capital)"
            value={`${formatCount(q.minted)} RENT`}
          />
          <StatRow
            label={`RENT sold (${soldPct}% of minted)`}
            value={`${formatCount(q.sold)} RENT`}
          />
          <StatRow
            label="Premium income (p × sold)"
            value={formatDollars(q.premiumIncome)}
          />
          <StatRow
            label="Yield income (y × C) — PLANNED"
            value={formatDollars(q.yieldIncome)}
          />
          <StatRow
            label="Breakeven growth (net = 0)"
            value={
              q.sold === 0 ? "— (nothing sold)" : q.worstCaseNet > 0 ? "No breakeven: positive at every outcome" : formatGrowth(q.breakevenGrowth)
            }
          />
          <StatRow
            label="Worst case net (index up 8%+)"
            value={
              <span className={q.worstCaseNet < 0 ? "text-system-red" : ""}>
                {formatDollars(q.worstCaseNet)}
              </span>
            }
          />
        </div>
        <p className="mt-2 font-parkBody text-xs text-surface-grey-2">
          The yield line is <span className="font-bold">planned</span>: today
          the escrow sits un-invested in the pool currency ({symbol}), so treat
          it as a forecast, not a promise. All results are modeled scenarios, including unsold inventory returned to the insurer.
        </p>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard mb-2">
          What each rent outcome does to you
        </h2>
        <GrowthChart
          ariaLabel={`Insurer net profit and loss across rent-growth outcomes. Breakeven at ${formatGrowth(q.breakevenGrowth)}; worst case ${formatDollars(q.worstCaseNet)} once growth reaches 8%.`}
          testId="insurer-chart"
          breakevenG={
            q.sold > 0 && q.worstCaseNet <= 0 ? q.breakevenGrowth : undefined
          }
          breakevenLabel={`breakeven ${formatGrowth(q.breakevenGrowth)}`}
          lines={[
            {
              label: "Net P&L (premium + yield − claims)",
              color: "var(--color-core-green)",
              points: rows.map((r) => ({ g: r.g, value: r.net })),
            },
            {
              label: "Claims paid (as a cost)",
              color: "var(--color-system-red)",
              dashed: true,
              points: rows.map((r) => ({ g: r.g, value: -r.claims })),
            },
          ]}
        />
        <p
          className="mt-2 font-parkBody text-sm font-bold text-text-standard"
          data-testid="insurer-takeaway"
        >
          {q.sold === 0
            ? "With nothing sold there are no claims. Only the assumed, planned yield contributes to this model."
            : q.worstCaseNet >= 0
              ? "Under these assumptions, even the maximum claim does not create a net loss."
              : `In this model you lose money if index growth exceeds ${formatGrowth(q.breakevenGrowth)}. This includes the assumed planned yield.`}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table
            className="w-full font-parkBody text-sm"
            data-testid="insurer-table"
          >
            <caption className="text-left font-parkBody text-xs text-surface-grey-2 mb-1">
              Amounts in {symbol}. Settle = base × (1 + growth).
            </caption>
            <thead>
              <tr className="text-left text-xs text-surface-grey-2 border-b border-paper-2">
                <th className="py-1.5 pr-2 font-normal">Growth</th>
                <th className="py-1.5 pr-2 font-normal">Settle ($/SF)</th>
                <th className="py-1.5 pr-2 font-normal">Payout ratio r</th>
                <th className="py-1.5 pr-2 font-normal">Claims paid</th>
                <th className="py-1.5 pr-2 font-normal">Net P&L</th>
                <th className="py-1.5 pr-2 font-normal">Ending capital</th>
                <th className="py-1.5 font-normal">Return on C</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isWorst = row.r >= 1;
                const pastBreakeven = row.net < 0;
                return (
                  <tr
                    key={row.g}
                    className={`border-b border-paper-1 last:border-b-0 ${
                      isWorst
                        ? "bg-system-red/10"
                        : pastBreakeven
                          ? "bg-system-warning/10"
                          : ""
                    }`}
                  >
                    <td className="py-1.5 pr-2 font-bold">
                      {formatGrowth(row.g, 0)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {formatCents(row.settleCents)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {(row.r * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 pr-2">{formatDollars(row.claims)}</td>
                    <td
                      className={`py-1.5 pr-2 font-bold ${row.net < 0 ? "text-system-red" : "text-core-green"}`}
                    >
                      {formatDollars(row.net)}
                    </td>
                    <td className="py-1.5 pr-2">
                      {formatDollars(row.endingCapital)}
                    </td>
                    <td className="py-1.5">
                      {(row.returnOnCapital * 100).toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 font-parkBody text-xs text-surface-grey-2">
          Highlighted rows: <span className="font-bold">amber</span> = past
          your breakeven;{" "}
          <span className="font-bold">red</span> = worst case (r = 1, every
          sold RENT pays its full $1, net {formatDollars(q.worstCaseNet)}).
        </p>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard mb-2">
          Where your capital actually sits
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2">
          Capital that backs outstanding RENT stays in escrow through settlement and the claim window — every RENT is
          backed 1:1 by money already on-chain. Counting premiums as yours, the
          most you can lose is{" "}
          <span className="font-bold text-text-standard">
            (1 − p) × u × C = {formatDollars(q.maxLossPremiumOnly)}
          </span>{" "}
          — the sold tokens' full payout minus the premiums you were paid for
          them. With the planned yield of {formatDollars(q.yieldIncome)}{" "}
          included, the worst-case net shown in the table is{" "}
          {formatDollars(q.worstCaseNet)}. Retaining unsold RENT preserves the insurer's claim on that slice of backing; this model assumes it is not sold later.
        </p>
        <details className="mt-2 font-parkBody text-xs text-surface-grey-2">
          <summary className="cursor-pointer">Legacy underwriting tools</summary>
          The hidden legacy{" "}
          <Link className="underline" to="/underwrite">
            underwriting console
          </Link>{" "}
          creates separate fixed-rate markets. It does not fund this RENT trading pool.{" "}

        </details>
      </Card>
    </div>
  );
}
