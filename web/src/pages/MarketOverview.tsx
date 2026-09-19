/**
 * Page 1 — "/" — What this market offers. Plain-language explainer for the
 * ONE market: money-flow diagram among PLATFORM / INSURER / RENTER (hiw
 * visual language), live market numbers, the payout-ratio curve in
 * both $/SF and YoY %, three role cards (provides / is obligated to), and
 * the animated how-it-works walkthrough below.
 */
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LiftedButton, Chip } from "@decentralpark/ui";
import {
  ArrowRightIcon,
  BankIcon,
  ShieldCheckIcon,
  UserIcon,
  VaultIcon,
} from "@phosphor-icons/react";
import { PayoutCurve } from "../components/PayoutCurve";
import { Card, RpcStaleBanner } from "../components/States";
import {
  C,
  DotStream,
  IconBox,
  PulseRing,
  Track,
  VizCard,
  useReducedMotion,
} from "../components/hiw/shared";
import { useActiveMarket } from "../chain/useActiveMarket";
import { useActiveDeployment } from "../chain/registry";
import { formatCents, formatCurrency, formatDate } from "../chain/format";
import { COVERAGE_CEIL, COVERAGE_FLOOR } from "../lib/market";

const HowItWorks = lazy(() => import("../components/HowItWorks").then((m) => ({ default: m.HowItWorks })));

