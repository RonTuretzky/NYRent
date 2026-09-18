import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BankIcon,
  CaretRightIcon,
  EnvelopeSimpleIcon,
  HandCoinsIcon,
  PauseIcon,
  PlayIcon,
  SealCheckIcon,
  UserIcon,
} from "@phosphor-icons/react";

/**
 * Crowdstake-style "how it works" explainer, rebuilt by hand for our 5-step
 * flow. Mechanics reproduced from crowdstake.fun: a stage diagram whose
 * actors light up and whose value-flows animate per step; a numbered step
 * tab bar (click selects + pauses); prev/next + play/pause controls;
 * autoplay advancing every 4.2 s with wrap-around; prefers-reduced-motion
 * honored. All artwork is our own SVG in Decentral Park brand colors.
 */

type StepKey = "fund" | "buy" | "email" | "settle" | "redeem";

interface Step {
  key: StepKey;
  short: string;
  title: string;
  chip: string;
  body: string;
  icon: ReactNode;
}

const STEPS: Step[] = [
  {
    key: "fund",
    short: "Fund",
    title: "The sponsor collateralizes the pool",
    chip: "Fully collateralized",
    body: "The sponsor deposits WXDAI into the cover pool up front. Every unit of protection the pool can ever sell is backed 1:1 by capital that is already on-chain — there is no leverage and no promise to pay later.",
    icon: <BankIcon size={28} weight="bold" />,
  },
  {
    key: "buy",
    short: "Buy",
    title: "A buyer pays a premium and mints cover",
    chip: "Premium in, cover out",
    body: "Anyone exposed to Manhattan office rents buys protection: they pay a fixed-rate premium and receive non-transferable ERC-1155 cover tokens, 1 token unit per wei of maximum claim. The matching claim amount is reserved in the pool from that moment.",
    icon: <HandCoinsIcon size={28} weight="bold" />,
  },
  {
    key: "email",
    short: "Email",
    title: "The CRE Daily snapshot email arrives",
    chip: "DKIM-signed data",
    body: "CRE Daily's Market Snapshot newsletter reports Manhattan office rent (Avg Effective $/SF, CompStak data) and is DKIM-signed by newyork.credaily.com. That cryptographic signature — not any trusted server — is the market data feed.",
    icon: <EnvelopeSimpleIcon size={28} weight="bold" />,
  },
  {
    key: "settle",
    short: "Settle",
    title: "The email settles the series on-chain",
    chip: "No trusted oracle",
    body: "Anyone uploads the raw email. The oracle contract verifies the RSA-2048 DKIM signature against the pinned key, checks the body hash, extracts the printed rent value, and the pool clamps it between the strikes into a payout ratio. One shot — the first qualifying email wins.",
    icon: <SealCheckIcon size={28} weight="bold" />,
  },
  {
    key: "redeem",
    short: "Redeem",
    title: "Cover holders redeem, the rest releases",
    chip: "Claims always payable",
    body: "Holders burn cover tokens and are paid maxClaim × ratio from reserves — redemption can never be paused. After the claim window, unclaimed reserves release back to the sponsor's free capital.",
    icon: <UserIcon size={28} weight="bold" />,
  },
];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  const mql = useRef<MediaQueryList | null>(null);
  useEffect(() => {
    mql.current = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mql.current?.matches ?? false);
    update();
    mql.current.addEventListener("change", update);
    return () => mql.current?.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function HowItWorks() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const reducedMotion = useReducedMotion();
  const step = STEPS[index].key;

  // autoplay — advance every 4.2 s, wrap; stops when user drives manually
  useEffect(() => {
    if (!playing || reducedMotion) return;
    const t = window.setTimeout(
      () => setIndex((i) => (i + 1) % STEPS.length),
      4200,
    );
    return () => window.clearTimeout(t);
  }, [index, playing, reducedMotion]);

  const select = useCallback((i: number) => {
    setIndex(((i % STEPS.length) + STEPS.length) % STEPS.length);
    setPlaying(false);
  }, []);

  return (
    <section id="how-it-works" data-testid="how-it-works">
      <div className="border-2 border-paper-2 bg-paper-0 rounded-3xl overflow-hidden shadow-xl">
        <Stage step={step} reducedMotion={reducedMotion} />

        {/* step tab bar */}
        <div className="border-t border-paper-2 bg-paper-1">
          <ol className="flex flex-wrap">
            {STEPS.map((s, i) => {
              const current = i === index;
              return (
                <li key={s.key} className="flex-1 basis-28">
                  <button
                    type="button"
                    onClick={() => select(i)}
                    aria-current={current ? "step" : undefined}
                    data-testid={`hiw-step-${s.key}`}
                    className={`group flex w-full items-center gap-2 border-b-2 px-3 py-3 transition-colors ${
                      current
                        ? "border-core-green bg-paper-0"
                        : "border-transparent hover:bg-paper-0/60"
                    }`}
                  >
                    <span
                      className={`font-parkDisplay flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-bold transition-colors ${
                        current
                          ? "bg-core-green text-white"
                          : "bg-paper-2 text-surface-grey-2 group-hover:text-text-standard"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`text-left text-sm font-semibold font-parkBody transition-colors ${
                        current ? "text-text-standard" : "text-surface-grey-2"
                      }`}
                    >
                      {s.short}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        {/* caption + controls */}
        <Caption
          index={index}
          playing={playing}
          reducedMotion={reducedMotion}
          onPrev={() => select(index - 1)}
          onNext={() => select(index + 1)}
          onTogglePlay={() => setPlaying((p) => !p)}
        />
      </div>
    </section>
  );
}

function Caption({
  index,
  playing,
  reducedMotion,
  onPrev,
  onNext,
  onTogglePlay,
}: {
  index: number;
  playing: boolean;
  reducedMotion: boolean;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
}) {
  const s = STEPS[index];
  return (
    <div className="grid gap-6 p-6 sm:grid-cols-[auto_1fr_auto] sm:items-start sm:p-8">
      <div className="bg-green-0/40 text-green-2 flex h-14 w-14 flex-none items-center justify-center rounded-2xl">
        {s.icon}
      </div>
      <div key={s.key} className={reducedMotion ? undefined : "animate-nrc-fade-in"}>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-parkDisplay font-bold text-xl text-text-standard">
            {s.title}
          </h3>
          <span className="font-parkBody text-xs font-bold text-primary-pine border border-primary-pine rounded-full px-3 py-0.5">
            {s.chip}
          </span>
        </div>
        <p className="font-parkBody text-sm text-surface-grey-2 mt-2 max-w-2xl">
          {s.body}
        </p>
      </div>
      <div className="flex items-center gap-2 sm:flex-col">
        <RoundButton label="Previous step" onClick={onPrev}>
          <CaretRightIcon size={18} weight="bold" className="rotate-180" />
        </RoundButton>
        <RoundButton
          label={playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
          highlight
        >
          {playing ? (
            <PauseIcon size={18} weight="fill" />
          ) : (
            <PlayIcon size={18} weight="fill" />
          )}
        </RoundButton>
        <RoundButton label="Next step" onClick={onNext}>
          <CaretRightIcon size={18} weight="bold" />
        </RoundButton>
      </div>
    </div>
  );
}

function RoundButton({
  label,
  onClick,
  highlight,
  children,
}: {
  label: string;
  onClick: () => void;
  highlight?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
        highlight
          ? "border-core-green text-core-green hover:bg-core-green hover:text-white"
          : "border-paper-2 text-surface-grey-2 hover:border-core-green hover:text-core-green"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The stage: one hand-built SVG, actors lit + flows animated per step */
/* ------------------------------------------------------------------ */

const C = {
  green: "var(--color-core-green)",
  green0: "var(--color-green-0)",
  green2: "var(--color-green-2)",
  pine: "var(--color-primary-pine)",
  sky: "var(--color-primary-sky)",
  paper1: "var(--color-paper-1)",
  paper2: "var(--color-paper-2)",
  ink: "var(--color-surface-ink)",
  grey: "var(--color-surface-grey)",
  grey2: "var(--color-surface-grey-2)",
  white: "#ffffff",
  red: "var(--color-system-red)",
};

function Stage({
  step,
  reducedMotion,
}: {
  step: StepKey;
  reducedMotion: boolean;
}) {
  const lit = {
    sponsor: step === "fund" || step === "redeem",
    buyer: step === "buy" || step === "redeem",
    pool: true,
    email: step === "email" || step === "settle",
    oracle: step === "settle",
  };
  const flow = {
    fund: step === "fund",
    premium: step === "buy",
    mint: step === "buy",
    verify: step === "settle",
    ratio: step === "settle",
    payout: step === "redeem",
    residual: step === "redeem",
  };
  // vault interior state
  const funded = true; // capital always drawn; grows on "fund"
  const premiumLayer = step !== "fund";
  const splitLine = step === "settle" || step === "redeem";

  const dur = reducedMotion ? "0ms" : "700ms";

  return (
    <div className="bg-paper-0 p-4 sm:p-8">
      <svg
        viewBox="0 0 920 380"
        className="w-full h-auto"
        role="img"
        aria-label="Diagram of the cover lifecycle: sponsor funds the pool, a buyer pays a premium and mints cover, the CRE Daily email arrives, on-chain DKIM settlement fixes the payout ratio, and holders redeem."
      >
        <defs>
          <marker
            id="hiw-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>

        {/* ------------- connectors (base + active overlay) ------------- */}
        <Flow
          d="M 170 105 C 250 105 280 140 330 160"
          active={flow.fund}
          color={C.green}
          label="WXDAI collateral"
          labelAt={{ x: 240, y: 92 }}
          reducedMotion={reducedMotion}
        />
        <Flow
          d="M 170 285 C 250 285 280 245 330 225"
          active={flow.premium}
          color={C.green}
          label="premium"
          labelAt={{ x: 236, y: 300 }}
          reducedMotion={reducedMotion}
        />
        <Flow
          d="M 330 260 C 285 285 255 320 185 320"
          active={flow.mint}
          color={C.sky}
          label="cover tokens (ERC-1155)"
          labelAt={{ x: 262, y: 345 }}
          reducedMotion={reducedMotion}
        />
        <Flow
          d="M 750 105 C 700 105 690 130 668 150"
          active={flow.verify}
          color={C.pine}
          label="raw .eml bytes"
          labelAt={{ x: 705, y: 92 }}
          reducedMotion={reducedMotion}
        />
        <Flow
          d="M 610 190 C 585 190 575 190 552 190"
          active={flow.ratio}
          color={C.pine}
          label="payout ratio"
          labelAt={{ x: 582, y: 172 }}
          reducedMotion={reducedMotion}
        />
        <Flow
          d="M 380 262 C 330 300 260 320 190 320"
          active={flow.payout}
          color={C.green}
          label="claim payout"
          labelAt={{ x: 280, y: 318 }}
          reducedMotion={reducedMotion}
          hidden={!flow.payout}
        />
        <Flow
          d="M 380 150 C 320 120 250 105 180 105"
          active={flow.residual}
          color={C.pine}
          label="released reserves"
          labelAt={{ x: 268, y: 128 }}
          reducedMotion={reducedMotion}
          hidden={!flow.residual}
        />

        {/* ----------------------- actors ----------------------- */}
        <ActorNode
          x={40}
          y={60}
          w={130}
          h={90}
          lit={lit.sponsor}
          color={C.green}
          title="Sponsor"
          sub="funds capacity"
          dur={dur}
          glyph={<SponsorGlyph lit={lit.sponsor} />}
        />
        <ActorNode
          x={40}
          y={240}
          w={130}
          h={90}
          lit={lit.buyer}
          color={C.sky}
          title="Buyer"
          sub="holds cover"
          dur={dur}
          glyph={<BuyerGlyph lit={lit.buyer} />}
        />
        <Vault
          funded={funded}
          premiumLayer={premiumLayer}
          splitLine={splitLine}
          draining={step === "redeem"}
          growing={step === "fund"}
          dur={dur}
        />
        <EmailNode lit={lit.email} dur={dur} arrived={step !== "fund" && step !== "buy"} />
        <OracleNode lit={lit.oracle} dur={dur} reducedMotion={reducedMotion} />

        {/* footer note */}
        <text
          x={460}
          y={372}
          textAnchor="middle"
          fontSize={12}
          fill={C.grey}
          fontFamily="var(--font-parkBody)"
        >
          Anyone can submit the authentic email — settlement is permissionless,
          one-shot, and verified entirely on-chain.
        </text>
      </svg>
    </div>
  );
}

function Flow({
  d,
  active,
  color,
  label,
  labelAt,
  reducedMotion,
  hidden,
}: {
  d: string;
  active: boolean;
  color: string;
  label: string;
  labelAt: { x: number; y: number };
  reducedMotion: boolean;
  hidden?: boolean;
}) {
  return (
    <g
      style={{
        opacity: hidden && !active ? 0.18 : 1,
        transition: reducedMotion ? undefined : "opacity 500ms ease",
      }}
    >
      {/* base track */}
      <path
        d={d}
        fill="none"
        stroke={active ? color : C.paper2}
        strokeWidth={active ? 3 : 2.5}
        markerEnd="url(#hiw-arrow)"
        style={{
          transition: reducedMotion ? undefined : "stroke 500ms ease",
        }}
      />
      {/* marching value packets */}
      {active ? (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray="2 26"
          className={reducedMotion ? undefined : "nrc-flow-active"}
          opacity={0.9}
        />
      ) : null}
      <text
        x={labelAt.x}
        y={labelAt.y}
        textAnchor="middle"
        fontSize={12}
        fontWeight={active ? 700 : 400}
        fill={active ? color : C.grey}
        fontFamily="var(--font-parkBody)"
        style={{
          transition: reducedMotion ? undefined : "fill 500ms ease",
        }}
      >
        {label}
      </text>
    </g>
  );
}

function ActorNode({
  x,
  y,
  w,
  h,
  lit,
  color,
  title,
  sub,
  glyph,
  dur,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  lit: boolean;
  color: string;
  title: string;
  sub: string;
  glyph: ReactNode;
  dur: string;
}) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      style={{
        transformOrigin: `${x + w / 2}px ${y + h / 2}px`,
        scale: lit ? "1.04" : "1",
        transition: `scale ${dur} ease`,
      }}
    >
      <rect
        width={w}
        height={h}
        rx={16}
        fill={lit ? C.paper1 : C.white}
        stroke={lit ? color : C.paper2}
        strokeWidth={2.5}
        style={{ transition: `stroke ${dur} ease, fill ${dur} ease` }}
      />
      <g transform={`translate(${w / 2 - 12} 14)`}>{glyph}</g>
      <text
        x={w / 2}
        y={h - 26}
        textAnchor="middle"
        fontSize={15}
        fontWeight={700}
        fill={C.ink}
        fontFamily="var(--font-parkDisplay)"
      >
        {title}
      </text>
      <text
        x={w / 2}
        y={h - 10}
        textAnchor="middle"
        fontSize={11}
        fill={C.grey2}
        fontFamily="var(--font-parkBody)"
      >
        {sub}
      </text>
    </g>
  );
}

/* hand-drawn glyphs (24x24 boxes) */
function SponsorGlyph({ lit }: { lit: boolean }) {
  const c = lit ? C.green : C.grey;
  return (
    <g stroke={c} strokeWidth={2} fill="none" strokeLinecap="round">
      <path d="M 2 9 L 12 2 L 22 9 Z" />
      <path d="M 4 9 V 20 M 9.5 9 V 20 M 14.5 9 V 20 M 20 9 V 20" />
      <path d="M 1 21 H 23" />
    </g>
  );
}

function BuyerGlyph({ lit }: { lit: boolean }) {
  const c = lit ? C.sky : C.grey;
  return (
    <g stroke={c} strokeWidth={2} fill="none" strokeLinecap="round">
      <circle cx={12} cy={7} r={4.5} />
      <path d="M 3 21 C 3 15.5 21 15.5 21 21" />
    </g>
  );
}

function Vault({
  funded,
  premiumLayer,
  splitLine,
  draining,
  growing,
  dur,
}: {
  funded: boolean;
  premiumLayer: boolean;
  splitLine: boolean;
  draining: boolean;
  growing: boolean;
  dur: string;
}) {
  // interior geometry
  const x = 340;
  const y = 120;
  const w = 210;
  const h = 150;
  const inner = { x: x + 14, y: y + 34, w: w - 28, h: h - 48 };
  const capitalH = growing ? inner.h * 0.55 : inner.h * 0.78;
  const premiumH = premiumLayer ? 14 : 0;
  const claimShare = 0.61; // demo ratio 61% for the settled slice visual

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={18}
        fill={C.white}
        stroke={C.green}
        strokeWidth={3}
      />
      <text
        x={x + w / 2}
        y={y + 22}
        textAnchor="middle"
        fontSize={15}
        fontWeight={700}
        fill={C.ink}
        fontFamily="var(--font-parkDisplay)"
      >
        Cover Pool
      </text>

      {/* capital block */}
      <rect
        x={inner.x}
        y={inner.y + inner.h - capitalH}
        width={inner.w}
        height={capitalH}
        rx={8}
        fill={C.green0}
        style={{ transition: `all ${dur} ease` }}
        opacity={funded ? (draining ? 0.55 : 1) : 0.25}
      />
      {/* premium layer stacked on top */}
      <rect
        x={inner.x}
        y={inner.y + inner.h - capitalH - premiumH - (premiumH ? 3 : 0)}
        width={inner.w}
        height={premiumH}
        rx={5}
        fill={C.green}
        opacity={premiumLayer ? 0.9 : 0}
        style={{ transition: `all ${dur} ease` }}
      />
      {/* settlement split: claim share vs released share */}
      <line
        x1={inner.x + inner.w * claimShare}
        x2={inner.x + inner.w * claimShare}
        y1={inner.y + inner.h - capitalH + 4}
        y2={inner.y + inner.h - 4}
        stroke={C.pine}
        strokeWidth={2.5}
        strokeDasharray="4 4"
        opacity={splitLine ? 1 : 0}
        style={{ transition: `opacity ${dur} ease` }}
      />
      {splitLine ? (
        <g fontFamily="var(--font-parkBody)" fontSize={10.5} fontWeight={700}>
          <text
            x={inner.x + (inner.w * claimShare) / 2}
            y={inner.y + inner.h - capitalH / 2}
            textAnchor="middle"
            fill={C.green2}
          >
            claims 61%
          </text>
          <text
            x={inner.x + inner.w * claimShare + (inner.w * (1 - claimShare)) / 2}
            y={inner.y + inner.h - capitalH / 2}
            textAnchor="middle"
            fill={C.pine}
          >
            releases
          </text>
        </g>
      ) : (
        <text
          x={inner.x + inner.w / 2}
          y={inner.y + inner.h - capitalH / 2}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
          fill={C.green2}
          fontFamily="var(--font-parkBody)"
        >
          reserved capital
        </text>
      )}
      <text
        x={x + w / 2}
        y={y + h + 18}
        textAnchor="middle"
        fontSize={11}
        fill={C.grey2}
        fontFamily="var(--font-parkBody)"
      >
        Σ reserved ≤ balance, always
      </text>
    </g>
  );
}

function EmailNode({
  lit,
  arrived,
  dur,
}: {
  lit: boolean;
  arrived: boolean;
  dur: string;
}) {
  const x = 750;
  const y = 62;
  const w = 140;
  const h = 86;
  return (
    <g
      style={{
        opacity: arrived ? 1 : 0.35,
        transition: `opacity ${dur} ease`,
      }}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={14}
        fill={lit ? C.paper1 : C.white}
        stroke={lit ? C.pine : C.paper2}
        strokeWidth={2.5}
        className={lit ? "animate-nrc-pulse" : undefined}
        style={{ transition: `stroke ${dur} ease` }}
      />
      {/* envelope glyph */}
      <g
        transform={`translate(${x + w / 2 - 15} ${y + 12})`}
        stroke={lit ? C.pine : C.grey}
        strokeWidth={2}
        fill="none"
      >
        <rect width={30} height={20} rx={3} />
        <path d="M 1 2 L 15 12 L 29 2" />
      </g>
      <text
        x={x + w / 2}
        y={y + h - 26}
        textAnchor="middle"
        fontSize={13}
        fontWeight={700}
        fill={C.ink}
        fontFamily="var(--font-parkDisplay)"
      >
        CRE Daily email
      </text>
      <text
        x={x + w / 2}
        y={y + h - 11}
        textAnchor="middle"
        fontSize={10.5}
        fill={C.grey2}
        fontFamily="var(--font-parkBody)"
      >
        “$92.88 / SF” · DKIM signed
      </text>
    </g>
  );
}

function OracleNode({
  lit,
  dur,
  reducedMotion,
}: {
  lit: boolean;
  dur: string;
  reducedMotion: boolean;
}) {
  const x = 610;
  const y = 150;
  const w = 150;
  const h = 116;
  const checks = ["RSA-2048 signature", "body hash (bh=)", "value extracted"];
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={14}
        fill={lit ? C.paper1 : C.white}
        stroke={lit ? C.pine : C.paper2}
        strokeWidth={2.5}
        style={{ transition: `stroke ${dur} ease, fill ${dur} ease` }}
      />
      <text
        x={x + w / 2}
        y={y + 20}
        textAnchor="middle"
        fontSize={13}
        fontWeight={700}
        fill={C.ink}
        fontFamily="var(--font-parkDisplay)"
      >
        DKIM Oracle
      </text>
      {checks.map((label, i) => (
        <g
          key={label}
          style={{
            opacity: lit ? 1 : 0.35,
            transition: reducedMotion
              ? undefined
              : `opacity 400ms ease ${lit ? i * 350 : 0}ms`,
          }}
        >
          <circle
            cx={x + 20}
            cy={y + 40 + i * 24}
            r={7}
            fill={lit ? C.green : C.paper2}
            style={{
              transition: reducedMotion
                ? undefined
                : `fill 400ms ease ${lit ? i * 350 : 0}ms`,
            }}
          />
          <path
            d={`M ${x + 16.5} ${y + 40 + i * 24} l 2.5 2.8 l 4.5 -5.6`}
            stroke={C.white}
            strokeWidth={1.8}
            fill="none"
            strokeLinecap="round"
          />
          <text
            x={x + 34}
            y={y + 44 + i * 24}
            fontSize={11}
            fill={C.grey2}
            fontFamily="var(--font-parkBody)"
          >
            {label}
          </text>
        </g>
      ))}
    </g>
  );
}
