import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Chip, LiftedButton } from "@decentralpark/ui";
import {
  ArrowRightIcon,
  BankIcon,
  CalendarCheckIcon,
  EnvelopeSimpleIcon,
  ArrowCounterClockwiseIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { NETWORK, POOLS } from "../chain/apartments";
import { Card, EmptyState, LoadingSkeleton, RpcDownState, RpcStaleBanner } from "../components/States";
import { PayoutCurve } from "../components/PayoutCurve";
import catalog from "../data/apartments-series.json";
import { NotDeployed, useNow } from "./policies/shared";
import { PolicyCard, cardTestId, usePolicyRows } from "./policies/listing";

const PREVIEW_COUNT = 3;

const ROLES: { tab: string; title: string; body: string; cta: string; icon: ReactNode }[] = [
  {
    tab: "renter",
    title: "Renters",
    body: "Pay a small premium now. If the neighborhood's headline rent climbs past the policy's level, claim a payout.",
    cta: "How buying works",
    icon: <ShieldCheckIcon size={26} weight="fill" />,
  },
  {
    tab: "creator",
    title: "Creators",
    body: `Escrow ${NETWORK.symbol} for a neighborhood and month, set the price, and keep every premium. You pay out if the rent rises.`,
    cta: "How creating works",
    icon: <BankIcon size={26} weight="fill" />,
  },
  {
    tab: "record",
    title: "Recorders",
    body: "Run a Google Alert on an Apartments.com page and upload the month's email. It sets the rent every policy on that page uses.",
    cta: "How recording works",
    icon: <EnvelopeSimpleIcon size={26} weight="fill" />,
  },
];

const SETTLES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "A Google-signed alert",
    body: "Google Alerts emails the Apartments.com headline rent for the neighborhood page. Its DKIM signature is checked on-chain, so nobody can type in a number.",
    icon: <EnvelopeSimpleIcon size={24} weight="fill" />,
  },
  {
    title: "Earliest in the month wins",
    body: "The first qualifying email signed during the policy month is the one recorded. A later email can never replace it.",
    icon: <CalendarCheckIcon size={24} weight="fill" />,
  },
  {
    title: "No email means a refund",
    body: "If no qualifying email is recorded, the policy voids: buyers get their premium back and the creator gets the escrow back.",
    icon: <ArrowCounterClockwiseIcon size={24} weight="fill" />,
  },
];

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** A worked example from the first catalog page that has a known October rent. */
function ExampleCard() {
  const page = catalog.series.find((s) => s.october2026Cents) ?? catalog.series[0];
  const october = page.october2026Cents ?? 300000;
  const low = Math.round((october * 1.03) / 100) * 100;
  const high = Math.round((october * 1.1) / 100) * 100;
  return (
    <Card className="min-w-0" data-testid="home-example">
      <p className="font-parkBody text-xs font-bold uppercase tracking-wide text-surface-grey-2">Example policy</p>
      <p className="font-parkDisplay font-bold text-2xl mt-1">{page.geography}</p>
      <p className="font-parkBody text-sm text-surface-grey-2">
        October 2026 headline rent {dollars(october)}/mo
      </p>
      <div className="mt-3">
        <PayoutCurve lowCents={low} highCents={high} width={420} />
      </div>
      <p className="font-parkBody text-sm mt-2 leading-relaxed">
        Nothing at or below {dollars(low)}, rising in a straight line to the full payout at {dollars(high)} or more.
      </p>
    </Card>
  );
}

