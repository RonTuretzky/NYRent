import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatUnits } from "viem";
import { ArrowLeftIcon, ArrowRightIcon, ArrowsOutIcon, BankIcon, CheckIcon, CoinsIcon, EnvelopeSimpleIcon, FileTextIcon, LockKeyIcon, MoonIcon, ShieldCheckIcon, SunIcon, UserIcon, XIcon } from "@phosphor-icons/react";
import { useActiveMarket } from "../chain/useActiveMarket";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { useV4Market } from "../chain/v4";
import { formatCents, formatDate } from "../chain/format";
import { ACTIVE_MARKET_ID, growthFor, payoutRatioFromCents } from "../lib/market";
import { StoryInsurerEconomics, StoryMarketForecast } from "../components/story/StoryEconomics";
import "./Story.css";

const PHASES = [2, 2, 0, 0, 6, 0, 3, 7, 0];
const TITLES = ["Insurance is something you can own.", "Can code hold the capital, read the trigger, and pay?", "We started with a cost that touches almost everyone.", "Three parties. Each does one thing.", "The terms are fixed before capital arrives.", "Money in, money out.", "Back RENT. Open the pool. Let it trade.", "One email settles it.", "We built insurance and got a forecast for free."];
const NOTES = [
  "Insurance risk is already an investable asset. Catastrophe bonds have several trigger designs, including indemnity triggers; a published-number trigger is the parametric analogy, not a description of every cat bond. Artemis reported $65.6B outstanding at June 30, 2026, including tracked private deals.",
  "The contracts hold capital, authenticate the publisher’s message and apply immutable terms. They cannot establish that the publisher’s economic statistic is true. No RentSafe administrator can rewrite the signed message or the payout formula.",
  "The baseline comes from the recorded September 2026 rent observation. The fixed payout band translates index growth into a claim worth up to one USDC per RENT.",
  "RentSafe supplies the interface and immutable contract design. The insurer posts claim backing and may supply separate pool liquidity. A renter holds RENT. The issuer chooses an opening pool price at creation; later liquidity providers do not reset that price.",
  "All displayed market terms use the same live hook as the other pages. The first successful settlement using a qualifying verified observation wins; the contract cannot prove that an earlier email was not withheld. Cent-denominated strikes determine the actual payout.",
  "The insurer calculator is a simplified sold-inventory model. Retained RENT must also be redeemed. A liquidity position has changing inventory and fees; sale proceeds are not cash sent directly to the insurer’s wallet. No escrow yield is included.",
  "Depositing USDC to mint RENT funds escrow. Providing liquidity requires additional USDC. The pool’s opening price is initialized when the market is created, not inferred from later maximum-deposit inputs. Buying moves the price. Selling depends on liquidity and the trading cutoff.",
  "This screen illustrates the checks and a hypothetical future print. It is not an email verification result. The real September 2027 observation has not arrived. The original September 2026 baseline has been authenticated on-chain; see the recorded verification in Docs.",
  "The mapping from price to growth is capped-payout equivalence, not expected index growth. Liquidity, risk preferences and discounting can affect price. Historical prices on this site are recorded on-chain swaps, not a continuous historical oracle.",
];

function Reveal({ shown, children, className = "" }: { shown: boolean; children: ReactNode; className?: string }) {
  return <div className={`story-reveal ${className}`} aria-hidden={!shown}>{children}</div>;
}
function StoryFallback({ demo, unavailable }: { demo: boolean; unavailable: boolean }) {
  return demo ? <span className="story-badge">Demo · market not deployed</span> : unavailable ? <span className="story-badge">Live read unavailable</span> : null;
}

