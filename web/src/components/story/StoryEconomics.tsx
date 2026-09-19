import { useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useActiveMarket } from "../../chain/useActiveMarket";
import { isLiveDeployment, useActiveDeployment } from "../../chain/registry";
import { useV4Market } from "../../chain/v4";
import { formatCents } from "../../chain/format";
import {
  ACTIVE_MARKET_ID, DEMO_BASE_CENTS, DEMO_PREMIUM_P, OUTCOME_GRID, formatGrowth,
  impliedGrowth, impliedRentCents, insurerClaimsAt, insurerNetAt, insurerQuote,
} from "../../lib/market";
import { formatDollars } from "../../lib/dollars";
import { GrowthChart } from "../GrowthChart";
import { V4PriceHistory } from "../V4PriceHistory";
import "./StoryEconomics.css";

/** Presenter controls are calculation assumptions. They never open a wallet. */
export function StoryInsurerEconomics() {
  const [capital, setCapital] = useState(100_000);
  const [price, setPrice] = useState(DEMO_PREMIUM_P);
  const [soldPct, setSoldPct] = useState(40);
  const [growthPct, setGrowthPct] = useState(5);
  const sold = soldPct / 100;
  const growth = growthPct / 100;
  const quote = insurerQuote(capital, price, 0, sold);
  const claims = insurerClaimsAt(growth, capital, sold);
  const net = insurerNetAt(growth, capital, price, 0, sold);

  return <div className="story-economics" data-testid="story-insurer-economics">
    <div className="story-economics-inputs" aria-label="Insurer calculation assumptions">
      <NumberChip label="Capital" value={capital} onChange={setCapital} min={1_000} max={1_000_000} step={1_000} testId="story-capital" />
      <NumberChip label="Avg. RENT price" value={price} onChange={setPrice} min={0} max={1} step={0.005} testId="story-price" />
      <NumberChip label="RENT sold %" value={soldPct} onChange={setSoldPct} min={0} max={100} step={1} testId="story-sold" />
    </div>
    <div className="story-economics-main">
      <dl className="story-economics-totals" aria-live="polite">
        <div><dt>Premiums in</dt><dd data-testid="story-premium">{formatDollars(quote.premiumIncome)}</dd></div>
        <div><dt>Claims out</dt><dd data-testid="story-claims">{formatDollars(claims)}</dd></div>
        <div><dt>Net at this outcome</dt><dd className={net < 0 ? "story-negative" : "story-positive"} data-testid="story-net">{formatDollars(net)}</dd></div>
      </dl>
      <div className="story-economics-chart-controls">
        <div className="story-insurer-chart">
          <GrowthChart
            testId="story-insurer-chart"
            ariaLabel="Insurer net profit and claims across rent growth outcomes"
            selectedG={growth}
            breakevenG={sold > 0 ? quote.breakevenGrowth : undefined}
            breakevenLabel={`break even ${formatGrowth(quote.breakevenGrowth)}`}
            lines={[
              { label: "Net (premium − claims)", color: "var(--color-core-green)", points: OUTCOME_GRID.map(g => ({ g, value: insurerNetAt(g, capital, price, 0, sold) })) },
              { label: "Claims paid", color: "var(--color-system-red)", dashed: true, points: OUTCOME_GRID.map(g => ({ g, value: -insurerClaimsAt(g, capital, sold) })) },
            ]}
          />
        </div>
        <label className="story-outcome-label" htmlFor="story-growth">Where rent lands in Sep 2027 <strong>{formatGrowth(growth)}</strong></label>
        <input id="story-growth" className="rent-range story-outcome-slider" style={{ "--range-progress": `${(growthPct - OUTCOME_GRID[0] * 100) / ((OUTCOME_GRID[OUTCOME_GRID.length - 1] - OUTCOME_GRID[0]) * 100) * 100}%` } as CSSProperties} type="range" min={OUTCOME_GRID[0] * 100} max={OUTCOME_GRID[OUTCOME_GRID.length - 1] * 100} step="0.1" value={growthPct} onChange={event => setGrowthPct(Number(event.target.value))} aria-valuetext={formatGrowth(growth)} data-testid="story-growth" />
      </div>
    </div>
    <div className="story-economics-footer">
      <p>Modeled sales; LP fees excluded. Max loss: <strong data-testid="story-insurer-max-loss">{formatDollars(quote.maxLossPremiumOnly)}</strong>.</p>
      <p>Backing stays in escrow until claims are paid. <Link to="/insurer">Full insurer breakdown ↗</Link></p>
    </div>
  </div>;
}

