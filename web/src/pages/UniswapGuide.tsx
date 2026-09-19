import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowsLeftRightIcon, BankIcon, CoinsIcon, EnvelopeSimpleIcon, FireIcon, LockKeyIcon, ShieldCheckIcon, UserIcon } from "@phosphor-icons/react";
import { Card } from "../components/States";
import { C, DotStream, IconBox, PulseRing, Track, VizCard, useInView, useReducedMotion } from "../components/hiw/shared";
import { useActiveDeployment } from "../chain/registry";
import { V4_DEPLOYMENTS } from "../chain/v4";
import { addressUrl } from "../chain/explorer";

const DUR = "6s";
const SOURCE = "https://github.com/RonTuretzky/NYRent/blob/main/src/v4";
type SceneProps = { reducedMotion: boolean };

function Label({ x, y, children, color = C.grey2 }: { x: number; y: number; children: ReactNode; color?: string }) {
  return <text x={x} y={y} textAnchor="middle" fontSize={10.5} fill={color} fontFamily="var(--font-parkBody)">{children}</text>;
}

function BackingScene({ reducedMotion }: SceneProps) {
  const deposit = "M 148 100 C 205 100 242 54 316 54";
  const mint = "M 316 82 C 240 82 205 137 148 137";
  const seed = "M 148 158 C 224 158 236 205 316 205";
  return <VizCard caption="Backing stays in escrow · liquidity is funded separately">
    <svg viewBox="0 0 480 270" className="h-auto w-full" role="img" aria-label="The insurer deposits USDC into escrow, receives backed RENT, and supplies RENT plus separate USDC to the trading pool.">
      {[deposit, mint, seed].map(d => <Track key={d} d={d} />)}
      <Label x={212} y={65}>USDC backing</Label><Label x={237} y={133}>1 RENT per USDC</Label><Label x={222} y={234}>RENT + separate USDC</Label>
      <IconBox x={18} y={88} w={130} h={88} color={C.sky} title="Insurer" sub="funds both sides" icon={<UserIcon size={22} color={C.sky} weight="bold" />} />
      <IconBox x={316} y={18} w={146} h={88} color={C.green} title="RentSafe escrow" sub="backs each RENT" icon={<LockKeyIcon size={22} color={C.green} weight="bold" />} />
      <IconBox x={316} y={164} w={146} h={88} color={C.pine} title="Uniswap v4 pool" sub="RENT / USDC" icon={<ArrowsLeftRightIcon size={22} color={C.pine} weight="bold" />} />
      {!reducedMotion && <>
        <DotStream path={deposit} color={C.green} dur={DUR} windows={[[0.03, 0.25]]} />
        <PulseRing x={316} y={18} w={146} h={88} rx={14} color={C.green} phases={[0.25]} dur={DUR} />
        <DotStream path={mint} color={C.sky} dur={DUR} windows={[[0.3, 0.52]]} />
        <DotStream path={seed} color={C.pine} dur={DUR} windows={[[0.6, 0.83]]} />
        <PulseRing x={316} y={164} w={146} h={88} rx={14} color={C.pine} phases={[0.83]} dur={DUR} />
      </>}
    </svg>
  </VizCard>;
}

function TradingScene({ reducedMotion }: SceneProps) {
  const payment = "M 124 90 C 145 54 169 54 190 90";
  const tokens = "M 190 144 C 165 180 149 180 124 144";
  return <VizCard caption="A trade changes the pool inventory and the next price">
    <svg viewBox="0 0 480 270" className="h-auto w-full" role="img" aria-label="A renter sends USDC to the Uniswap pool and receives RENT. Escrow stays separate. Buying moves the pool price as inventory changes.">
      <Track d={payment} /><Track d={tokens} />
      <Label x={157} y={50}>USDC in</Label><Label x={157} y={192}>RENT out</Label>
      <IconBox x={14} y={76} w={110} h={90} color={C.sky} title="Renter" sub="buy or sell" icon={<UserIcon size={22} color={C.sky} weight="bold" />} />
      <IconBox x={190} y={76} w={128} h={90} color={C.green} title="Trading pool" sub="inventory + LP fees" icon={<ArrowsLeftRightIcon size={22} color={C.green} weight="bold" />} />
      <IconBox x={354} y={76} w={112} h={90} color={C.pine} title="Escrow" sub="backing stays here" icon={<LockKeyIcon size={22} color={C.pine} weight="bold" />} />
      <path d="M 336 58 V 186" stroke={C.paper2} strokeDasharray="3 6" />
      <rect x={32} y={213} width={416} height={38} rx={12} fill={C.white} />
      <Label x={240} y={237}>Current price → order size → live pool quote</Label>
      {!reducedMotion && <>
        <DotStream path={payment} color={C.green} dur={DUR} windows={[[0.08, 0.3], [0.53, 0.7]]} />
        <PulseRing x={190} y={76} w={128} h={90} rx={14} color={C.green} phases={[0.3, 0.7]} dur={DUR} />
        <DotStream path={tokens} color={C.sky} dur={DUR} windows={[[0.32, 0.5], [0.73, 0.9]]} />
      </>}
    </svg>
  </VizCard>;
}