export function MarketOverview() {
  const m = useActiveMarket();
  const { deployment } = useActiveDeployment();
  const { symbol, decimals } = m;
  const walkthrough = useMemo(() => ({ lowCents: m.strikeLowCents, highCents: m.strikeHighCents, trading: m.source !== "fixed" }), [m.strikeLowCents, m.strikeHighCents, m.source]);
  const floorPct = Math.round(COVERAGE_FLOOR * 100);
  const ceilPct = Math.round(COVERAGE_CEIL * 100);

  // Settled point on the curve, when the market has settled.
  const settledPoint =
    m.settled && m.payoutRatioWad !== undefined
      ? {
          cents:
            m.strikeLowCents +
            Math.round(
              (Number(m.payoutRatioWad) / 1e18) *
                (m.strikeHighCents - m.strikeLowCents),
            ),
          ratioWad: m.payoutRatioWad,
        }
      : undefined;

  return (
    <div className="space-y-16">

      {/* hero — what this market offers */}
      <section className="pt-8 sm:pt-14 text-center max-w-3xl mx-auto">
        <div className="flex justify-center gap-2 flex-wrap mb-6">
          <Chip size="small">Money escrowed up front</Chip>
          <Chip size="small">1 RENT pays up to $1</Chip>
          <Chip size="small">Unaudited contracts</Chip>
        </div>
        <h1 className="font-parkDisplay font-bold text-4xl sm:text-6xl tracking-tight text-text-standard">
          Rent goes up.{" "}
          <span className="text-core-green">RentSafe helps you cover the rise.</span>
        </h1>
        <p className="font-parkBody text-lg text-surface-grey-2 mt-6">
          Pay once for protection against rising Manhattan office rents.
          Each RENT pays up to $1 from money already in escrow: payouts start
          above +{floorPct}% growth and reach the full $1 at +{ceilPct}%.
          A signed rent newsletter supplies the index.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link to="/renter">
            <LiftedButton rightIcon={<ShieldCheckIcon size={20} />}>
              I want protection
            </LiftedButton>
          </Link>
          <Link to="/insurer">
            <LiftedButton preset="secondary" rightIcon={<BankIcon size={20} />}>
              I want to back it
            </LiftedButton>
          </Link>
        </div>
        <p className="mt-5 font-parkBody text-sm text-surface-grey-2">
          <Link to="/market-view" className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-4 hover:text-core-green">Explore what the price says <ArrowRightIcon size={14} /></Link>
        </p>
      </section>

      <section id="roles" className="max-w-5xl mx-auto scroll-mt-28">
        <h2 className="font-parkDisplay font-bold text-3xl text-text-standard text-center mb-6">
          Three roles, one fully backed market
        </h2>
        <div className="grid sm:grid-cols-3 gap-5">
          <RoleCard
            icon={<VaultIcon size={28} weight="bold" />}
            name="PLATFORM"
            provides={["Sets the index, signed-email oracle, base value, 3–8% band and dates."]}
            obligations={["Terms stay fixed in code. The contract holds the backing and enforces payouts."]}
          />
          <RoleCard
            icon={<BankIcon size={28} weight="bold" />}
            name="INSURER"
            provides={[`Deposits ${symbol} to mint RENT 1:1, then pairs RENT with additional ${symbol} as liquidity at the current pool price.`]}
            obligations={["Backing stays in escrow. Trading proceeds and remaining inventory belong to the LP position."]}
          />
          <RoleCard
            icon={<UserIcon size={28} weight="bold" />}
            name="RENTER"
            provides={[`Buys RENT with ${symbol} at the live pool price, or sells it while trading is open.`]}
            obligations={["No further payment. Redeem RENT for the final payout, up to $1 each, before the claim deadline."]}
          />
        </div>
        <details className="mt-5 max-w-3xl mx-auto rounded-2xl border border-paper-2 bg-paper-0 p-5">
          <summary className="cursor-pointer font-parkDisplay font-bold text-text-standard">Follow the money</summary>
          <div className="mt-5"><MoneyFlowViz symbol={symbol} /></div>
        </details>
      </section>

      {/* Restore the original alternating, animated visual walkthrough. */}
      <section id="how-it-works" className="max-w-5xl mx-auto scroll-mt-28">
        <div className="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">How it works</h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            Money goes in first. A renter buys protection. A signed newsletter
            sets the result. Follow the money through each step.
          </p>
        </div>
        <Suspense fallback={<div className="nrc-skeleton h-72 rounded-3xl" />}>
          <HowItWorks market={walkthrough} />
        </Suspense>
      </section>

      {/* live numbers */}
      <section id="current-market" className="max-w-5xl mx-auto space-y-4 scroll-mt-28">
        <h2 className="font-parkDisplay font-bold text-3xl text-text-standard text-center">
          The market right now
        </h2>
        <p className="text-center font-parkBody text-sm text-surface-grey-2">
          {m.source === "v4" ? `Uniswap v4 on ${deployment.name} · ` : ""}
          <Link to="/buy" className="underline decoration-dotted underline-offset-4 hover:text-core-green">Buy &amp; Sell</Link>
          {" · "}<Link to="/docs/uniswap" className="underline decoration-dotted underline-offset-4 hover:text-core-green">How the pool works</Link>
          {" · "}<Link to="/docs" className="underline decoration-dotted underline-offset-4 hover:text-core-green">Rent index &amp; source</Link>
        </p>
        {m.rpcError ? <RpcStaleBanner /> : null}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Stat
            label="Base (Sep 2026)"
            value={m.baseIsDemo ? "—" : `${formatCents(m.baseCents)} /SF`}
            sub="the starting rent print"
          />
          <Stat
            label={`Payouts start (+${floorPct}%)`}
            value={m.isDemo ? "—" : `${formatCents(m.strikeLowCents)} /SF`}
          />
          <Stat
            label={`Full payout (+${ceilPct}%)`}
            value={m.isDemo ? "—" : `${formatCents(m.strikeHighCents)} /SF`}
          />
          <Stat
            label="RENT price now"
            value={m.isDemo ? "—" : `${m.p.toFixed(3)} ${symbol}`}
            sub={m.source === "v4" ? "Uniswap v4 spot price" : m.isDemo ? "Price unavailable" : "fixed-rate purchase price"}
          />
          <Stat
            label="In escrow"
            value={
              m.escrow !== undefined
                ? formatCurrency(m.escrow, { decimals, symbol })
                : "—"
            }
            sub="backs every RENT 1:1"
          />
          <Stat
            label={m.source === "v4" ? "RENT outstanding" : "RENT sold"}
            value={
              (m.supply ?? m.sold) !== undefined
                ? formatCurrency(m.supply ?? m.sold, { decimals, symbol: "RENT" })
                : "—"
            }
            sub={m.source === "v4" ? "includes insurer and LP inventory" : undefined}
          />
          <Stat label="Sale closes" value={formatDate(m.saleEnd)} />
          <Stat
            label="Measured"
            value={`${formatDate(m.obsStart)} – ${formatDate(m.obsEnd)}`}
            sub="a qualifying signed September print"
          />
          <Stat label="Claim payouts by" value={formatDate(m.redeemEnd)} />
        </div>
      </section>

      {/* payout curve, $/SF and YoY % */}
      <section className="max-w-3xl mx-auto">
        <div className="text-center mb-6">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">
            How the payout is decided
          </h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            The September 2027 print is compared to the base. At or below +
            {floorPct}% year-over-year growth the payout ratio is 0; at or
            above +{ceilPct}% it is 1; in between it slides linearly. Each
            RENT redeems for ratio × $1 from escrow.
          </p>
        </div>
        <div className="bg-paper-0 border-2 border-paper-2 rounded-2xl p-6">
          <PayoutCurve
            lowCents={m.strikeLowCents}
            highCents={m.strikeHighCents}
            yoyBaseCents={m.baseCents}
            settledCents={settledPoint?.cents}
            ratioWad={settledPoint?.ratioWad}
          />
        </div>
      </section>

      <p className="font-parkBody text-xs text-surface-grey text-center max-w-3xl mx-auto">
        Ready?{" "}
        <Link to="/renter" className="underline decoration-dotted">
          Price your protection
        </Link>{" "}
        or{" "}
        <Link to="/market-view" className="underline decoration-dotted inline-flex items-center gap-1">
          see what the price forecasts <ArrowRightIcon size={12} />
        </Link>
        .
      </p>
    </div>
  );
}

