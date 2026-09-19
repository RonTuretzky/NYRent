import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatUnits } from "viem";
import { Button, LiftedButton } from "@decentralpark/ui";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CompassIcon,
  SealCheckIcon,
} from "@phosphor-icons/react";
import { useSeriesIndex } from "../chain/poolHooks";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import {
  recommend,
  type CandidateSeries,
  type Horizon,
  type Worry,
} from "../lib/recommend";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
} from "../components/States";
import { formatBps, formatCents, formatCurrency, nowSec } from "../chain/format";

interface OptionDef<T extends string | number> {
  value: T;
  label: string;
  desc?: string;
}

const RENT_OPTIONS: OptionDef<number>[] = [
  { value: 1200, label: "Under $1,500", desc: "we'll size around $1,200" },
  { value: 2000, label: "$1,500 – $2,500", desc: "we'll size around $2,000" },
  { value: 3200, label: "$2,500 – $4,000", desc: "we'll size around $3,200" },
  { value: 5000, label: "Over $4,000", desc: "we'll size around $5,000" },
];

const WORRY_OPTIONS: OptionDef<Worry>[] = [
  {
    value: "a-little",
    label: "A little",
    desc: "cushion a few months of a possible increase",
  },
  {
    value: "a-lot",
    label: "A lot",
    desc: "cover about a year of a possible increase",
  },
];

const HORIZON_OPTIONS: OptionDef<Horizon>[] = [
  {
    value: "this-window",
    label: "The next reading",
    desc: "protect against the nearest upcoming rent report",
  },
  {
    value: "longer",
    label: "As long as possible",
    desc: "prefer protection that runs further out",
  },
];

/** One card-style question: a real radio group, so arrow keys + space work
 * exactly like native radios (the inputs are visually hidden, labels are the
 * cards). */