function HookScene({ reducedMotion }: SceneProps) {
  return <VizCard caption="The hook enforces the calendar before a pool action runs">
    <svg viewBox="0 0 480 270" className="h-auto w-full" role="img" aria-label="The hook permits trading before the cutoff, locks transfers and liquidity withdrawals during observation, and unlocks them after settlement or after the claim deadline. Trading never reopens.">
      <IconBox x={155} y={12} w={170} h={84} color={C.green} title="RentSafe v4 hook" sub="checks the market contract" icon={<ShieldCheckIcon size={22} color={C.green} weight="bold" />} />
      <path d="M 240 96 V 118 M 80 118 H 400 M 80 118 V 132 M 240 118 V 132 M 400 118 V 132" fill="none" stroke={C.paper2} strokeWidth={2} />
      {[{ x: 10, label: "Before cutoff", sub: "Buy / sell open", color: C.green }, { x: 170, label: "Observation", sub: "Trading closed", color: C.pine }, { x: 330, label: "After settlement", sub: "Redeem from escrow", color: C.sky }].map(({ x, label, sub, color }) => <g key={label}>
        <rect x={x} y={132} width={140} height={59} rx={12} fill={C.white} stroke={color} strokeWidth={1.5} />
        <text x={x + 70} y={155} textAnchor="middle" fontSize={11.5} fontWeight={700} fill={C.ink} fontFamily="var(--font-parkDisplay)">{label}</text>
        <Label x={x + 70} y={176}>{sub}</Label>
      </g>)}
      <Label x={240} y={222}>LP withdrawals lock at observation start.</Label>
      <Label x={240} y={241}>Settlement or an expired claim window unlocks them.</Label>
      {!reducedMotion && <>
        <DotStream path="M 80 118 H 240 V 96" color={C.green} dur={DUR} windows={[[0.08, 0.28]]} />
        <PulseRing x={155} y={12} w={170} h={84} rx={14} color={C.green} phases={[0.28]} dur={DUR} />
        <PulseRing x={10} y={132} w={140} h={59} rx={12} color={C.green} phases={[0.42]} dur={DUR} />
        <PulseRing x={170} y={132} w={140} h={59} rx={12} color={C.pine} phases={[0.61]} dur={DUR} />
        <PulseRing x={330} y={132} w={140} h={59} rx={12} color={C.sky} phases={[0.8]} dur={DUR} />
      </>}
    </svg>
  </VizCard>;
}

function RedemptionScene({ reducedMotion }: SceneProps) {
  const burn = "M 132 184 H 185";
  const paid = "M 350 213 C 285 263 185 263 112 218";
  return <VizCard caption="RENT burns · the fixed payout comes from escrow">
    <svg viewBox="0 0 480 280" className="h-auto w-full" role="img" aria-label="The oracle verifies a signed email and settlement fixes a payout ratio. A holder burns RENT, and escrow pays the fixed USDC amount.">
      <rect x={16} y={14} width={448} height={89} rx={16} fill={C.white} stroke={C.paper2} />
      <g transform="translate(36 30)"><EnvelopeSimpleIcon size={24} color={C.green} weight="bold" /></g>
      <text x={76} y={43} fontSize={12.5} fontWeight={700} fill={C.ink} fontFamily="var(--font-parkDisplay)">Signed print → verified observation → fixed ratio</text>
      <Label x={240} y={76}>Example only: 100 RENT × 50% = 50 USDC</Label>
      <Track d={burn} /><Track d={paid} />
      <IconBox x={16} y={142} w={116} h={88} color={C.sky} title="RENT holder" sub="redeems by deadline" icon={<UserIcon size={22} color={C.sky} weight="bold" />} />
      <IconBox x={184} y={142} w={112} h={88} color={C.pine} title="Burn RENT" sub="claim is consumed" icon={<FireIcon size={22} color={C.pine} weight="bold" />} />
      <IconBox x={348} y={142} w={116} h={88} color={C.green} title="Escrow pays" sub="fixed USDC payout" icon={<CoinsIcon size={22} color={C.green} weight="bold" />} />
      <path d="M 296 184 H 348" fill="none" stroke={C.paper2} strokeDasharray="2 5" />
      {!reducedMotion && <>
        <DotStream path={burn} color={C.sky} dur={DUR} windows={[[0.12, 0.3]]} />
        <PulseRing x={184} y={142} w={112} h={88} rx={14} color={C.pine} phases={[0.3]} dur={DUR} />
        <DotStream path="M 296 184 H 348" color={C.green} dur={DUR} windows={[[0.36, 0.52]]} />
        <DotStream path={paid} color={C.green} dur={DUR} windows={[[0.56, 0.82]]} />
        <PulseRing x={16} y={142} w={116} h={88} rx={14} color={C.sky} phases={[0.82]} dur={DUR} />
      </>}
    </svg>
  </VizCard>;
}

