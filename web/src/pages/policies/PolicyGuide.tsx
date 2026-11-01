import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Card } from "../../components/States";
import { CREATOR_STEPS, RECORDER_STEPS, RENTER_STEPS, alertRecipe, type JourneyStep } from "../../lib/policy";
import { nativeSymbol, networkName, symbol } from "./shared";
import catalog from "../../data/apartments-series.json";

type Tab = "renter" | "creator" | "record";
const TABS: { id: Tab; label: string; steps: JourneyStep[] }[] = [
  { id: "renter", label: "I want protection", steps: RENTER_STEPS },
  { id: "creator", label: "I want to fund a policy", steps: CREATOR_STEPS },
  { id: "record", label: "I want to record a rent", steps: RECORDER_STEPS },
];

function Steps({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="space-y-3" data-testid="guide-steps">
      {steps.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-x-3">
          <span className="font-parkDisplay font-bold text-core-green text-lg leading-6" aria-hidden="true">{i + 1}</span>
          <div className="min-w-0">
            <p className="font-parkBody font-bold leading-6"><span className="sr-only">Step {i + 1}: </span>{s.title}</p>
            <p className="font-parkBody text-sm text-surface-grey-2 leading-relaxed">{s.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="font-parkDisplay font-bold text-2xl scroll-mt-24">{children}</h2>;
}

export function PolicyGuide() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "renter") as Tab;
  const recipe = alertRecipe(catalog.series[0].slug);
  return (
    <div className="max-w-3xl mx-auto space-y-8 pb-12 min-w-0 [&_p]:leading-relaxed [&_li]:leading-relaxed">
      <header>
        <p className="font-parkBody font-bold">Step by step</p>
        <h1 className="font-parkDisplay font-bold text-3xl sm:text-4xl mt-2">How neighborhood policies work</h1>
        <p className="font-parkBody mt-3">
          Three roles, each a short checklist. Every page in the app shows which step you are on and what happens next; this page explains the pieces a first-timer meets along the way.
        </p>
      </header>

      <div role="tablist" aria-label="Who are you" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            data-testid={`guide-tab-${t.id}`}
            onClick={() => setParams({ tab: t.id })}
            className={`min-h-11 rounded-full border-2 px-4 font-parkBody text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green ${tab === t.id ? "border-core-green bg-green-0 font-bold" : "border-paper-2 bg-paper-0 hover:border-core-green"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <section key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={tab !== t.id}>
          <Card>
            <h2 className="font-parkDisplay font-bold text-2xl mb-4">{t.label}</h2>
            <Steps steps={t.steps} />
            <div className="mt-4 flex flex-wrap gap-x-5 font-parkBody text-sm font-bold text-core-green">
              {t.id === "renter" && <Link className="inline-flex min-h-11 items-center underline" to="/policies">Browse policies →</Link>}
              {t.id === "creator" && <Link className="inline-flex min-h-11 items-center underline" to="/policies/new">Create a policy →</Link>}
              {t.id === "record" && <Link className="inline-flex min-h-11 items-center underline" to="/policies/submit">Record a rent →</Link>}
            </div>
          </Card>
        </section>
      ))}

      <Card>
        <H2 id="money">Getting {symbol} and a little {nativeSymbol} on {networkName}</H2>
        <p className="font-parkBody mt-3">
          Policies are paid in <strong>{symbol}</strong>, a dollar-pegged token, on the <strong>{networkName}</strong> network. Your wallet holds balances per network, so {symbol} on another network does not count here.
        </p>
        <ol className="font-parkBody list-decimal pl-5 mt-3 space-y-2">
          <li><strong>Install a wallet</strong> (a browser extension or phone app that holds your tokens and signs for you) and add {networkName}; most wallets list it under networks.</li>
          <li><strong>Buy or move {symbol} to {networkName}.</strong> Exchanges let you withdraw {symbol} directly to {networkName}: choose that network when withdrawing. If your {symbol} is on another network, use a bridge.</li>
          <li><strong>Add a little {nativeSymbol} on {networkName} too.</strong> Every transaction pays a small network fee in {nativeSymbol}, even when you spend {symbol}. A few dollars' worth covers many transactions. Without it the buttons here will tell you so and nothing is sent.</li>
        </ol>
      </Card>

      <Card>
        <H2 id="approve">Why there is an approve step and then a buy or create step</H2>
        <p className="font-parkBody mt-3">
          Your {symbol} sits in your wallet, not in the app. Before the policy contract can take a payment, you grant it permission for a specific amount: that is the <strong>approve</strong> confirmation. It moves nothing by itself. The second confirmation, <strong>buy</strong> or <strong>create</strong>, is when the money actually moves. Each costs a small network fee. If you change the amount after approving, you may be asked to approve again.
        </p>
      </Card>

      <Card>
        <H2 id="alert">Setting up the Google Alert</H2>
        <p className="font-parkBody mt-3">
          Anyone can run the alert; whoever holds the month's email can record it. Use a mailbox you dedicate to alerts, because recording publishes the whole email. Go to <a className="underline font-bold text-core-green" href="https://www.google.com/alerts" target="_blank" rel="noreferrer">google.com/alerts</a>, signed in to that mailbox, and set:
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-parkBody text-sm" data-testid="alert-recipe">
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
        <ol className="font-parkBody list-decimal pl-5 mt-3 space-y-2">
          <li>Open the alert email in Gmail on a computer.</li>
          <li>Click the three-dot menu at the top right of the message (next to Reply).</li>
          <li>Choose <strong>Download message</strong>. Gmail saves a <code>.eml</code> file.</li>
          <li>Upload that file unchanged on the <Link className="underline font-bold text-core-green" to="/policies/submit">Record a rent</Link> page. Do not forward, print, or open and re-save it: those lose Google's signature.</li>
        </ol>
      </Card>

      <Card>
        <H2 id="dates">Key dates for a policy</H2>
        <p className="font-parkBody mt-3">Every policy page lists these with the exact time. In order:</p>
        <ol className="font-parkBody list-decimal pl-5 mt-3 space-y-2">
          <li><strong>Sales close</strong> at the first second of the policy month. Nobody can buy once that month's rent could already be published.</li>
          <li><strong>Record window</strong>: during the month and for seven days after, anyone can record a qualifying alert. The earliest-signed one wins; a later email can never replace it.</li>
          <li><strong>Claims open</strong> seven days after the month ends. Anyone can finalize; claiming finalizes automatically.</li>
          <li><strong>Claims close</strong> 30 days later (the app's default; at least 14). Anything unclaimed returns to the creator, who withdraws it from the policy page.</li>
        </ol>
      </Card>

      <Card>
        <H2 id="claim-refund">A claim versus a refund</H2>
        <p className="font-parkBody mt-3">
          A <strong>claim</strong> is a payout from the creator's escrow, set by the recorded rent: $0 at or below the starting rent, rising in a straight line to the full amount at the full-payout rent. The premium is spent either way.
        </p>
        <p className="font-parkBody mt-2">
          A <strong>refund</strong> happens only when no qualifying email was recorded for the month: the policy voids, buyers take back exactly the premium they paid, and the creator takes back the escrow. A missing email is never treated as "rent did not rise".
        </p>
      </Card>

      <Card>
        <H2 id="risks">What you must accept before committing money</H2>
        <ul className="font-parkBody list-disc pl-5 mt-3 space-y-2">
          <li>The contracts are <strong>unaudited</strong> and <strong>immutable</strong>: no owner, no upgrades, no way to reverse a mistake.</li>
          <li>The rent is <strong>a single publisher's headline figure</strong> relayed in a Google email. Google's signature proves Google sent the snippet, not that the number is right. If Google changes the email format or rotates its signing key, policies void.</li>
          <li>It <strong>does not pay based on your own lease</strong>. If the headline falls while your rent rises, you get nothing.</li>
          <li>Whoever holds an email decides whether to submit it, so the recorded value can depend on who was watching. Run your own alert.</li>
          <li>This is not insurance and nothing here is guaranteed. Only use money you can afford to lose.</li>
        </ul>
      </Card>
    </div>
  );
}
