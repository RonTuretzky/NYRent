import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { decodeEventLog } from "viem";
import { Button } from "@decentralpark/ui";
import { APARTMENTS_POOL, CURRENCY_DECIMALS } from "../../chain/apartments";
import { apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { formatCents, formatTimestamp } from "../../chain/format";
import { useTx } from "../../chain/useTx";
import { Card, StatRow } from "../../components/States";
import { TxStatus } from "../../components/TxStatus";
import { DEFAULT_CLAIM_SECONDS, SUBMISSION_GRACE_SECONDS, monthBounds, monthLabel } from "../../lib/googleAlert";
import { CREATOR_STEPS, buyExample, creatorExample, pageUrl, parseAmount, parsePremiumPercent, parseRentDollars } from "../../lib/policy";
import catalog from "../../data/apartments-series.json";
import {
  ActionFailureHint, FundedAction, KeyDates, NotDeployed, Notice, RiskNotice, StepBar, WalletGate, chainId, inputClass, money, neighborhood,
  networkName, pool, symbol, txBusy, txOpts, useLock, useNow, useWalletFunds,
} from "./shared";

type Entry = (typeof catalog.series)[number] & { october2026Cents?: number };

function nextMonths(count: number, now: bigint) {
  const d0 = new Date(Number(now) * 1000);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function CreatePolicy() {
  const navigate = useNavigate();
  const now = useNow();
  const tx = useTx({ label: "Create policy" });
  const lock = useLock();
  const months = useMemo(() => nextMonths(6, now), [now]);
  const first = catalog.series[0] as Entry;
  const baseline = (c?: number) => Math.round((c ?? 0) / 100);
  const [slug, setSlug] = useState(first.slug);
  const [month, setMonth] = useState(months[0]);
  const [low, setLow] = useState(String(Math.round(baseline(first.october2026Cents) * 1.03)));
  const [high, setHigh] = useState(String(Math.round(baseline(first.october2026Cents) * 1.1)));
  const [premium, setPremium] = useState("10");
  const [capacity, setCapacity] = useState("100");
  const [accepted, setAccepted] = useState(false);
  const [touched, setTouched] = useState(false);

  const entry = neighborhood(slug) as Entry | undefined;
  const lowP = parseRentDollars(low, "starting rent");
  const highP = parseRentDollars(high, "full-payout rent");
  const premP = parsePremiumPercent(premium);
  const capP = parseAmount(capacity, CURRENCY_DECIMALS, "escrow");
  const obsMonth = Number(month.replace("-", ""));
  const { start, end } = monthBounds(obsMonth);
  const problems: string[] = [];
  if (!lowP.ok) problems.push(lowP.error);
  if (!highP.ok) problems.push(highP.error);
  if (lowP.ok && highP.ok && highP.value <= lowP.value) problems.push("The full-payout rent must be above the starting rent.");
  if (!premP.ok) problems.push(premP.error);
  if (!capP.ok) problems.push(capP.error);
  if (BigInt(start) <= now) problems.push("That month has already started, so sales could never open. Choose a later month.");
  const valid = problems.length === 0 && lowP.ok && highP.ok && premP.ok && capP.ok;
  const capacityWei = capP.ok ? capP.value : 0n;
  const finalizeAt = end + 1 + SUBMISSION_GRACE_SECONDS;
  const terms = { saleEnd: BigInt(start), finalizeAt: BigInt(finalizeAt), redeemEnd: BigInt(finalizeAt + DEFAULT_CLAIM_SECONDS), obsMonth };
  const funds = useWalletFunds(accepted && valid ? capacityWei : 0n);
  const busy = txBusy(tx.state);

  const step = !accepted ? (touched ? 2 : 1)
    : funds.stage === "connect" || funds.stage === "network" || funds.stage === "noGas" || funds.stage === "noFunds" ? 3
    : funds.stage === "approve" ? 4
    : tx.state.status === "confirmed" ? 5 : 4;

  function pick(next: string) {
    setSlug(next);
    const cents = (neighborhood(next) as Entry | undefined)?.october2026Cents;
    if (cents) {
      setLow(String(Math.round(baseline(cents) * 1.03)));
      setHigh(String(Math.round(baseline(cents) * 1.1)));
    }
  }

  async function create() {
    if (!valid || !lowP.ok || !highP.ok || !premP.ok) return;
    const result = await tx.send({
      abi: apartmentsPoolAbi, address: pool, chainId, account: funds.address, functionName: "createSeries",
      args: [slug, obsMonth, lowP.value, highP.value, premP.value, terms.saleEnd, terms.redeemEnd, capacityWei],
    }, txOpts);
    if (result.status !== "confirmed") {
      await funds.refetch();
      return;
    }
    for (const log of result.receipt?.logs ?? []) {
      try {
        const event = decodeEventLog({ abi: apartmentsPoolAbi, data: log.data, topics: log.topics as [`0x${string}`] });
        if (event.eventName === "SeriesCreated" && event.args) navigate(`/policies/${event.args.seriesId}`, { state: { created: true } });
      } catch {
        // not a pool event
      }
    }
  }

  if (!APARTMENTS_POOL) return <NotDeployed />;
  const example = lowP.ok && highP.ok && premP.ok ? buyExample(capacityWei, premP.value, lowP.value, highP.value) : undefined;
  const creator = premP.ok ? creatorExample(capacityWei, premP.value) : undefined;
  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12 min-w-0">
      <div>
        <p className="font-parkBody font-bold">For underwriters</p>
        <h1 className="font-parkHeading text-3xl sm:text-4xl mt-2">Create a rent policy</h1>
        <p className="font-parkBody text-sm mt-2">You put up the money renters can claim and earn a premium on every sale. <Link className="underline font-bold text-core-green" to="/policies/guide?tab=creator">Read the creator guide</Link> first if this is new to you.</p>
      </div>
      <Card><StepBar steps={CREATOR_STEPS} current={step} title="Create a policy" /></Card>
      <Card>
        <h2 className="font-parkHeading text-2xl mb-3">1. Terms</h2>
        <label className="block font-parkBody mb-4">
          Neighborhood page
          <select className={inputClass} value={slug} onChange={(e) => pick(e.target.value)} data-testid="policy-slug">
            {catalog.series.map((s) => <option key={s.slug} value={s.slug}>{s.geography}</option>)}
          </select>
        </label>
        <a className="underline font-parkBody text-sm break-all inline-flex min-h-11 items-center" href={pageUrl(slug)} target="_blank" rel="noreferrer">{pageUrl(slug)}</a>
        {entry?.october2026Cents && (
          <p className="font-parkBody text-sm mt-1">October 2026 headline rent from a received alert: {formatCents(entry.october2026Cents)}/mo</p>
        )}
        <label className="block font-parkBody my-4">
          Policy month
          <select className={inputClass} value={month} onChange={(e) => setMonth(e.target.value)} data-testid="policy-month">
            {months.map((m) => <option key={m} value={m}>{monthLabel(Number(m.replace("-", "")))}</option>)}
          </select>
          <span className="block font-parkBody text-xs text-surface-grey-2 mt-1">The first Google Alert signed during this month that names it sets the rent. Sales close when the month starts.</span>
        </label>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block font-parkBody">Payout starts above ($/mo)<input className={inputClass} inputMode="decimal" value={low} onChange={(e) => { setLow(e.target.value); setTouched(true); }} data-testid="policy-low" aria-invalid={!lowP.ok} /></label>
          <label className="block font-parkBody">Full payout at ($/mo)<input className={inputClass} inputMode="decimal" value={high} onChange={(e) => { setHigh(e.target.value); setTouched(true); }} data-testid="policy-high" aria-invalid={!highP.ok} /></label>
          <label className="block font-parkBody">Premium (% of max payout)<input className={inputClass} inputMode="decimal" value={premium} onChange={(e) => { setPremium(e.target.value); setTouched(true); }} data-testid="policy-premium" aria-invalid={!premP.ok} /></label>
          <label className="block font-parkBody">Your escrow ({symbol})<input className={inputClass} inputMode="decimal" value={capacity} onChange={(e) => { setCapacity(e.target.value); setTouched(true); }} data-testid="policy-capacity" aria-invalid={!capP.ok} /></label>
        </div>
        {problems.length > 0 && (
          <div className="mt-3"><Notice tone="error" testId="form-errors"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice></div>
        )}
      </Card>

      <Card>
        <h2 className="font-parkHeading text-2xl mb-3">2. What you are offering</h2>
        {example && creator && lowP.ok && highP.ok ? (
          <div className="space-y-3" data-testid="worked-example">
            <p className="font-parkBody text-sm leading-relaxed">
              Buyers pay <strong>{money(example.premium)}</strong> in total if all {money(capacityWei)} sells ({premium || 0}% of their maximum payout). Then, once the {monthLabel(obsMonth)} rent is recorded:
            </p>
            <ul className="font-parkBody text-sm list-disc pl-5 space-y-1 leading-relaxed">
              <li>Rent at or above <strong>{formatCents(highP.value)}</strong>: buyers claim the full {money(capacityWei)}.</li>
              <li>Rent of <strong>{formatCents(example.midCents)}</strong>: buyers claim {money(example.midPayout)}; the rest comes back to you.</li>
              <li>Rent at or below <strong>{formatCents(lowP.value)}</strong>: buyers claim $0; the whole escrow comes back to you.</li>
              <li>No qualifying email: the policy voids, buyers take their premiums back, you take the escrow back.</li>
            </ul>
            <StatRow label="Best case for you (rent stays low, all sold)" value={`+${money(creator.bestCase)}`} />
            <StatRow label="Worst case for you (rent reaches full payout, all sold)" value={creator.worstCase < 0n ? `−${money(-creator.worstCase)}` : `+${money(creator.worstCase)}`} />
            <p className="font-parkBody text-xs text-surface-grey-2">Premiums are yours in every outcome except a void. Nothing sold means nothing earned, and you can cancel to take the escrow back.</p>
          </div>
        ) : <p className="font-parkBody text-sm">Fix the terms above to see the worked example.</p>}
        <div className="mt-4">
          <h3 className="font-parkBody font-bold text-sm mb-2">Key dates for this policy</h3>
          <KeyDates series={terms} now={now} />
          <p className="font-parkBody text-xs text-surface-grey-2 mt-2">Times are UTC. Sales close {formatTimestamp(terms.saleEnd)}; your escrow is locked until claims close if anything sells.</p>
        </div>
      </Card>

      <Card>
        <h2 className="font-parkHeading text-2xl mb-3">3. Fund, approve and create</h2>
        <div className="space-y-3">
          <RiskNotice side="create" />
          <label className="flex gap-3 font-parkBody min-h-11 items-center">
            <input type="checkbox" className="h-5 w-5 shrink-0" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="policy-accept" />
            <span>I understand these terms never change, that I can lose the whole escrow, and that the contracts are unaudited.</span>
          </label>
          <WalletGate why={`to escrow ${symbol} on ${networkName}`}>
            {accepted && valid ? (
              <FundedAction need={capacityWei} funds={funds} what="your escrow">
                <Button
                  data-testid="policy-create"
                  disabled={busy || tx.state.status === "confirmed"}
                  isLoading={busy}
                  showChildrenWhenLoading
                  onClick={() => void lock(create)}
                >
                  {busy ? "Creating…" : `Create and escrow ${money(capacityWei)}`}
                </Button>
              </FundedAction>
            ) : (
              <p className="font-parkBody text-sm" data-testid="create-blocked">{!valid ? "Fix the terms above first." : "Tick the box above to continue."}</p>
            )}
          </WalletGate>
          <TxStatus state={tx.state} />
          <ActionFailureHint state={tx.state} />
          {tx.state.status === "confirmed" && <Notice tone="ok">Policy created. Opening it now so you can share the link.</Notice>}
        </div>
      </Card>
    </div>
  );
}