function StoryStaticScreen({ step, phase }: { step: number; phase: number }) {
  const market = useActiveMarket();
  const v4 = useV4Market();
  const { deployment } = useActiveDeployment();
  const demo = !v4.deployment && (!isLiveDeployment(deployment) || !deployment.seriesIds.includes(ACTIVE_MARKET_ID));
  const unavailable = !demo && (market.isDemo || market.rpcError);
  const value = (cents: number) => unavailable ? "—" : formatCents(cents);
  const exampleCents = Math.round((market.strikeLowCents + market.strikeHighCents) / 2);
  const ratio = payoutRatioFromCents(exampleCents, market.strikeLowCents, market.strikeHighCents);
  const amount = (units: bigint | undefined) => unavailable || units === undefined ? "—" : Number(formatUnits(units, market.decimals)).toLocaleString("en-US", { maximumFractionDigits: 3 });

  if (step === 1) return <>
    <p className="story-copy">Investors post capital and collect premiums.<br />A defined trigger can put that capital at risk.</p>
    <div className="story-cat-layout">
      <div className="story-cat-stat"><strong className="story-number">$65.6B</strong><span>cat-bond risk capital · June 2026</span></div>
      <div className="story-capital-flow">
        <div className="story-flow-box"><BankIcon /><strong>Capital posted</strong></div><ArrowRightIcon className="story-flow-arrow" />
        <div className="story-flow-box"><CoinsIcon /><strong>Premium in</strong></div><ArrowRightIcon className="story-flow-arrow" />
        <div className="story-event-ends">
          <Reveal shown={phase >= 1} className="story-end story-end-risk"><span>Trigger hits</span><strong>Capital pays claims</strong></Reveal>
          <Reveal shown={phase >= 2} className="story-end"><span>No trigger</span><strong>Capital comes back</strong></Reveal>
        </div>
      </div>
      <a className="story-source" href="https://www.artemis.bm/news/catastrophe-bond-market-records-that-were-broken-in-h1-2026/" target="_blank" rel="noreferrer">Source: Artemis · includes tracked private cat bonds ↗</a>
    </div>
  </>;

  if (step === 2) return <>
    <p className="story-copy">Hold the backing. Authenticate the signed message.<br />Apply the terms the market started with.</p>
    <div className="story-three-boxes">
      {[{ title: "Escrow", text: "Capital is already there.", icon: <LockKeyIcon /> }, { title: "Oracle", text: "The publisher signs the input.", icon: <EnvelopeSimpleIcon /> }, { title: "Terms", text: "Code fixes the payout.", icon: <FileTextIcon /> }].map((item, index) => <Reveal key={item.title} shown={phase >= index} className="story-principle"><div className="story-icon">{item.icon}</div><h2>{item.title}</h2><p>{item.text}</p></Reveal>)}
    </div>
  </>;

  if (step === 3) return <>
    <p className="story-copy">Rent can rise. Tenants carry that risk.<br />RENT turns a defined rise into a payout.</p>
    <div className="story-rent-print"><span className="story-eyebrow">CRE Daily · September 2026 baseline</span><strong className="story-number">{value(market.baseCents)}<span className="story-unit">/SF</span></strong><StoryFallback demo={demo} unavailable={unavailable} /><div className="story-band">Payout starts at <strong>+3%</strong><span>→</span>fully pays at <strong>+8%</strong></div></div>
  </>;

  if (step === 4) return <div className="story-three-boxes story-parties">
    {[{ name: "RentSafe", icon: <ShieldCheckIcon />, role: "Sets the contract terms.", obligation: "Takes no rent-risk position." }, { name: "Insurer", icon: <BankIcon />, role: "Funds backing and liquidity.", obligation: "Backing pays every claim." }, { name: "Renter", icon: <UserIcon />, role: "Pays for RENT.", obligation: "Claims if the index rises." }].map(item => <div key={item.name} className="story-principle"><div className="story-icon">{item.icon}</div><h2>{item.name}</h2><p>{item.role}</p><p className="story-obligation">{item.obligation}</p></div>)}
  </div>;

  if (step === 5) {
    const date = (time: bigint) => unavailable ? "—" : formatDate(time);
    const terms = [
      ["Index", "CRE Daily · Manhattan office rent"],
      ["September 2026 base", `${value(market.baseCents)}/SF`],
      ["Pays from +3%", `${value(market.strikeLowCents)}/SF`],
      ["Full payout at +8%", `${value(market.strikeHighCents)}/SF`],
      ["Trading closes", date(market.saleEnd)],
      ["Observation window", `${date(market.obsStart)} – ${date(market.obsEnd)}`],
      ["Redeem by", date(market.redeemEnd)],
    ];
    return <><p className="story-copy">CRE Daily’s signed newsletter is verified on-chain.</p><div className="story-terms">{terms.map(([label, detail], index) => <div key={label} className={`story-term ${index === 0 ? "story-term-wide" : ""} ${phase === index ? "story-term-active" : ""}`}><span>{label}</span><strong>{detail}</strong></div>)}</div><StoryFallback demo={demo} unavailable={unavailable} /></>;
  }

  if (step === 7) return <>
    <p className="story-copy">The creator sets the opening price at market creation.<br />Every later trade uses the pool’s current quote.</p>
    <div className="story-mint-flow">
      {[{ title: "Back", line: "USDC into escrow", icon: <LockKeyIcon /> }, { title: "Mint", line: "1 USDC → 1 RENT", icon: <CoinsIcon /> }, { title: "Seed", line: "RENT + extra USDC", icon: <BankIcon /> }, { title: "Trade", line: "Renter swaps for RENT", icon: <UserIcon /> }].map((item, index) => <Reveal shown={phase >= index} key={item.title} className="story-mint-step"><span className="story-step-count">0{index + 1}</span><div className="story-icon">{item.icon}</div><h2>{item.title}</h2><p>{item.line}</p></Reveal>)}
    </div>
    <div className="story-live-chips"><div><span>Current pool price</span><strong>{!unavailable && market.source === "v4" ? `$${market.p.toFixed(4)}` : demo ? `$${market.p.toFixed(3)}` : "—"} <small>per RENT</small></strong></div><div><span>{market.source === "v4" ? "RENT issued" : "RENT sold"}</span><strong>{amount(market.source === "v4" ? market.supply : market.sold)}</strong></div><div><span>Backing in escrow</span><strong>{amount(market.escrow)} <small>{market.symbol}</small></strong></div><StoryFallback demo={demo} unavailable={unavailable} /></div>
    <p className="story-small">Selling before the cutoff requires liquidity. V4 issued inventory includes insurer and pool holdings.</p>
  </>;

  if (step === 8) return <>
    <p className="story-copy">Anyone can submit a qualifying signed email.<br />The first successful qualifying settlement fixes the payout.</p>
    <div className="story-resolution">
      <div className="story-email"><span className="story-badge">Illustration · not a verified email</span><div className="story-email-heading"><EnvelopeSimpleIcon /><strong>CRE Daily · Market Snapshot</strong></div><p>Hypothetical September 2027 print</p><div className="story-email-rent"><span>Manhattan office rent · Avg effective</span><strong>{formatCents(exampleCents)} <small>/SF</small></strong></div><span className="story-small">The real future newsletter has not arrived.</span></div>
      <div className="story-checks" aria-label="Illustrative verification sequence">{["Publisher signature", "Body hash", "Sender domain", "Signed timestamp", "Rent anchor phrase", "Value parsed"].map((label, index) => <div key={label} className={phase > index ? "story-check story-checked" : "story-check"}><span className="story-check-icon">{phase > index ? <CheckIcon weight="bold" /> : <span>·</span>}</span><span>{label}</span></div>)}</div>
    </div>
    <Reveal shown={phase >= 7} className="story-resolution-result"><span>{formatCents(exampleCents)}/SF → {(growthFor(exampleCents, market.baseCents) * 100).toFixed(2)}% growth → {(ratio * 100).toFixed(0)}% payout</span><strong>{ratio.toFixed(2)} USDC per RENT <small>· illustrated outcome</small></strong></Reveal>
  </>;
  return null;
}

