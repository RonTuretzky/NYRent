import { Link } from "react-router-dom";
import { LiftedButton, Chip } from "@decentralpark/ui";
import {
  ArrowRightIcon,
  EnvelopeSimpleIcon,
  ShieldCheckIcon,
  VaultIcon,
} from "@phosphor-icons/react";
import { HowItWorks } from "../components/HowItWorks";
import { PayoutCurve } from "../components/PayoutCurve";
import { useAllSeries } from "../chain/hooks";
import { isDeployed } from "../chain/deployment";

export function Landing() {
  const { series } = useAllSeries();
  const demo = series[0]?.series;

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

  return (
    <div className="space-y-16">
      {/* hero */}
      <section className="pt-8 sm:pt-14 text-center max-w-3xl mx-auto">
        <div className="flex justify-center gap-2 flex-wrap mb-6">
          <Chip size="small">Gnosis Chain</Chip>
          <Chip size="small">Fully collateralized</Chip>
          <Chip size="small">DKIM-settled</Chip>
          <Chip size="small">Unaudited demo — tiny amounts</Chip>
        </div>
        <h1 className="font-parkDisplay font-bold text-4xl sm:text-6xl tracking-tight text-text-standard">
          Manhattan office-rent protection,{" "}
          <span className="text-core-green">settled by an email.</span>
        </h1>
        <p className="font-parkBody text-lg text-surface-grey-2 mt-6">
          NY Rent Cover pays out when CRE Daily's Market Snapshot reports
          Manhattan office rents above your strike. No oracle committee, no
          trusted server — the newsletter's own RSA-2048 DKIM signature is
          verified on-chain, and the printed “$/SF” number settles the market.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link to="/series">
            <LiftedButton rightIcon={<ArrowRightIcon size={20} />}>
              View series
            </LiftedButton>
          </Link>
          <Link to="/docs">
            <LiftedButton preset="secondary">Read the protocol</LiftedButton>
          </Link>
        </div>
      </section>

      {/* how it works */}
      <section className="max-w-5xl mx-auto">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">
            How it works
          </h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            Five steps from collateral to claim, each with its mechanics
            looping beside it. Every moving dot is a real on-chain transfer
            except one: the email, which is cryptography, not custody.
          </p>
        </div>
        <HowItWorks />
      </section>

      {/* pillars */}
      <section className="grid sm:grid-cols-3 gap-5 max-w-5xl mx-auto">
        <Pillar
          icon={<VaultIcon size={28} weight="bold" />}
          title="Solvent by construction"
        >
          The pool can never sell more max-claim than the capital it holds.
          Reserves are locked from purchase to redemption, and redemption can
          never be paused.
        </Pillar>
        <Pillar
          icon={<EnvelopeSimpleIcon size={28} weight="bold" />}
          title="The email is the oracle"
        >
          CRE Daily signs every newsletter with DKIM. The oracle contract
          verifies that signature against a pinned key and parses “Manhattan
          Office Rent … $92.88 / SF” straight out of the body. VERIFIED against
          the real 102 KB email.
        </Pillar>
        <Pillar
          icon={<ShieldCheckIcon size={28} weight="bold" />}
          title="Permissionless settlement"
        >
          Anyone holding the email can settle — upload the .eml, the app runs
          the full DKIM preflight locally, then submits it on-chain. First
          qualifying observation wins, once.
        </Pillar>
      </section>

      {/* payout curve preview */}
      <section className="max-w-3xl mx-auto">
        <div className="text-center mb-6">
          <h2 className="font-parkDisplay font-bold text-3xl text-text-standard">
            A linear payout between two strikes
          </h2>
          <p className="font-parkBody text-surface-grey-2 mt-3">
            {isDeployed && demo
              ? "The live demo series pays 0% at the low strike and 100% at the high strike."
              : "Example: strikes at $88.00 and $96.00. At the verified fixture value of $92.88 the payout ratio is 61%."}
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
