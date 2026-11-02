import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Chip, LiftedButton } from "@decentralpark/ui";
import { BankIcon, EnvelopeSimpleIcon, ShieldCheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Card } from "../../components/States";
import { CREATOR_STEPS, RECORDER_STEPS, RENTER_STEPS, alertRecipe, type JourneyStep } from "../../lib/policy";
import { nativeSymbol, networkName, symbol } from "./shared";
import catalog from "../../data/apartments-series.json";

type Tab = "renter" | "creator" | "record";
const TABS: { id: Tab; label: string; blurb: string; icon: ReactNode; steps: JourneyStep[]; to: string; cta: string }[] = [
  { id: "renter", label: "I want protection", blurb: "Pay a premium and claim if the rent climbs.", icon: <ShieldCheckIcon size={24} weight="fill" />, steps: RENTER_STEPS, to: "/policies", cta: "Browse policies" },
  { id: "creator", label: "I want to fund a policy", blurb: "Escrow the payout and earn the premiums.", icon: <BankIcon size={24} weight="fill" />, steps: CREATOR_STEPS, to: "/policies/new", cta: "Create a policy" },
  { id: "record", label: "I want to record a rent", blurb: "Bring the Google Alert that settles a month.", icon: <EnvelopeSimpleIcon size={24} weight="fill" />, steps: RECORDER_STEPS, to: "/policies/submit", cta: "Record a rent" },
];

const TOPICS = [
  { id: "money", label: "Getting funds" },
  { id: "approve", label: "Why approve first" },
  { id: "alert", label: "Google Alert setup" },
  { id: "eml", label: "Download the email" },
  { id: "dates", label: "Key dates" },
  { id: "claim-refund", label: "Claim or refund" },
  { id: "risks", label: "The risks" },
];

function StepNumber({ n }: { n: number }) {
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-1 font-parkBody text-sm font-bold text-white" aria-hidden="true">{n}</span>;
}

function Steps({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="guide-steps">
      {steps.map((s, i) => (
        <li key={s.title} className="min-w-0 rounded-xl border-2 border-paper-1 bg-paper-main p-4">
          <StepNumber n={i + 1} />
          <p className="font-parkBody font-bold leading-6 mt-3"><span className="sr-only">Step {i + 1}: </span>{s.title}</p>
          <p className="font-parkBody text-sm text-surface-grey-2 leading-relaxed mt-1">{s.detail}</p>
        </li>
      ))}
    </ol>
  );
}

/** Numbered instructions; every item carries the same rail of circles as the journeys. */
function Numbered({ items }: { items: ReactNode[] }) {
  return (
    <ol className="mt-4 space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 min-w-0">
          <StepNumber n={i + 1} />
          <p className="font-parkBody min-w-0 pt-0.5"><span className="sr-only">{i + 1}. </span>{item}</p>
        </li>
      ))}
    </ol>
  );
}

function Tile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border-2 border-paper-1 bg-paper-main p-4">
      <p className="font-parkBody font-bold">{title}</p>
      <p className="font-parkBody text-sm text-surface-grey-2 mt-1">{children}</p>
    </div>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="font-parkDisplay font-bold text-2xl scroll-mt-6">{children}</h2>;
}