export function Story() {
  const params = useParams<{ step?: string }>();
  const navigate = useNavigate();
  const parsed = Number(params.step ?? 1);
  const step = Number.isInteger(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 1;
  const [reveal, setReveal] = useState({ step, phase: 0 });
  const phase = reveal.step === step ? reveal.phase : 0;
  const [notes, setNotes] = useState(false);
  const [dark, setDark] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const shell = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number }>();
  const jump = useCallback((next: number) => { setReveal({ step: next, phase: 0 }); navigate(`/story/${next}`); }, [navigate]);
  const next = useCallback(() => { if (phase < PHASES[step - 1]) setReveal({ step, phase: phase + 1 }); else if (step < 9) jump(step + 1); }, [jump, phase, step]);
  const previous = useCallback(() => { if (phase > 0) setReveal({ step, phase: phase - 1 }); else if (step > 1) jump(step - 1); }, [jump, phase, step]);

  useEffect(() => { document.title = `RentSafe — Story ${step} of 9`; }, [step]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.repeat || target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowRight" || (event.key === " " && !target?.closest("button"))) { event.preventDefault(); next(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); previous(); }
      else if (/^[1-9]$/.test(event.key)) { event.preventDefault(); jump(Number(event.key)); }
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); setNotes(value => !value); }
      else if (event.key === "Escape") setNotes(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [jump, next, previous]);
  useEffect(() => {
    const listener = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", listener);
    return () => document.removeEventListener("fullscreenchange", listener);
  }, []);
  async function present() {
    setFullscreenError("");
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.current?.requestFullscreen(); }
    catch { setFullscreenError("Fullscreen is unavailable in this browser."); }
  }
  function touchStart(event: TouchEvent) {
    if (event.target instanceof Element && event.target.closest("input, select, button, a")) { swipe.current = undefined; return; }
    const touch = event.touches[0];
    swipe.current = { x: touch.clientX, y: touch.clientY };
  }
  function touchEnd(event: TouchEvent) {
    const from = swipe.current; swipe.current = undefined;
    if (!from) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - from.x, dy = touch.clientY - from.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) next(); else previous(); }
  }
  return <div ref={shell} className="story-shell" data-theme={dark ? "dark" : "light"} data-testid="story" data-step={step} data-phase={phase} onTouchStart={touchStart} onTouchEnd={touchEnd}>
    <header className="story-toolbar"><Link to="/" className="story-brand" aria-label="Back to RentSafe"><ArrowLeftIcon size={18} />RentSafe</Link><span className="story-mode">The story · {step} / 9</span><div className="story-tools"><button type="button" className="story-icon-button" aria-label={dark ? "Light theme" : "Dark theme"} onClick={() => setDark(value => !value)}>{dark ? <SunIcon /> : <MoonIcon />}</button><button type="button" onClick={() => void present()} className="story-present" aria-label={fullscreen ? "Exit fullscreen" : "Present"}><ArrowsOutIcon size={18} /><span>{fullscreen ? "Exit fullscreen" : "Present"}</span></button></div></header>
    <main className={`story-screen story-screen-${step}`} data-testid="story-screen" aria-labelledby="story-headline"><h1 id="story-headline">{TITLES[step - 1]}</h1><div className="story-body">{step === 6 ? <StoryInsurerEconomics /> : step === 9 ? <StoryMarketForecast /> : <StoryStaticScreen step={step} phase={phase} />}</div></main>
    <footer className="story-controls"><button type="button" onClick={previous} disabled={step === 1 && phase === 0} aria-label="Previous" className="story-nav-button"><ArrowLeftIcon /><span>Previous</span></button><div className="story-progress" aria-label="Story screens">{TITLES.map((title, index) => <button type="button" key={title} onClick={() => jump(index + 1)} aria-label={`Screen ${index + 1}: ${title}`} aria-current={step === index + 1 ? "step" : undefined}><span /></button>)}</div><button type="button" onClick={next} disabled={step === 9} aria-label="Next" className="story-nav-button"><span>Next</span><ArrowRightIcon /></button><button type="button" className="story-notes-toggle" onClick={() => setNotes(value => !value)} aria-expanded={notes} aria-label="Speaker notes">N</button></footer>
    {notes ? <aside className="story-notes" role="region" aria-label="Speaker notes"><div><strong>Speaker notes</strong><button type="button" onClick={() => setNotes(false)} aria-label="Close speaker notes"><XIcon size={20} /></button></div><p>{NOTES[step - 1]}</p></aside> : null}
    {fullscreenError ? <p className="story-fullscreen-error" role="status">{fullscreenError}</p> : null}
  </div>;
}
