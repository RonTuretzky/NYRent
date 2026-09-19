import type { ComponentType } from "react";
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
    title: "An underwriter escrows the payout money",
    body: "Anyone can underwrite a series: they deposit the full payout capacity into the contract up front. Every unit of protection that series can ever sell is backed 1:1 by money that is already on-chain — no leverage, no promise to pay later.",
    viz: FundViz,
  },
  {
    key: "buy",
    title: "A buyer pays a premium and mints cover",
    body: "Anyone exposed to Manhattan office rents buys protection: they pay a fixed-rate premium and receive non-transferable ERC-1155 cover tokens, 1 token unit per wei of maximum claim. The matching claim amount is reserved in the pool from that moment. Series terms are immutable from the first sale — no setter even exists.",
    viz: BuyViz,
  },
  {
    key: "email",
    title: "The CRE Daily snapshot arrives",
    body: "CRE Daily's Market Snapshot newsletter reports Manhattan office rent (Avg Effective $/SF, CompStak data) and is DKIM-signed by newyork.credaily.com. That cryptographic signature — not any trusted server — is the market data feed.",
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
    body: "Holders burn cover tokens and are paid maxClaim × ratio from reserves — redemption can never be paused. After the claim window, whatever went unclaimed returns to the underwriter who escrowed it, along with the premiums.",
    viz: RedeemViz,
  },
];

export function HowItWorks() {
  const reducedMotion = useReducedMotion();
  return (
    <section id="how-it-works" data-testid="how-it-works">
      {/* role="list" restores list semantics that `list-style: none` drops
          in Safari/VoiceOver */}
      <ol role="list" className="list-none space-y-16 sm:space-y-24">
        {STEPS.map((s, i) => (
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
