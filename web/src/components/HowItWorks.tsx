import { useMemo, type ComponentType } from "react";
import { BuyViz } from "./hiw/BuyViz";
import { EmailViz } from "./hiw/EmailViz";
import { FundViz } from "./hiw/FundViz";
import { RedeemViz } from "./hiw/RedeemViz";
import { SettleViz } from "./hiw/SettleViz";
import { useInView, useReducedMotion } from "./hiw/shared";

/**
 * Crowdstake-style "how it works": a vertical sequence of five numbered step
 * rows, each pairing copy with a self-contained viz card whose micro-
 * animation loops forever, viz sides alternating row by row. Rows fade/slide
 * up once when scrolled into view; prefers-reduced-motion freezes every
 * diagram in its most informative state and makes the entrance instant.
 */

type StepKey = "fund" | "buy" | "email" | "settle" | "redeem";

interface Step {
  key: StepKey;
  title: string;
  body: string;
  viz: ComponentType<{ reducedMotion: boolean }>;
}

const STEPS: Step[] = [
  {
    key: "fund",
    title: "The insurer escrows the payout money",
    body: "The insurer deposits the full payout capacity into the contract up front, and RENT is minted 1:1 against it. Every RENT this market can ever sell is backed by money that is already on-chain — no leverage, no promise to pay later.",
    viz: FundViz,
  },
  {
    key: "buy",
    title: "A renter pays a premium and gets RENT",
    body: "Anyone exposed to the Manhattan rent index buys protection: they pay the premium and receive RENT — non-transferable ERC-1155 tokens, each paying up to $1 at settlement. The matching claim amount is reserved in the pool from that moment. The market's terms are immutable from the first sale — no setter even exists.",
    viz: BuyViz,
  },
  {
    key: "email",
    title: "The CRE Daily snapshot arrives",
    body: "CRE Daily's Market Snapshot newsletter reports the Manhattan rent index (Avg Effective $/SF, CompStak data) and is DKIM-signed by newyork.credaily.com. That cryptographic signature — not any trusted server — is the market data feed.",
    viz: EmailViz,
  },
  {
    key: "settle",
    title: "Anyone settles with the raw email",
    body: "Anyone uploads the raw email. The oracle contract verifies the RSA-2048 DKIM signature against the pinned key, checks the body hash, extracts the printed rent value, and the pool clamps it between the strikes into a payout ratio. One shot — the first qualifying email wins.",
    viz: SettleViz,
  },
  {
    key: "redeem",
    title: "Holders redeem, the rest releases",
    body: "Holders burn RENT and are paid maxClaim × ratio from reserves — redemption can never be paused. After the claim window, whatever went unclaimed returns to the insurer who escrowed it, along with the premiums.",
    viz: RedeemViz,
  },
];

type MarketExample = { lowCents: number; highCents: number; trading: boolean };

export function HowItWorks({ market }: { market?: MarketExample } = {}) {
  const reducedMotion = useReducedMotion();
  const steps = useMemo(() => {
  const exampleCents = market ? Math.round((market.lowCents + market.highCents) / 2) : 9288;
  const ratio = market ? (exampleCents - market.lowCents) / (market.highCents - market.lowCents) : 0.61;
  const result: Step[] = market ? [
    { key: "fund", title: "The insurer puts the money in first",
      body: market.trading
        ? "The insurer locks capital in escrow and receives one RENT for each dollar-stable unit deposited. That backing stays in the contract. Liquidity for trading is funded separately."
        : "The insurer deposits the full payout capacity before protection goes on sale. When a renter buys, their RENT is minted against that backing. The money stays in escrow until claims or the residual withdrawal.",
      viz: ({ reducedMotion }) => <FundViz reducedMotion={reducedMotion} marketMode /> },
    { key: "buy", title: market.trading ? "The renter buys protection" : "The renter pays once for protection",
      body: market.trading
        ? "The insurer seeds the RENT trading pool at an opening price. A renter pays the quoted premium and receives RENT. Before the cutoff, they can also sell it back if liquidity is available. Trading does not move the backing out of escrow."
        : "The renter pays the fixed premium and receives RENT, each paying up to $1 after settlement. This fixed-price version has no resale market. The price and coverage terms are shown before any wallet approval.",
      viz: ({ reducedMotion }) => <BuyViz reducedMotion={reducedMotion} trading={market.trading} /> },
    { key: "email", title: "A signed rent print sets the reference",
      body: "The real September 2026 newsletter reports $92.88 per square foot. Its publisher signature can be checked on-chain. This market measures the change from that baseline to a qualifying September 2027 print; that future print has not arrived.",
      viz: EmailViz },
    { key: "settle", title: "The contract checks the email",
      body: `Anyone can submit a qualifying signed email. The oracle checks the signature and body, then the market fixes its payout. For illustration, a future $${(exampleCents / 100).toFixed(2)} print lands halfway between the strikes and pays about 50¢ per RENT. This is an example, not a reported future value.`,
      viz: ({ reducedMotion }) => <SettleViz reducedMotion={reducedMotion} lowCents={market.lowCents} highCents={market.highCents} valueCents={exampleCents} example /> },
    { key: "redeem", title: "Holders claim. The remaining backing returns.",
      body: "RENT holders redeem before the claim deadline. In this half-payout example, 100 RENT returns about 50 stablecoin units. After the deadline, insurers recover their share of the remaining backing. Retained RENT and tokens removed from liquidity also need to be redeemed.",
      viz: ({ reducedMotion }) => <RedeemViz reducedMotion={reducedMotion} ratio={ratio} example /> },
  ] : STEPS;
  return result;
  }, [market]);
  return (
    <section id="how-it-works" data-testid="how-it-works">
      {/* role="list" restores list semantics that `list-style: none` drops
          in Safari/VoiceOver */}
      <ol role="list" className="list-none space-y-16 sm:space-y-24">
        {steps.map((s, i) => (
          <StepRow
            key={s.key}
            step={s}
            index={i}
            reducedMotion={reducedMotion}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  index,
  reducedMotion,
}: {
  step: Step;
  index: number;
  reducedMotion: boolean;
}) {
  const [ref, inView] = useInView<HTMLLIElement>(0.25);
  const flip = index % 2 === 1;
  const shown = inView || reducedMotion;
  const Viz = step.viz;
  return (
    <li
      ref={ref}
      data-testid={`hiw-step-${step.key}`}
      className={`grid items-center gap-8 lg:grid-cols-2 lg:gap-16 ${
        reducedMotion ? "" : "transition-all duration-700 ease-out"
      } ${shown ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"}`}
    >
      <div className={flip ? "lg:order-2" : undefined}>
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="font-parkDisplay flex h-10 w-10 flex-none items-center justify-center rounded-full bg-core-green text-lg font-bold text-white"
          >
            {index + 1}
          </span>
          <h3 className="font-parkDisplay text-xl font-bold text-text-standard sm:text-2xl">
            {step.title}
          </h3>
        </div>
        <p className="font-parkBody mt-4 text-sm text-surface-grey-2 sm:text-base">
          {step.body}
        </p>
      </div>
      <div className={flip ? "lg:order-1" : undefined}>
        {/* key remount restarts the SVG's SMIL clock at 0 the moment the row
            reveals, so the diagram is never caught mid-cycle */}
        <Viz key={shown ? "live" : "idle"} reducedMotion={reducedMotion} />
      </div>
    </li>
  );
}