export function PolicyGuide() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "renter") as Tab;
  const recipe = alertRecipe(catalog.series[0].slug);
  return (
    <div className="space-y-8 pb-12 min-w-0 [&_p]:leading-relaxed [&_li]:leading-relaxed">
      <header className="max-w-3xl">
        <div className="flex"><Chip size="small">Step by step</Chip></div>
        <h1 className="font-parkDisplay font-bold text-4xl sm:text-5xl tracking-tight mt-3">How neighborhood policies work</h1>
        <p className="font-parkBody text-surface-grey-2 mt-3">
          Three roles, each a short checklist. Every page in the app shows which step you are on and what happens next; this page explains the pieces a first-timer meets along the way.
        </p>
      </header>

      <div role="tablist" aria-label="Who are you" className="grid gap-3 sm:grid-cols-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            data-testid={`guide-tab-${t.id}`}
            onClick={() => setParams({ tab: t.id })}
            className={`min-h-11 min-w-0 rounded-2xl border-2 p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green ${tab === t.id ? "border-core-green bg-paper-1" : "border-paper-2 bg-paper-0 hover:border-core-green"}`}
          >
            <span className="flex items-center gap-2 font-parkBody font-bold text-text-standard"><span className="text-green-1">{t.icon}</span>{t.label}</span>
            <span className="block font-parkBody text-sm text-surface-grey-2 mt-1">{t.blurb}</span>
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <section key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>
          <Card>
            <h2 className="font-parkDisplay font-bold text-2xl mb-4">{t.label}</h2>
            <Steps steps={t.steps} />
            <div className="mt-5"><Link to={t.to}><LiftedButton>{t.cta}</LiftedButton></Link></div>
          </Card>
        </section>
      ))}

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] items-start">
        <nav aria-label="On this page" className="hidden lg:block lg:sticky lg:top-6">
          <p className="font-parkBody text-sm font-bold mb-1">Good to know</p>
          {TOPICS.map((t) => (
            <button
              key={t.id} type="button"
              className="block min-h-11 w-full text-left font-parkBody text-sm text-surface-grey-2 hover:text-green-1"
              onClick={() => document.getElementById(t.id)?.scrollIntoView({ behavior: "smooth" })}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 space-y-6">
      <Card>
        <H2 id="money">Getting {symbol} and a little {nativeSymbol} on {networkName}</H2>
        <p className="font-parkBody mt-3">
          Policies are paid in <strong>{symbol}</strong>, a dollar-pegged token, on the <strong>{networkName}</strong> network. Your wallet holds balances per network, so {symbol} on another network does not count here.
        </p>
        <Numbered items={[
          <><strong>Install a wallet</strong> (a browser extension or phone app that holds your tokens and signs for you) and add {networkName}; most wallets list it under networks.</>,
          <><strong>Buy or move {symbol} to {networkName}.</strong> Exchanges let you withdraw {symbol} directly to {networkName}: choose that network when withdrawing. If your {symbol} is on another network, use a bridge.</>,
          <><strong>Add a little {nativeSymbol} on {networkName} too.</strong> Every transaction pays a small network fee in {nativeSymbol}, even when you spend {symbol}. A few dollars' worth covers many transactions. Without it the buttons here will tell you so and nothing is sent.</>,
        ]} />
      </Card>

      <Card>
        <H2 id="approve">Why there is an approve step and then a buy or create step</H2>
        <p className="font-parkBody mt-3">Your {symbol} sits in your wallet, not in the app, so there are two confirmations.</p>
        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          <Tile title="1. Approve">You grant the policy contract permission for a specific amount. It moves nothing by itself.</Tile>
          <Tile title="2. Buy or create">This is when the money actually moves.</Tile>
        </div>
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">Each costs a small network fee. If you change the amount after approving, you may be asked to approve again.</p>
      </Card>

      <Card>
        <H2 id="alert">Setting up the Google Alert</H2>
        <p className="font-parkBody mt-3">
          Anyone can run the alert; whoever holds the month's email can record it. Use a mailbox you dedicate to alerts, because recording publishes the whole email. Go to <a className="underline font-bold text-green-1" href="https://www.google.com/alerts" target="_blank" rel="noreferrer">google.com/alerts</a>, signed in to that mailbox, and set:
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border-2 border-paper-1 bg-paper-main p-4 font-parkBody text-sm" data-testid="alert-recipe">
          <dt className="font-bold">Search query</dt><dd className="break-all">The exact page address, for example <code>{recipe.query}</code></dd>
          <dt className="font-bold">How often</dt><dd>{recipe.howOften}</dd>
          <dt className="font-bold">Sources</dt><dd>{recipe.sources}</dd>
          <dt className="font-bold">Language</dt><dd>{recipe.language}</dd>
          <dt className="font-bold">Region</dt><dd>{recipe.region}</dd>
          <dt className="font-bold">How many</dt><dd>{recipe.howMany}</dd>
          <dt className="font-bold">Deliver to</dt><dd>the dedicated mailbox</dd>
        </dl>
        <p className="font-parkBody mt-3 text-sm">
          Click "Show options" to see the frequency and quantity settings. Google sends an email when it sees a change on that page; the one that counts for a month is signed during that month and contains the sentence "As of Month Year, the average rent in Name was $n/mo." Other snippets from the same page, like "Average Rent by Bedroom", do not qualify. Alerts are not guaranteed to arrive; run more than one if you care about the outcome.
        </p>
      </Card>

      <Card>
        <H2 id="eml">Downloading the original email from Gmail</H2>
        <Numbered items={[
          <>Open the alert email in Gmail on a computer.</>,
          <>Click the three-dot menu at the top right of the message (next to Reply).</>,
          <>Choose <strong>Download message</strong>. Gmail saves a <code>.eml</code> file.</>,
          <>Upload that file unchanged on the <Link className="underline font-bold text-green-1" to="/policies/submit">Record a rent</Link> page. Do not forward, print, or open and re-save it: those lose Google's signature.</>,
        ]} />
      </Card>

      <Card>
        <H2 id="dates">Key dates for a policy</H2>
        <p className="font-parkBody mt-3">Every policy page lists these with the exact time. In order:</p>
        <Numbered items={[
          <><strong>Sales close</strong> when the creator chose: when the month starts, a few days into it, or at its end at the latest. Sales also stop on their own the moment the month's rent is recorded on-chain, and the creator can pause them any time.</>,
          <><strong>Record window</strong>: during the month and for two days after, anyone can record a qualifying alert. The earliest-signed one wins; a later email can never replace it.</>,
          <><strong>Claims open</strong> two days after the month ends. Anyone can finalize; claiming finalizes automatically.</>,
          <><strong>Claims close</strong> 30 days later (the app's default; at least 14). Anything unclaimed returns to the creator, who withdraws it from the policy page.</>,
        ]} />
        <p className="font-parkBody text-sm mt-3" data-testid="guide-open-sales">
          <strong>If sales stay open into the month</strong>, buyers may already know the rent: once Google sends the month's alert, anyone who saw it can buy knowing the outcome, until someone records it. Creators price that in, or close sales when the month starts.
        </p>
      </Card>

      <Card>
        <H2 id="claim-refund">A claim versus a refund</H2>
        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          <Tile title="Claim">A payout from the creator's escrow, set by the recorded rent: $0 at or below the starting rent, rising in a straight line to the full amount at the full-payout rent. The premium is spent either way.</Tile>
          <Tile title="Refund">Happens only when no qualifying email was recorded for the month: the policy voids, buyers take back exactly the premium they paid, and the creator takes back the escrow. A missing email is never treated as "rent did not rise".</Tile>
        </div>
      </Card>

      <div className="rounded-2xl border-2 border-system-warning/40 bg-system-warning/10 p-5 sm:p-6">
        <div className="flex items-center gap-2"><WarningCircleIcon size={24} weight="fill" aria-hidden="true" /><H2 id="risks">What you must accept before committing money</H2></div>
        <ul className="font-parkBody list-disc pl-5 mt-3 space-y-2">
          <li>The contracts are <strong>unaudited</strong> and <strong>immutable</strong>: no owner, no upgrades, no way to reverse a mistake.</li>
          <li>The rent is <strong>a single publisher's headline figure</strong> relayed in a Google email. Google's signature proves Google sent the snippet, not that the number is right. If Google changes the email format or rotates its signing key, policies void.</li>
          <li>It <strong>does not pay based on your own lease</strong>. If the headline falls while your rent rises, you get nothing.</li>
          <li>Whoever holds an email decides whether to submit it, so the recorded value can depend on who was watching. Run your own alert.</li>
          <li>This is not insurance and nothing here is guaranteed. Only use money you can afford to lose.</li>
        </ul>
      </div>
        </div>
      </div>
    </div>
  );
}