const STEPS: { key: string; title: string; body: string; detail: string; scene: ComponentType<SceneProps> }[] = [
  { key: "back", title: "Back RENT, then open its market", body: "The insurer deposits 1 USDC into RentSafe escrow for each RENT minted. The market creator chooses the opening pool price when the market is created. Adding liquidity later supplies RENT and additional USDC at the existing pool price; it does not reset that price.", detail: "For example, minting 1,000 RENT locks 1,000 USDC in escrow. Putting those tokens into a full-range pool at $0.285 needs roughly 285 additional USDC. The two maximum-amount inputs limit what you deposit; their ratio does not set a new sale price. The pool uses the amounts it needs within those limits.", scene: BackingScene },
  { key: "trade", title: "Buy and sell at the pool's price", body: "A buyer sends USDC into the pool and receives RENT; a seller does the reverse. Each trade changes the inventory and price. LP positions hold the resulting assets and earn trading fees. If the insurer supplied that liquidity, the value belongs to their position; the payment does not arrive directly in their wallet.", detail: "At $0.285, $100 ÷ $0.285 is about 351 RENT before fees and price impact. That is a reference calculation. The executable quote depends on available liquidity; a small pool cannot fill a large order at its displayed spot price.", scene: TradingScene },
  { key: "hook", title: "The hook follows the contract's clock", body: "Uniswap calls the RentSafe hook before a swap or liquidity change. New RENT issuance, swaps and new liquidity close at the sale cutoff. Transfers and LP withdrawals lock at observation start, then unlock after settlement or after the claim deadline. Trading stays closed.", detail: "The immutable fee schedule rises linearly from 0.30% at creation toward 1.00% at the cutoff. LPs receive the trading fee. The hook has no administrator fee setter and does not hold the escrow.", scene: HookScene },
  { key: "redeem", title: "The signed index fixes the payout", body: "Anyone can submit a qualifying publisher-signed email. The oracle verifies it on-chain; the first successful qualifying settlement fixes the payout between 0 and 1 USDC per RENT. Holders then burn RENT to receive their payout directly from escrow before the claim deadline.", detail: "The September 2027 print has not arrived. After settlement, liquidity providers must remove and redeem their RENT inventory too. After the claim deadline, original collateral depositors can withdraw their share of the remaining backing.", scene: RedemptionScene },
];

function GuideStep({ index, reducedMotion }: { index: number; reducedMotion: boolean }) {
  const [ref, inView] = useInView<HTMLLIElement>(0.15);
  const step = STEPS[index];
  const Scene = step.scene;
  const shown = inView || reducedMotion;
  const flip = index % 2 === 1;
  return <li ref={ref} id={`uniswap-${step.key}`} data-testid={`uniswap-step-${step.key}`} className={`grid items-center gap-8 lg:grid-cols-2 lg:gap-16 ${reducedMotion ? "" : "transition-all duration-700 ease-out"} ${shown ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"}`}>
    <div className={flip ? "lg:order-2" : undefined}>
      <div className="flex items-center gap-4"><span aria-hidden="true" className="font-parkDisplay flex h-10 w-10 flex-none items-center justify-center rounded-full bg-core-green text-lg font-bold text-white">{index + 1}</span><h2 className="font-parkDisplay text-xl font-bold sm:text-2xl">{step.title}</h2></div>
      <p className="font-parkBody mt-4 text-surface-grey-2">{step.body}</p>
      <p className="font-parkBody mt-3 text-sm text-surface-grey-2">{step.detail}</p>
    </div>
    <div className={flip ? "lg:order-1" : undefined}><Scene key={shown ? "live" : "idle"} reducedMotion={reducedMotion} /></div>
  </li>;
}