/* ------------------------------ local pieces ------------------------------ */

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-paper-0 border-2 border-paper-2 rounded-2xl px-4 py-3.5">
      <div className="font-parkBody text-xs text-surface-grey-2 flex items-center gap-1.5">
        {label}
      </div>
      <div className="font-parkDisplay font-bold text-xl text-text-standard mt-1">
        {value}
      </div>
      {sub ? (
        <div className="font-parkBody text-[11px] text-surface-grey mt-0.5">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function RoleCard({
  icon,
  name,
  provides,
  obligations,
}: {
  icon: ReactNode;
  name: string;
  provides: string[];
  obligations: string[];
}) {
  return (
    <Card>
      <div className="text-core-green">{icon}</div>
      <h3 className="font-parkDisplay font-bold text-lg text-text-standard mt-3 tracking-wide">
        {name}
      </h3>
      <p className="font-parkBody text-xs font-bold uppercase tracking-wide text-surface-grey mt-3">
        Provides
      </p>
      <ul className="font-parkBody text-sm text-surface-grey-2 mt-1 space-y-1.5 list-disc pl-4">
        {provides.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p className="font-parkBody text-xs font-bold uppercase tracking-wide text-surface-grey mt-4">
        Is obligated to
      </p>
      <ul className="font-parkBody text-sm text-surface-grey-2 mt-1 space-y-1.5 list-disc pl-4">
        {obligations.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * One SVG money-flow loop among the three roles (hiw visual language):
 * capital → escrow, premium → LP inventory, RENT → renter, residual →
 * insurer after the claim deadline, settlement payout → renter. Reduced motion freezes to the
 * labeled diagram.
 */
const FLOW_DUR = "9s";
const P_CAPITAL = "M 88 100 C 88 152 128 184 190 200";
const P_PREMIUM = "M 322 44 L 166 44";
const P_RENT = "M 158 74 L 314 74";
const P_RESIDUAL = "M 166 244 C 92 238 52 176 52 108";
const P_PAYOUT = "M 314 244 C 388 238 428 176 428 108";

function ArrowHead({
  x,
  y,
  angle,
  color,
}: {
  x: number;
  y: number;
  angle: number;
  color: string;
}) {
  return (
    <path
      d="M 0 0 L -9 -4.5 L -9 4.5 Z"
      transform={`translate(${x} ${y}) rotate(${angle})`}
      fill={color}
    />
  );
}

function FlowLabel({
  x,
  y,
  children,
  anchor = "middle",
}: {
  x: number;
  y: number;
  children: string;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={10}
      fill={C.grey2}
      fontFamily="var(--font-parkBody)"
    >
      {children}
    </text>
  );
}

function MoneyFlowViz({ symbol }: { symbol: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <VizCard caption="backing stays in escrow · RENT trades through the pool · payouts follow the index">
      <svg
        viewBox="0 0 480 300"
        className="w-full h-auto"
        role="img"
        aria-label={`Money flow: the insurer's capital goes into the platform's escrow and RENT is minted 1:1; renters exchange ${symbol} for RENT through the trading pool; at settlement the escrow pays each RENT its ratio times one dollar-stable unit. After the claim deadline, the remaining backing can return to the original insurers.`}
      >
        <Track d={P_CAPITAL} />
        <Track d={P_PREMIUM} />
        <Track d={P_RENT} />
        <Track d={P_RESIDUAL} />
        <Track d={P_PAYOUT} />

        {/* direction arrows (always visible, informative when frozen) */}
        <ArrowHead x={190} y={200} angle={25} color={C.green} />
        <ArrowHead x={166} y={44} angle={180} color={C.green} />
        <ArrowHead x={314} y={74} angle={0} color={C.sky} />
        <ArrowHead x={52} y={108} angle={-90} color={C.pine} />
        <ArrowHead x={428} y={108} angle={-90} color={C.green} />

        <FlowLabel x={112} y={158}>capital, escrowed</FlowLabel>
        <FlowLabel x={240} y={36}>premium via pool</FlowLabel>
        <FlowLabel x={240} y={90}>RENT via pool</FlowLabel>
        <FlowLabel x={30} y={185} anchor="start">remaining backing*</FlowLabel>
        <FlowLabel x={436} y={168} anchor="end">payout r × $1</FlowLabel>

        <IconBox
          x={18}
          y={18}
          w={140}
          h={82}
          color={C.green}
          title="INSURER"
          sub="backs the market"
          icon={<BankIcon size={22} color={C.green} weight="bold" />}
        />
        <IconBox
          x={322}
          y={18}
          w={140}
          h={82}
          color={C.sky}
          title="RENTER"
          sub="buys protection"
          icon={<UserIcon size={22} color={C.sky} weight="bold" />}
        />
        <IconBox
          x={162}
          y={196}
          w={156}
          h={86}
          color={C.pine}
          title="PLATFORM"
          sub={`escrow · 1 RENT ⇔ 1 ${symbol}`}
          icon={<VaultIcon size={22} color={C.pine} weight="bold" />}
        />

        {reducedMotion ? null : (
          <>
            {/* one choreographed cycle: fund → trade → settle → residual */}
            <DotStream
              path={P_CAPITAL}
              color={C.green}
              dur={FLOW_DUR}
              windows={[
                [0.04, 0.14],
                [0.1, 0.2],
              ]}
            />
            <DotStream
              path={P_PREMIUM}
              color={C.green}
              dur={FLOW_DUR}
              windows={[[0.3, 0.42]]}
            />
            <DotStream
              path={P_RENT}
              color={C.sky}
              dur={FLOW_DUR}
              windows={[[0.34, 0.46]]}
            />
            <DotStream
              path={P_RESIDUAL}
              color={C.pine}
              dur={FLOW_DUR}
              windows={[[0.83, 0.95]]}
              r={3.5}
            />
            <DotStream
              path={P_PAYOUT}
              color={C.green}
              dur={FLOW_DUR}
              windows={[
                [0.74, 0.86],
                [0.78, 0.9],
              ]}
            />
            <PulseRing
              x={162}
              y={196}
              w={156}
              h={86}
              rx={14}
              color={C.pine}
              phases={[0.2]}
              dur={FLOW_DUR}
            />
            <PulseRing
              x={18}
              y={18}
              w={140}
              h={82}
              rx={14}
              color={C.green}
              phases={[0.42, 0.95]}
              dur={FLOW_DUR}
            />
            <PulseRing
              x={322}
              y={18}
              w={140}
              h={82}
              rx={14}
              color={C.sky}
              phases={[0.46, 0.9]}
              dur={FLOW_DUR}
            />
          </>
        )}
      </svg>
      <p className="font-parkBody text-xs text-surface-grey-2 text-center mt-2">*Remaining backing is claimable by original insurers after the redemption deadline. LP sale proceeds stay in the trading position until withdrawn.</p>
    </VizCard>
  );
}
