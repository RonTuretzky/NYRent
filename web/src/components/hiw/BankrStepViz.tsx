import { useState, type ReactNode } from "react";
import { BrainIcon, EnvelopeSimpleIcon, LockKeyIcon, ShieldCheckIcon, TrendUpIcon } from "@phosphor-icons/react";
import { C, DotStream, IconBox, PulseRing, Track, VizCard, useReducedMotion } from "./shared";

const DUR = "8s";
function Label({ x, y, children, color = C.grey2 }: { x: number; y: number; children: ReactNode; color?: string }) {
  return <text x={x} y={y} textAnchor="middle" fontSize={11} fill={color} fontFamily="var(--font-parkBody)">{children}</text>;
}

export function BankrResearchViz() {
  const reduced = useReducedMotion();
  const research = "M 146 59 H 208 V 107 H 270";
  const oracle = "M 146 173 H 208 V 133 H 270";
  return <VizCard caption="Public context reviews the plan · signed observations price it">
    <svg viewBox="0 0 480 280" className="h-auto w-full" role="img" aria-label="Public research provides a risk review. Verified rent observations feed the pricing model. The policy combines fair value, inventory and spending caps into bounded quotes.">
      <Track d={research} /><Track d={oracle} />
      <IconBox x={12} y={18} w={134} h={82} color={C.sky} title="Public research" sub="news + market context" icon={<TrendUpIcon size={22} color={C.sky} />} />
      <IconBox x={12} y={132} w={134} h={82} color={C.pine} title="Signed rent data" sub="verified observations" icon={<EnvelopeSimpleIcon size={22} color={C.pine} />} />
      <Label x={211} y={43}>Risk review</Label><Label x={210} y={201}>Model inputs</Label>
      <IconBox x={270} y={74} w={194} h={90} color={C.green} title="Pricing policy" sub="fair value + inventory lean" icon={<BrainIcon size={22} color={C.green} />} />
      <rect x={250} y={191} width={214} height={44} rx={12} fill={C.white} stroke={C.green} />
      <Label x={357} y={218} color={C.pine}>Exact ranges + spending caps</Label>
      <Track d="M 367 164 V 191" />
      {!reduced && <>
        <DotStream path={research} color={C.sky} dur={DUR} windows={[[0.05, 0.3]]} />
        <DotStream path={oracle} color={C.pine} dur={DUR} windows={[[0.2, 0.45]]} />
        <PulseRing x={270} y={74} w={194} h={90} rx={14} color={C.green} phases={[0.45]} dur={DUR} />
        <DotStream path="M 367 164 V 191" color={C.green} dur={DUR} windows={[[0.56, 0.72]]} />
        <PulseRing x={250} y={191} w={214} h={44} rx={12} color={C.green} phases={[0.72]} dur={DUR} />
      </>}
      <Label x={240} y={265}>The model proposes a price; the policy limits exposure.</Label>
    </svg>
  </VizCard>;
}

const INVENTORY = [
  { name: "Balanced", shift: 0, rent: 0.5, note: "Quotes sit around the model’s fair value." },
  { name: "More RENT", shift: -27, rent: 0.8, note: "Lower quotes encourage selling RENT and slow new buying." },
  { name: "Less RENT", shift: 27, rent: 0.2, note: "Higher quotes encourage buying RENT and slow new selling." },
] as const;

export function BankrQuotesViz() {
  const [choice, setChoice] = useState(0);
  const reduced = useReducedMotion();
  const scenario = INVENTORY[choice];
  return <VizCard caption="Illustrative inventory scenarios · prices and proportions are not live quotes">
    <div className="mb-3 flex flex-wrap justify-center gap-2" aria-label="Inventory scenario">
      {INVENTORY.map((item, i) => <button key={item.name} type="button" aria-pressed={choice === i} onClick={() => setChoice(i)} className={`min-h-11 rounded-full border px-3 py-2 font-parkBody text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green ${choice === i ? "border-core-green bg-core-green text-white" : "border-paper-2 bg-paper-0 text-text-standard hover:border-core-green"}`}>{item.name}</button>)}
    </div>
    <svg viewBox="0 0 480 290" className="h-auto w-full" role="img" aria-label={`${scenario.name} inventory. ${scenario.note} Bid fills exchange USDC for RENT; ask fills exchange RENT for USDC. Rebalancing replaces the agent’s own liquidity ranges.`}>
      <Label x={240} y={20}>RENT price in USDC</Label>
      <path d="M 28 111 H 452" stroke={C.paper2} strokeWidth={2} />
      <path d="M 240 35 V 128" stroke={C.grey2} strokeDasharray="3 5" />
      <Label x={240} y={147}>Model fair value</Label>
      <g transform={`translate(${scenario.shift} 0)`} style={{ transition: reduced ? undefined : "transform 600ms ease" }}>
        <rect x={68} y={61} width={112} height={49} rx={12} fill={C.white} stroke={C.sky} strokeWidth={2.5} />
        <Label x={124} y={82} color={C.ink}>BID · buy RENT</Label><Label x={124} y={99}>USDC → RENT</Label>
        <rect x={300} y={61} width={112} height={49} rx={12} fill={C.white} stroke={C.green} strokeWidth={2.5} />
        <Label x={356} y={82} color={C.ink}>ASK · sell RENT</Label><Label x={356} y={99}>RENT → USDC</Label>
        {!reduced && <><PulseRing x={68} y={61} w={112} h={49} rx={12} color={C.sky} phases={[0.23]} dur={DUR} /><PulseRing x={300} y={61} w={112} h={49} rx={12} color={C.green} phases={[0.65]} dur={DUR} /></>}
      </g>
      <Label x={240} y={184}>Trading inventory changes as orders fill</Label>
      <rect x={50} y={197} width={380} height={20} rx={10} fill={C.sky} />
      <rect x={50} y={197} width={380 * scenario.rent} height={20} rx={10} fill={C.green} style={{ transition: reduced ? undefined : "width 600ms ease" }} />
      <Label x={100} y={239} color={C.green}>RENT inventory</Label><Label x={381} y={239} color={C.sky}>USDC cash</Label>
      <Track d="M 420 248 C 454 280 26 280 60 248" />
      {!reduced && <DotStream path="M 420 248 C 454 280 26 280 60 248" color={C.pine} dur={DUR} windows={[[0.72, 0.94]]} />}
      <Label x={240} y={283}>Read fills → remove old ranges → post fresh quotes</Label>
    </svg>
    <p aria-live="polite" className="mt-3 min-h-12 font-parkBody text-sm leading-relaxed text-surface-grey-2">{scenario.note}</p>
  </VizCard>;
}

