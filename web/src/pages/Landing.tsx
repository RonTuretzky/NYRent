import { Suspense, lazy } from "react";
import { Link } from "react-router-dom";
import { LiftedButton, Chip } from "@decentralpark/ui";
import {
  ArrowRightIcon,
  CompassIcon,
  EnvelopeSimpleIcon,
  ShieldCheckIcon,
  VaultIcon,
} from "@phosphor-icons/react";
import { PayoutCurve } from "../components/PayoutCurve";
import { useSeriesIndex } from "../chain/poolHooks";
import {
  DEPLOYMENTS,
  PRODUCTION_CHAIN_IDS,
  isLiveDeployment,
  useActiveDeployment,
} from "../chain/registry";
import { addressUrl } from "../chain/explorer";

// The 800+-line animated explainer is below the fold on every visit — load it
// as its own chunk so the eager landing bundle stays small. The Suspense
// fallback reserves the same vertical rhythm (five step rows) to avoid CLS.
const HowItWorks = lazy(() =>
  import("../components/HowItWorks").then((m) => ({ default: m.HowItWorks })),
);

function HowItWorksSkeleton() {
  return (
    <div className="space-y-16 sm:space-y-24" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="nrc-skeleton h-64 rounded-2xl" />
      ))}
    </div>
  );
}

export function Landing() {
  const { deployment } = useActiveDeployment();
  const { rows } = useSeriesIndex();
  const demo = rows[0]?.series;
  const live = isLiveDeployment(deployment);

  // Curve preview: live settled point when available, else the verified
  // fixture value ($92.88 → 61% between the demo strikes).
  const preview = demo?.settled
    ? {
        cents:
          demo.strikeLowCents +
          Math.round(
            (Number(demo.payoutRatioWad) / 1e18) *
              (demo.strikeHighCents - demo.strikeLowCents),
          ),
        ratioWad: demo.payoutRatioWad,
      }
    : { cents: 9288, ratioWad: 610_000_000_000_000_000n };

  // Chain names in copy come from the registry, never hardcoded.
  const chains = Object.values(DEPLOYMENTS).filter((d) =>
    PRODUCTION_CHAIN_IDS.includes(d.chainId),
  );

  return (
    <div className="space-y-16">
      {/* hero — plain rent story, no index jargon (specifics live one level
          down: series detail + docs) */}
      <section className="pt-8 sm:pt-14 text-center max-w-3xl mx-auto">
        <div className="flex justify-center gap-2 flex-wrap mb-6">
          <Chip size="small">{chains.map((d) => d.name).join(" + ")}</Chip>
          <Chip size="small">Money escrowed up front</Chip>
          <Chip size="small">Unaudited experiment — tiny amounts</Chip>
        </div>
        <h1 className="font-parkDisplay font-bold text-4xl sm:text-6xl tracking-tight text-text-standard">
          Rent goes up.{" "}
          <span className="text-core-green">RentSafe pays you when it does.</span>
        </h1>
        <p className="font-parkBody text-lg text-surface-grey-2 mt-6">
          Pay a small one-time price for protection. If the reported rent
          number rises past your level, you get paid — automatically, from
          money that was locked up before you ever bought. The rent number
          comes from rent newsletters that are cryptographically signed, so
          nobody can fake it: the newsletter itself is the oracle.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link to="/choose">
            <LiftedButton rightIcon={<CompassIcon size={20} />}>
              Help me choose
            </LiftedButton>
          </Link>
          <Link to="/markets">
            <LiftedButton
              preset="secondary"
              rightIcon={<ArrowRightIcon size={20} />}
            >
              View market
            </LiftedButton>
          </Link>
        </div>
        <p className="font-parkBody text-xs text-surface-grey mt-5">
          Live on{" "}
          {chains.map((d, i) => (
            <span key={d.chainId}>
              {i > 0 ? " and " : ""}
              <a
                href={addressUrl(d.pool, d.explorerBase)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted"
              >
                {d.name}
              </a>{" "}
              ({d.currency.symbol})
            </span>
          ))}
          . The index behind it tracks Manhattan office rent (commercial, not
          residential).
        </p>
      </section>

      {/* how it works */}
      <section className="max-w-5xl mx-auto">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">
            How it works
          </h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            Someone locks up money to back the protection. You pay once and
            you're covered. A signed rent newsletter — which nobody can forge
            — sets the result, and if rent rose past your level you claim
            your payout. Watch each step loop below.
          </p>
        </div>
        <Suspense fallback={<HowItWorksSkeleton />}>
          <HowItWorks />
        </Suspense>
      </section>

      {/* pillars */}
      <section className="grid sm:grid-cols-3 gap-5 max-w-5xl mx-auto">
        <Pillar
          icon={<VaultIcon size={28} weight="bold" />}
          title="The money is already there"
        >
          Whoever underwrites a market deposits its full payout capacity into
          the contract before a single unit is sold. Your potential payout is
          held where nobody can pause it or take it away.
        </Pillar>
        <Pillar
          icon={<EnvelopeSimpleIcon size={28} weight="bold" />}
          title="The newsletter is the oracle"
        >
          The rent number comes from a rent newsletter carrying the
          publisher's cryptographic signature (DKIM), verified on-chain
          against a pinned key. No committee, no trusted server — an email
          nobody can fake settles the market.
        </Pillar>
        <Pillar
          icon={<ShieldCheckIcon size={28} weight="bold" />}
          title="Anyone can settle"
        >
          Whoever holds the newsletter can settle a market — upload the raw
          email, the app checks every rule locally, then submits it on-chain.
          First qualifying reading wins, once.
        </Pillar>
      </section>

      {/* payout curve preview */}
      <section className="max-w-3xl mx-auto">
        <div className="text-center mb-6">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">
            The higher rent goes, the more you're paid
          </h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            {live && demo
              ? "Each market pays 0% at its low level and 100% at its high level, sliding linearly in between."
              : "Example: levels at $88.00 and $96.00. At the verified reading of $92.88 the payout ratio is 61%."}
          </p>
        </div>
        <div className="bg-paper-0 border-2 border-paper-2 rounded-2xl p-6">
          <PayoutCurve
            lowCents={demo?.strikeLowCents ?? 8800}
            highCents={demo?.strikeHighCents ?? 9600}
            settledCents={preview.cents}
            ratioWad={preview.ratioWad}
          />
        </div>
        <p className="font-parkBody text-xs text-surface-grey text-center mt-4">
          Want the full mechanics, addresses and evidence chain?{" "}
          <Link to="/docs" className="underline decoration-dotted">
            Read the docs
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function Pillar({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-paper-0 border-2 border-paper-2 rounded-2xl p-6">
      <div className="text-core-green">{icon}</div>
      <h3 className="font-parkDisplay font-bold text-lg text-text-standard mt-3">
        {title}
      </h3>
      <p className="font-parkBody text-sm text-surface-grey-2 mt-2">
        {children}
      </p>
    </div>
  );
}
