import { BrainIcon, EnvelopeSimpleIcon, ShieldCheckIcon, TrendUpIcon } from "@phosphor-icons/react";
import { C, DotStream, IconBox, PulseRing, Track, VizCard, useReducedMotion } from "./shared";

const DUR = "7s";
const RESEARCH = "M 118 66 C 150 66 156 66 184 66";
const QUOTE = "M 304 66 C 334 66 340 66 366 66";
const SETTLE = "M 211 142 C 211 158 211 170 211 190";

export function BankrAgentViz() {
  const reducedMotion = useReducedMotion();
  return (
    <VizCard caption="research informs quotes · signed email settles after trading closes">
      <svg viewBox="0 0 420 250" className="h-auto w-full" role="img" aria-label="Bankr reviews public research, a deterministic policy creates a bid and ask, Bankr custody submits those bounded transactions, and a separately gated signed email path settles only after trading closes.">
        <Track d={RESEARCH} /><Track d={QUOTE} /><Track d={SETTLE} />
        <IconBox x={8} y={28} w={110} h={76} color={C.sky} title="Research" sub="news + platforms" icon={<TrendUpIcon size={22} color={C.sky} weight="bold" />} />
        <IconBox x={156} y={28} w={148} h={76} color={C.green} title="Risk policy" sub="fair value + hard caps" icon={<BrainIcon size={22} color={C.green} weight="bold" />} />
        <IconBox x={304} y={28} w={108} h={76} color={C.pine} title="Bankr" sub="bid + ask custody" icon={<ShieldCheckIcon size={22} color={C.pine} weight="bold" />} />
        <IconBox x={142} y={174} w={138} h={68} color={C.sky} title="Signed .eml" sub="settlement only" icon={<EnvelopeSimpleIcon size={22} color={C.sky} weight="bold" />} />
        {reducedMotion ? null : <>
          <DotStream path={RESEARCH} color={C.sky} dur={DUR} windows={[[0.03, 0.2], [0.13, 0.3]]} />
          <DotStream path={QUOTE} color={C.green} dur={DUR} windows={[[0.32, 0.49], [0.43, 0.6]]} />
          <DotStream path={SETTLE} color={C.sky} dur={DUR} windows={[[0.68, 0.86]]} />
          <PulseRing x={156} y={28} w={148} h={76} rx={14} color={C.green} phases={[0.2, 0.3]} dur={DUR} />
          <PulseRing x={304} y={28} w={108} h={76} rx={14} color={C.pine} phases={[0.49, 0.6]} dur={DUR} />
          <PulseRing x={142} y={174} w={138} h={68} rx={14} color={C.sky} phases={[0.86]} dur={DUR} />
        </>}
        <text x={211} y={132} textAnchor="middle" fontSize={10.5} fill={C.grey2} fontFamily="var(--font-parkBody)">trading closes before observation begins</text>
      </svg>
    </VizCard>
  );
}