function Preview() {
  const { items, total, isLoading, rpcDown, stale, refetch } = usePolicyRows(PREVIEW_COUNT);
  const now = useNow();
  if (POOLS.length === 0) return <NotDeployed />;
  return (
    <div className="space-y-4">
      {stale && <RpcStaleBanner />}
      {rpcDown ? (
        <RpcDownState onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => <Card key={i}><LoadingSkeleton lines={5} /></Card>)}
        </div>
      ) : items.length === 0 ? (
        <div data-testid="home-preview-empty">
          <EmptyState title="No policies yet">
            <p>
              Nobody has opened a policy on {NETWORK.name}.{" "}
              <Link className="underline font-bold text-core-green" to="/policies/new">Create the first one</Link> or read the{" "}
              <Link className="underline font-bold text-core-green" to="/policies/guide">guide</Link>.
            </p>
          </EmptyState>
        </div>
      ) : (
        <>
          <ul className="grid gap-4 md:grid-cols-3 list-none p-0 m-0" data-testid="home-preview">
            {items.map((item) => (
              <li key={`${item.version}-${item.id}`} className="min-w-0">
                <PolicyCard item={item} now={now} testId={cardTestId("home-policy", item)} />
              </li>
            ))}
          </ul>
          {total > PREVIEW_COUNT && (
            <p className="font-parkBody text-sm text-surface-grey-2">
              Showing the newest {PREVIEW_COUNT} of {total}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function Home() {
  return (
    <div className="space-y-12 pb-12 min-w-0">
      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] items-center" aria-labelledby="home-title">
        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <Chip size="small">Neighborhood rent policies</Chip>
            <Chip size="small">{NETWORK.symbol} on {NETWORK.name}</Chip>
          </div>
          <h1 id="home-title" className="font-parkDisplay font-bold text-4xl sm:text-5xl tracking-tight mt-4">
            Get paid when your neighborhood's rent climbs.
          </h1>
          <p className="font-parkBody text-lg text-surface-grey-2 mt-4 max-w-2xl leading-relaxed" data-testid="home-pitch">
            RentSafe policies pay out in {NETWORK.symbol} on {NETWORK.name} when the Apartments.com headline rent for a
            New York neighborhood rises past a level fixed in advance, as recorded from a Google-signed alert email.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Link to="/policies" data-testid="home-browse" className="inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-core-green">
              <LiftedButton tabIndex={-1} rightIcon={<ArrowRightIcon weight="bold" />}>Browse policies</LiftedButton>
            </Link>
            <Link to="/policies/new" data-testid="home-create" className="inline-flex rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-core-green">
              <LiftedButton tabIndex={-1} preset="secondary">Create a policy</LiftedButton>
            </Link>
          </div>
        </div>
        <ExampleCard />
      </section>

      <section aria-labelledby="home-roles">
        <h2 id="home-roles" className="font-parkDisplay font-bold text-2xl sm:text-3xl">Three ways to take part</h2>
        <ul className="grid gap-4 md:grid-cols-3 mt-4 list-none p-0 m-0">
          {ROLES.map((r) => (
            <li key={r.tab} className="min-w-0">
              <Link
                to={`/policies/guide?tab=${r.tab}`}
                data-testid={`home-role-${r.tab}`}
                className="group block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-core-green"
              >
                <Card className="h-full group-hover:border-core-green">
                  <span className="flex items-center gap-2 text-green-1">
                    {r.icon}
                    <span className="font-parkDisplay font-bold text-xl text-text-standard">{r.title}</span>
                  </span>
                  <p className="font-parkBody text-sm text-surface-grey-2 mt-2 leading-relaxed">{r.body}</p>
                  <p className="font-parkBody text-sm font-bold text-green-1 mt-3 inline-flex items-center gap-1.5">
                    {r.cta} <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
                  </p>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="home-newest">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 mb-4">
          <h2 id="home-newest" className="font-parkDisplay font-bold text-2xl sm:text-3xl">Newest policies</h2>
          <Link to="/policies" data-testid="home-see-all" className="inline-flex min-h-11 items-center gap-1.5 font-parkBody text-sm font-bold text-green-1 underline">
            See all policies <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
          </Link>
        </div>
        <Preview />
      </section>

      <section className="rounded-2xl bg-green-1 text-white p-6 sm:p-8" aria-labelledby="home-settles" data-testid="home-settles">
        <h2 id="home-settles" className="font-parkDisplay font-bold text-2xl sm:text-3xl">How a policy settles</h2>
        <ol className="grid gap-6 md:grid-cols-3 mt-5 list-none p-0 m-0">
          {SETTLES.map((s, i) => (
            <li key={s.title} className="min-w-0">
              <span className="flex items-center gap-2">
                {s.icon}
                <span className="font-parkBody font-bold"><span className="sr-only">{i + 1}. </span>{s.title}</span>
              </span>
              <p className="font-parkBody text-sm mt-2 leading-relaxed text-white/90">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-2xl border-2 border-system-warning/40 bg-system-warning/10 p-5 sm:p-6" aria-labelledby="home-risks" data-testid="home-risks">
        <div className="flex items-center gap-2">
          <WarningCircleIcon size={24} weight="fill" aria-hidden="true" />
          <h2 id="home-risks" className="font-parkDisplay font-bold text-2xl">Before you put money in</h2>
        </div>
        <ul className="font-parkBody list-disc pl-5 mt-3 space-y-2 leading-relaxed">
          <li>The contracts are <strong>unaudited</strong> and <strong>immutable</strong>: no owner, no upgrades, no way to reverse a mistake.</li>
          <li>This is <strong>not insurance</strong> and nothing here is guaranteed. Only use money you can afford to lose.</li>
          <li>It <strong>does not pay based on your own lease</strong>. It pays on one publisher's headline figure, so your rent can rise while the headline does not.</li>
        </ul>
        <p className="font-parkBody text-sm mt-3">
          <Link className="underline font-bold text-green-1" to="/policies/guide">Read the full guide</Link> for the dates, the email setup and every risk.
        </p>
      </section>
    </div>
  );
}