function QuestionCards<T extends string | number>({
  name,
  legend,
  help,
  options,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  help: string;
  options: OptionDef<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="font-parkDisplay font-bold text-2xl text-text-standard">
        {legend}
      </legend>
      <p className="font-parkBody text-sm text-surface-grey-2 mt-1 mb-4">
        {help}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((opt) => {
          const selected = value === opt.value;
          return (
            <label
              key={String(opt.value)}
              className={`block cursor-pointer rounded-2xl border-2 p-4 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-core-green ${
                selected
                  ? "border-core-green bg-green-0/30"
                  : "border-paper-2 bg-paper-0 hover:border-core-green/60"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={String(opt.value)}
                checked={selected}
                onChange={() => onChange(opt.value)}
                className="sr-only"
              />
              <span className="font-parkDisplay font-bold text-text-standard">
                {opt.label}
              </span>
              {opt.desc ? (
                <span className="block font-parkBody text-xs text-surface-grey-2 mt-1">
                  {opt.desc}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Choose() {
  const navigate = useNavigate();
  const { deployment } = useActiveDeployment();
  const { symbol, decimals } = deployment.currency;
  const { rows, isLoading, rpcError } = useSeriesIndex();

  const [step, setStep] = useState(0);
  const [rent, setRent] = useState<number | undefined>(undefined);
  const [worry, setWorry] = useState<Worry | undefined>(undefined);
  const [horizon, setHorizon] = useState<Horizon | undefined>(undefined);

  const candidates = useMemo<CandidateSeries[]>(
    () =>
      rows.map((r) => ({
        id: r.id,
        strikeLowCents: r.series.strikeLowCents,
        strikeHighCents: r.series.strikeHighCents,
        premiumRateBps: r.series.premiumRateBps,
        saleEnd: r.series.saleEnd,
        obsStart: r.series.obsStart,
        obsEnd: r.series.obsEnd,
        escrow: r.series.escrow,
        sold: r.series.sold,
        paused: r.paused,
        settled: r.series.settled,
        cancelled: r.series.cancelled,
      })),
    [rows],
  );

  const result = useMemo(() => {
    if (rent === undefined || worry === undefined || horizon === undefined) {
      return null;
    }
    return recommend({
      monthlyRentUsd: rent,
      worry,
      horizon,
      nowSec: nowSec(),
      currencyDecimals: decimals,
      series: candidates,
    });
  }, [rent, worry, horizon, decimals, candidates]);

  const picked = result
    ? rows.find((r) => r.id === result.seriesId)
    : undefined;

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        The market opens once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }

  const steps = [
    {
      done: rent !== undefined,
      node: (
        <QuestionCards
          name="rent"
          legend="Roughly, what's your monthly rent?"
          help="A rough range is fine — we only use it to suggest a sensible protection size. Nothing is stored or sent anywhere."
          options={RENT_OPTIONS}
          value={rent}
          onChange={setRent}
        />
      ),
    },
    {
      done: worry !== undefined,
      node: (
        <QuestionCards
          name="worry"
          legend="How worried are you about rent going up?"
          help="This sets how big a payout we suggest — you can change the amount later."
          options={WORRY_OPTIONS}
          value={worry}
          onChange={setWorry}
        />
      ),
    },
    {
      done: horizon !== undefined,
      node: (
        <QuestionCards
          name="horizon"
          legend="How far ahead do you want protection?"
          help="Each series watches one reporting window of the rent index."
          options={HORIZON_OPTIONS}
          value={horizon}
          onChange={setHorizon}
        />
      ),
    },
  ];

  const onResult = step === steps.length;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header>
        <div className="flex items-center gap-2 text-core-green">
          <CompassIcon size={24} weight="bold" />
          <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
            Help me choose
          </h1>
        </div>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Three quick questions, then we point you at the best-priced open
          protection on {deployment.name} — sized to your rent.
        </p>
        <p className="font-parkBody text-xs text-surface-grey mt-1">
          Heads-up: payouts follow an index of Manhattan office rent
          (commercial, not residential) — a barometer for the market, not
          your exact lease.
        </p>
      </header>

      {!onResult ? (
        <Card>
          <p className="font-parkBody text-xs text-surface-grey-2 mb-4">
            Question {step + 1} of {steps.length}
          </p>
          {steps[step].node}
          <div className="mt-6 flex justify-between">
            <Button
              app="fund"
              variant="light"
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              <ArrowLeftIcon size={16} className="inline -mt-0.5 mr-1" />
              Back
            </Button>
            <Button
              app="fund"
              disabled={!steps[step].done}
              onClick={() => setStep((s) => s + 1)}
              data-testid="choose-next"
            >
              {step === steps.length - 1 ? "See my match" : "Next"}
              <ArrowRightIcon size={16} className="inline -mt-0.5 ml-1" />
            </Button>
          </div>
        </Card>
      ) : isLoading ? (
        <Card>
          <LoadingSkeleton lines={4} />
        </Card>
      ) : rpcError && rows.length === 0 ? (
        <RpcDownState />
      ) : !result || !picked ? (
        <div className="space-y-4">
          <EmptyState title="Nothing is open for purchase right now">
            No series on {deployment.name} is currently selling protection.
            Check{" "}
            <Link to="/series" className="underline">
              the series list
            </Link>{" "}
            — or become the market yourself: anyone can{" "}
            <Link to="/underwrite" className="underline">
              underwrite a new series
            </Link>
            .
          </EmptyState>
          <Button
            app="fund"
            variant="light"
            onClick={() => setStep(steps.length - 1)}
          >
            <ArrowLeftIcon size={16} className="inline -mt-0.5 mr-1" />
            Back
          </Button>
        </div>
      ) : (
        <Card data-testid="choose-result">
          <div className="flex items-center gap-2 mb-2">
            <SealCheckIcon size={22} weight="fill" className="text-core-green" />
            <h2 className="font-parkDisplay font-bold text-xl">
              Your match: series #{result.seriesId}
            </h2>
            {result.standard ? (
              <span className="font-parkBody text-xs font-bold rounded-full px-3 py-1 border border-core-green text-core-green">
                standard
              </span>
            ) : null}
          </div>

          <p className="font-parkBody text-text-standard">
            This is the best-priced protection open right now on{" "}
            {deployment.name}: it starts paying when the reported rent index
            rises above {formatCents(picked.series.strikeLowCents)} and pays
            in full at {formatCents(picked.series.strikeHighCents)}.
          </p>

          <div className="mt-4 border-l-4 border-core-green pl-4 py-1 space-y-2">
            <p className="font-parkBody text-text-standard">
              If rent rises ~{Math.round(result.riseFraction * 100)}%, this
              pays about{" "}
              <span className="font-bold">
                {result.monthsCovered >= 1
                  ? `${result.monthsCovered.toFixed(result.monthsCovered >= 10 ? 0 : 1)} months`
                  : "under a month"}
              </span>{" "}
              of your rent increase — up to{" "}
              <span className="font-bold text-core-green">
                {formatCurrency(result.suggestedClaimWei, { symbol, decimals })}
              </span>
              .
            </p>
            <p className="font-parkBody text-sm text-surface-grey-2">
              You'd pay{" "}
              <span className="font-bold">
                {formatCurrency(result.premiumWei, { symbol, decimals })}
              </span>{" "}
              once ({formatBps(result.premiumRateBps)} of the protection
              amount). If the index stays below{" "}
              {formatCents(picked.series.strikeLowCents)}, you get nothing
              more and owe nothing. Your potential payout is already escrowed
              in a contract nobody can pause or take away.
            </p>
            {result.capacityLimited ? (
              <p className="font-parkBody text-xs text-system-warning font-bold">
                Heads-up: only this much protection is left unsold in the
                series — the suggestion is capped at what's available.
              </p>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <LiftedButton
              rightIcon={<ArrowRightIcon size={18} />}
              onClick={() =>
                navigate(
                  `/buy/${result.seriesId}?amount=${formatUnits(result.suggestedClaimWei, decimals)}`,
                )
              }
              data-testid="choose-continue"
            >
              Continue — buy this protection
            </LiftedButton>
            <Link to={`/series/${result.seriesId}`}>
              <Button app="fund" variant="secondary">
                See full terms
              </Button>
            </Link>
            <Button
              app="fund"
              variant="light"
              onClick={() => setStep(0)}
            >
              Start over
            </Button>
          </div>
          <p className="font-parkBody text-xs text-surface-grey mt-4">
            You can change the amount on the next screen. Reminder: the index
            tracks Manhattan office rent (commercial, not residential).
          </p>
        </Card>
      )}
    </div>
  );
}