export function UniswapGuide() {
  const reducedMotion = useReducedMotion();
  const { deployment } = useActiveDeployment();
  const v4 = V4_DEPLOYMENTS[String(deployment.chainId)];
  return <div className="space-y-12 sm:space-y-16">
    <header className="max-w-3xl">
      <Link to="/docs" className="font-parkBody text-sm text-core-green hover:underline">← Docs</Link>
      <div className="font-parkBody mt-5 inline-flex items-center gap-2 rounded-full border border-paper-2 bg-paper-1 px-3 py-1 text-xs text-surface-grey-2"><ArrowsLeftRightIcon size={16} weight="bold" />RentSafe × Uniswap v4</div>
      <h1 className="font-parkDisplay mt-4 text-3xl font-bold sm:text-4xl">How RENT becomes a live market</h1>
      <p className="font-parkBody mt-4 text-lg text-surface-grey-2">Escrow backs the claim. Uniswap prices the trade. The signed rent index determines the final payout.</p>
      <div className="font-parkBody mt-5 flex flex-wrap gap-x-6 gap-y-3 text-sm"><Link to="/buy" className="font-semibold text-core-green hover:underline">Buy &amp; Sell →</Link><Link to="/docs/walkthrough" className="text-core-green hover:underline">Watch the walkthrough →</Link></div>
    </header>
    <ol role="list" className="list-none space-y-16 sm:space-y-24">{STEPS.map((step, index) => <GuideStep key={step.key} index={index} reducedMotion={reducedMotion} />)}</ol>
    <Card>
      <div className="flex items-center gap-3"><BankIcon size={24} className="text-core-green" /><h2 className="font-parkDisplay text-xl font-bold">What the market price tells you</h2></div>
      <p className="font-parkBody mt-3 text-surface-grey-2">Because RENT pays a capped ratio, its price can be mapped to a price-equivalent index growth: 3% + 5% × price. At $0.285, that is 4.425%. This is not the expected growth of rent itself: outcomes outside the band, risk margins and liquidity are not captured by that simple mapping.</p>
      <Link className="font-parkBody mt-4 inline-block text-sm font-semibold text-core-green hover:underline" to="/market-view">Explore the price interpretation →</Link>
    </Card>
    <section className="font-parkBody rounded-2xl border border-paper-2 bg-paper-1 p-5 text-sm text-surface-grey-2 sm:p-6">
      <h2 className="font-parkDisplay text-lg font-bold text-text-standard">Follow the contracts</h2>
      {v4 ? <><p className="mt-2">The selected v4 market is on {deployment.name}, chain {deployment.chainId}. Wallet balances and trading liquidity must be on the same network.</p><div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">{[["RENT + escrow", v4.market], ["RentSafe hook", v4.hook], ["Uniswap PoolManager", v4.poolManager], ["Signed-rent oracle", v4.oracle]].map(([label, address]) => <a key={address} className="text-core-green underline" href={addressUrl(address, deployment.explorerBase)} target="_blank" rel="noreferrer">{label} ↗</a>)}</div></> : <p className="mt-2">Select Polygon to use the live RENT / USDC v4 market. Other network versions can have different trading mechanics.</p>}
      <p className="mt-4">RentSafe implementation: <a className="underline" href={`${SOURCE}/RentV4Market.sol`} target="_blank" rel="noreferrer">market and escrow</a> · <a className="underline" href={`${SOURCE}/RentV4Factory.sol`} target="_blank" rel="noreferrer">pool creation</a> · <a className="underline" href={`${SOURCE}/RentV4Hook.sol`} target="_blank" rel="noreferrer">hook rules</a>. Uniswap background: <a className="underline" href="https://developers.uniswap.org/docs/get-started/concepts/hooks" target="_blank" rel="noreferrer">v4 hooks</a> · <a className="underline" href="https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity" target="_blank" rel="noreferrer">liquidity and price ranges</a>.</p>
      <p className="mt-3">Contracts are unaudited. Full backing does not guarantee a secondary-market exit. The index measures Manhattan office rent, which can move differently from an individual lease.</p>
    </section>
  </div>;
}