export function BankrExecutionViz() {
  const reduced = useReducedMotion();
  const first = "M 148 67 H 190";
  const second = "M 318 67 H 358";
  const contract = "M 410 110 V 164 H 306";
  return <VizCard caption="Review → simulate → sign → confirm on-chain">
    <svg viewBox="0 0 480 280" className="h-auto w-full" role="img" aria-label="A bounded quote plan is simulated, Bankr signs it, and the market contracts enforce backing, ownership and trading dates before a successful receipt is confirmed.">
      {[first, second, contract].map(d => <Track key={d} d={d} />)}
      <IconBox x={12} y={24} w={136} h={86} color={C.sky} title="Bounded plan" sub="amounts + ranges" icon={<BrainIcon size={22} color={C.sky} />} />
      <IconBox x={190} y={24} w={128} h={86} color={C.green} title="Simulate" sub="check wallet + call" icon={<ShieldCheckIcon size={22} color={C.green} />} />
      <IconBox x={358} y={24} w={110} h={86} color={C.pine} title="Bankr signs" sub="approved wallet" icon={<LockKeyIcon size={22} color={C.pine} />} />
      <rect x={70} y={148} width={236} height={92} rx={14} fill={C.white} stroke={C.green} strokeWidth={2.5} />
      <text x={188} y={171} textAnchor="middle" fontSize={13} fontWeight={700} fill={C.ink} fontFamily="var(--font-parkDisplay)">Contracts enforce the rules</text>
      <Label x={188} y={195}>Full backing · position ownership</Label><Label x={188} y={218}>Trading cutoff · settlement terms</Label>
      <Label x={388} y={204}>Receipt</Label><Label x={388} y={224}>confirmed</Label>
      <Track d="M 306 215 H 345" />
      {!reduced && <>
        <DotStream path={first} color={C.sky} dur={DUR} windows={[[0.05, 0.2]]} />
        <PulseRing x={190} y={24} w={128} h={86} rx={14} color={C.green} phases={[0.2]} dur={DUR} />
        <DotStream path={second} color={C.green} dur={DUR} windows={[[0.29, 0.43]]} />
        <DotStream path={contract} color={C.pine} dur={DUR} windows={[[0.49, 0.7]]} />
        <PulseRing x={70} y={148} w={236} h={92} rx={14} color={C.green} phases={[0.7]} dur={DUR} />
        <DotStream path="M 306 215 H 345" color={C.green} dur={DUR} windows={[[0.8, 0.94]]} />
      </>}
    </svg>
  </VizCard>;
}

export function BankrSettlementViz() {
  const reduced = useReducedMotion();
  const verify = "M 145 136 H 190";
  const submit = "M 320 136 H 360";
  return <VizCard caption="The signed result fixes the payout after trading closes">
    <svg viewBox="0 0 480 280" className="h-auto w-full" role="img" aria-label="Trading closes before the observation window. A raw email is scanned and its signature, body and date are verified. A qualifying result is posted and the market settles once, without a bundled trade.">
      <rect x={16} y={10} width={448} height={48} rx={12} fill={C.white} stroke={C.paper2} />
      <g transform="translate(32 23)"><LockKeyIcon size={21} color={C.pine} /></g>
      <Label x={262} y={39} color={C.pine}>Trading closes → observation window begins</Label>
      <Track d={verify} /><Track d={submit} />
      <IconBox x={12} y={94} w={133} h={86} color={C.sky} title="Scan .eml inbox" sub="publisher’s raw email" icon={<EnvelopeSimpleIcon size={22} color={C.sky} />} />
      <IconBox x={190} y={94} w={130} h={86} color={C.green} title="Verify result" sub="signature + body + date" icon={<ShieldCheckIcon size={22} color={C.green} />} />
      <IconBox x={360} y={94} w={108} h={86} color={C.pine} title="Post + settle" sub="fixed payout ratio" icon={<LockKeyIcon size={22} color={C.pine} />} />
      <Label x={240} y={218}>Large email? Upload chunks, then verify the complete body.</Label>
      <Label x={240} y={248}>Already settled? Read the result and stop.</Label>
      {!reduced && <>
        <DotStream path={verify} color={C.sky} dur={DUR} windows={[[0.13, 0.35]]} />
        <PulseRing x={190} y={94} w={130} h={86} rx={14} color={C.green} phases={[0.35]} dur={DUR} />
        <DotStream path={submit} color={C.green} dur={DUR} windows={[[0.52, 0.74]]} />
        <PulseRing x={360} y={94} w={108} h={86} rx={14} color={C.pine} phases={[0.74]} dur={DUR} />
      </>}
    </svg>
  </VizCard>;
}