/** Same current-market hook and capped-payout mapping as /market-view. */
export function StoryMarketForecast() {
  const market = useActiveMarket();
  const v4 = useV4Market();
  const { deployment } = useActiveDeployment();
  const undeployed = !v4.deployment && (!isLiveDeployment(deployment) || !deployment.seriesIds.includes(ACTIVE_MARKET_ID));
  const unavailable = !undeployed && (market.isDemo || market.rpcError);
  const price = undeployed ? DEMO_PREMIUM_P : market.p;
  const base = undeployed ? DEMO_BASE_CENTS : market.baseCents;
  const growth = impliedGrowth(price);
  const rent = impliedRentCents(base, price);
  const unavailableLabel = market.isLoading ? "Reading the live market…" : "Live market data unavailable";

  return <div className="story-forecast" data-testid="story-market-forecast">
    <p className="story-copy">Each RENT pays the final payout ratio. Trading prices that payoff.</p>
    <div className="story-forecast-status" role="status">
      {undeployed ? <span className="story-data-badge" data-testid="story-forecast-demo">Demo · market not deployed</span> : unavailable ? <span data-testid="story-forecast-unavailable">{unavailableLabel}</span> : <span>{market.source === "v4" ? "Live pool price" : "Fixed-rate market"} · {deployment.name}</span>}
    </div>
    <div className="story-forecast-values">
      <ForecastValue label="RENT price" value={unavailable ? "—" : price.toFixed(3)} unit={`${market.symbol} per RENT`} testId="story-market-price" />
      <ArrowRightIcon aria-hidden="true" className="story-forecast-arrow" />
      <ForecastValue label="Price-implied growth" value={unavailable ? "—" : formatGrowth(growth)} unit="September 2027" testId="story-implied-growth" />
      <ArrowRightIcon aria-hidden="true" className="story-forecast-arrow" />
      <ForecastValue label="Price-implied rent" value={unavailable || (!undeployed && market.baseIsDemo) ? "—" : formatCents(rent)} unit="per square foot" testId="story-implied-rent" emphasis />
    </div>
    <div className="story-forecast-history">
      {!unavailable && market.source === "v4" ? <V4PriceHistory presentation /> : <div className="story-history-empty" role="status">{undeployed ? "No live swap history on this network." : unavailable ? "Swap history is unavailable until the market reconnects." : "This fixed-rate market has no Uniswap swap history."}</div>}
    </div>
    <p className="story-forecast-caveat">Price-implied growth maps a capped payout. It is not expected rent growth.</p>
  </div>;
}

function ForecastValue({ label, value, unit, testId, emphasis = false }: { label: string; value: string; unit: string; testId: string; emphasis?: boolean }) {
  return <div className="story-forecast-value"><p>{label}</p><strong className={emphasis ? "story-positive" : ""} data-testid={testId}>{value}</strong><span>{unit}</span></div>;
}

function NumberChip({ label, value, onChange, min, max, step, testId }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number; step: number; testId: string }) {
  const [text, setText] = useState(String(value));
  return <label className="story-number-chip"><span>{label}</span><input type="number" inputMode="decimal" min={min} max={max} step={step} value={text} onChange={event => {
    setText(event.currentTarget.value);
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
  }} onBlur={() => {
    const parsed = Number(text);
    const next = text.trim() !== "" && Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setText(String(next)); onChange(next);
  }} data-testid={testId} /></label>;
}
