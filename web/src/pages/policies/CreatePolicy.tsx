import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { decodeEventLog, formatUnits } from "viem";
import { Button, Chip } from "@decentralpark/ui";
import { ArrowSquareOutIcon, CaretDownIcon } from "@phosphor-icons/react";
import { APARTMENTS_POOL, CURRENCY_DECIMALS } from "../../chain/apartments";
import { apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { formatDate, formatTimestamp, nowSec } from "../../chain/format";
import { Card } from "../../components/States";
import { PayoutCurve } from "../../components/PayoutCurve";
import { TxStatus } from "../../components/TxStatus";
import { DEFAULT_CLAIM_SECONDS, SUBMISSION_GRACE_SECONDS, monthLabel } from "../../lib/googleAlert";
import {
  CREATOR_STEPS, TWO_DAYS, buyExample, creatorExample, defaultMonth, humanDelta, monthBoundsOf, monthOptions, pageUrl, parseAmount,
  parsePremiumPercent, parseRentDollars, premiumProblem,
} from "../../lib/policy";
import catalog from "../../data/apartments-series.json";
import {
  ActionFailureHint, FundedAction, KeyDates, NotDeployed, Notice, PrimaryLink, RiskNotice, StepBar, WalletGate, chainId, money,
  neighborhood, networkName, pool, symbol, txBusy, txOpts, useLock, useNow, usePolicyTx, useResumedTxs, useWalletFunds, type ReceiptLike,
} from "./shared";

type Entry = (typeof catalog.series)[number] & { october2026Cents?: number };

function createdId(logs: ReceiptLike["logs"]): bigint | undefined {
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: apartmentsPoolAbi, data: log.data, topics: log.topics as [`0x${string}`] });
      if (event.eventName === "SeriesCreated" && event.args) return (event.args as { seriesId: bigint }).seriesId;
    } catch {
      // not a pool event
    }
  }
  return undefined;
}

const RESUME_KEYS = ["create"];
const LOW_PRESETS = [0, 3, 5, 10];
const HIGH_PRESETS = [5, 10, 15, 20];
const PREMIUM_PRESETS = ["5", "10", "15", "20"];
const ESCROW_PRESETS = ["1", "10", "100", "1000"];

function rent(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** A strike in whole dollars, `pct` percent above a rent in cents. */
function strikeFrom(cents: number, pct: number) {
  return String(Math.round((cents * (100 + pct)) / 10_000));
}

function signedMoney(value: bigint) {
  return value < 0n ? `\u2212${money(-value)}` : `+${money(value)}`;
}

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <Card>
      <div className="flex items-start gap-3 mb-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-1 font-parkBody font-bold text-white"><span className="sr-only">Step </span>{n}</span>
        <div className="min-w-0">
          <h2 className="font-parkDisplay font-bold text-xl sm:text-2xl leading-tight">{title}</h2>
          {hint && <p className="font-parkBody text-sm text-surface-grey-2 mt-1">{hint}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

const fieldLabel = "block font-parkBody text-sm font-bold text-text-standard mb-1.5";

function SelectField({ label, value, onChange, testId, children }: {
  label: string; value: string; onChange: (next: string) => void; testId: string; children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className={fieldLabel}>{label}</span>
      <span className="relative block">
        <select
          className="w-full min-h-12 appearance-none rounded-xl border-2 border-paper-2 bg-paper-0 pl-3 pr-10 font-parkBody font-bold outline-none focus:border-core-green"
          value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}
        >
          {children}
        </select>
        <CaretDownIcon aria-hidden="true" size={18} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-surface-grey-2" />
      </span>
    </label>
  );
}

function AmountField({ label, value, onChange, valid, prefix, suffix, hint, testId, children }: {
  label: string; value: string; onChange: (next: string) => void; valid: boolean;
  prefix?: string; suffix?: string; hint?: string; testId: string; children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label className="block">
        <span className={fieldLabel}>{label}</span>
        <span className={`flex min-h-12 items-center gap-1.5 rounded-xl border-2 bg-paper-0 px-3 focus-within:border-core-green ${valid ? "border-paper-2" : "border-system-red"}`}>
          {prefix && <span aria-hidden="true" className="font-parkBody font-bold text-surface-grey-2">{prefix}</span>}
          <input
            className="min-h-11 w-full min-w-0 bg-transparent font-parkBody text-lg font-bold outline-none"
            inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} aria-invalid={!valid}
          />
          {suffix && <span aria-hidden="true" className="font-parkBody text-sm text-surface-grey-2 whitespace-nowrap">{suffix}</span>}
        </span>
      </label>
      {hint && <p className="font-parkBody text-xs text-surface-grey-2 mt-1.5">{hint}</p>}
      {children && <div className="flex flex-wrap gap-1.5 mt-2">{children}</div>}
    </div>
  );
}

function Preset({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" aria-label={label} aria-pressed={active} onClick={onClick}
      className={`min-h-11 min-w-11 rounded-full border-2 px-3 font-parkBody text-sm font-bold transition-colors ${active ? "border-core-green bg-paper-1 text-green-1" : "border-paper-2 bg-paper-0 text-surface-grey-2 hover:border-core-green"}`}
    >
      {children}
    </button>
  );
}

function Outcome({ title, rentLine, value, tone, note }: { title: string; rentLine: string; value: string; tone: "good" | "mid" | "bad"; note: string }) {
  const color = tone === "good" ? "text-green-1" : tone === "bad" ? "text-system-red" : "text-text-standard";
  return (
    <div className="min-w-0 rounded-xl border-2 border-paper-2 bg-paper-main p-4">
      <p className="font-parkBody text-sm font-bold">{title}</p>
      <p className="font-parkBody text-xs text-surface-grey-2 mt-0.5">{rentLine}</p>
      <p className={`font-parkDisplay font-bold text-2xl mt-3 break-words ${color}`}>{value}</p>
      <p className="font-parkBody text-xs text-surface-grey-2 mt-1 leading-relaxed">{note}</p>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-paper-1 last:border-b-0">
      <span className="font-parkBody text-sm text-surface-grey-2">{label}</span>
      <span className="font-parkBody text-sm font-bold text-right">{value}</span>
    </div>
  );
}

export function CreatePolicy() {
  const navigate = useNavigate();
  const now = useNow();
  const tx = usePolicyTx({ label: "Create policy", key: "create" });
  const lock = useLock();
  const options = useMemo(() => monthOptions(now), [now]);
  const first = catalog.series[0] as Entry;
  const [slug, setSlug] = useState(first.slug);
  const [month, setMonth] = useState(() => defaultMonth(monthOptions(nowSec())));
  const [low, setLow] = useState(strikeFrom(first.october2026Cents ?? 0, 3));
  const [high, setHigh] = useState(strikeFrom(first.october2026Cents ?? 0, 10));
  const [premium, setPremium] = useState("10");
  const [capacity, setCapacity] = useState("100");
  const [accepted, setAccepted] = useState(false);
  const [touched, setTouched] = useState(false);
  const resumed = useResumedTxs(RESUME_KEYS, (_key, status, receipt) => {
    const created = status === "confirmed" && receipt ? createdId(receipt.logs) : undefined;
    if (created !== undefined) navigate(`/policies/${created}`);
  });

  // The month list rolls over as time passes: never leave a month selected
  // that the dropdown no longer offers.
  useEffect(() => {
    if (!options.some((o) => o.value === month)) setMonth(defaultMonth(options));
  }, [options, month]);

  const entry = neighborhood(slug) as Entry | undefined;
  const lowP = parseRentDollars(low, "starting rent");
  const highP = parseRentDollars(high, "full-payout rent");
  const premP = parsePremiumPercent(premium);
  const capP = parseAmount(capacity, CURRENCY_DECIMALS, "escrow");
  const selected = options.find((o) => o.value === month) ?? options[0];
  const obsMonth = selected.yyyymm;
  const { start, end } = monthBoundsOf(obsMonth);
  const problems: string[] = [];
  if (!lowP.ok) problems.push(lowP.error);
  if (!highP.ok) problems.push(highP.error);
  if (lowP.ok && highP.ok && highP.value <= lowP.value) problems.push("The full-payout rent must be above the starting rent.");
  if (!premP.ok) problems.push(premP.error);
  if (!capP.ok) problems.push(capP.error);
  if (premP.ok && capP.ok) {
    const rounding = premiumProblem(capP.value, premP.value);
    if (rounding) problems.push(rounding);
  }
  if (start <= now) problems.push("That month has already started, so sales could never open. Choose a later month.");
  const valid = problems.length === 0 && lowP.ok && highP.ok && premP.ok && capP.ok;
  const capacityWei = capP.ok ? capP.value : 0n;
  const premiumPct = premP.ok ? premP.value / 100 : 0;
  const finalizeAt = end + 1n + BigInt(SUBMISSION_GRACE_SECONDS);
  const terms = { saleEnd: start, finalizeAt, redeemEnd: finalizeAt + BigInt(DEFAULT_CLAIM_SECONDS), obsMonth };
  const funds = useWalletFunds(valid ? capacityWei : 0n);
  const busy = txBusy(tx.state) || resumed.busy;
  const shortSale = selected.salesLeft < TWO_DAYS;

  const current = !accepted ? (touched ? 2 : 1)
    : funds.stage === "connect" || funds.stage === "network" || funds.stage === "noGas" || funds.stage === "noFunds" ? 3
    : tx.state.status === "confirmed" ? 5 : 4;

  function pick(next: string) {
    setSlug(next);
    const cents = (neighborhood(next) as Entry | undefined)?.october2026Cents;
    setLow(cents ? strikeFrom(cents, 3) : "");
    setHigh(cents ? strikeFrom(cents, 10) : "");
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
    const created = createdId(result.receipt.logs);
    if (created !== undefined) navigate(`/policies/${created}`, { state: { created: true } });
  }

  if (!APARTMENTS_POOL) return <NotDeployed />;
  const example = lowP.ok && highP.ok && premP.ok ? buyExample(capacityWei, premP.value, lowP.value, highP.value) : undefined;
  const creator = premP.ok ? creatorExample(capacityWei, premP.value) : undefined;
  const october = entry?.october2026Cents;
  const edit = (set: (next: string) => void) => (next: string) => { set(next); setTouched(true); };
  const fromOctober = (cents: number | undefined) => {
    if (!october || !cents) return undefined;
    const pct = (cents / october - 1) * 100;
    return `${Math.abs(pct).toFixed(1)}% ${pct < 0 ? "below" : "above"} the October rent`;
  };
  const strike = (pct: number) => strikeFrom(october ?? 0, pct);
  const lowCents = lowP.ok ? lowP.value : undefined;
  const highCents = highP.ok ? highP.value : undefined;
  return (
    <div className="space-y-6 pb-12 min-w-0">
      <header className="max-w-3xl">
        <div className="flex"><Chip size="small">For underwriters</Chip></div>
        <h1 className="font-parkDisplay font-bold text-4xl sm:text-5xl tracking-tight mt-3">Create a rent policy</h1>
        <p className="font-parkBody text-surface-grey-2 mt-3">
          Put up the money renters can claim, and earn a premium on every sale. <PrimaryLink to="/policies/guide?tab=creator">Read the creator guide</PrimaryLink>
        </p>
      </header>
      {resumed.node}
      <Card><StepBar steps={CREATOR_STEPS} view={{ current }} title="Create a policy" /></Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="min-w-0 space-y-6">
          <Section n={1} title="Pick a neighborhood and month" hint="The first Google Alert signed during the month sets the rent.">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Neighborhood" value={slug} onChange={pick} testId="policy-slug">
                {catalog.series.map((s) => <option key={s.slug} value={s.slug}>{s.geography}</option>)}
              </SelectField>
              <SelectField label="Policy month" value={month} onChange={setMonth} testId="policy-month">
                {options.map((m) => <option key={m.value} value={m.value}>{monthLabel(m.yyyymm)}</option>)}
              </SelectField>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl bg-paper-main border-2 border-paper-1 px-4 py-3">
              <div className="min-w-0">
                <p className="font-parkBody text-xs text-surface-grey-2">{october ? "October 2026 headline rent" : "Headline rent"}</p>
                <p className="font-parkDisplay font-bold text-2xl">{october ? <>{rent(october)}<span className="font-parkBody text-sm font-normal text-surface-grey-2">/mo</span></> : "Not received yet"}</p>
              </div>
              <a className="inline-flex min-h-11 items-center gap-1.5 font-parkBody text-sm font-bold text-green-1 underline" href={pageUrl(slug)} target="_blank" rel="noreferrer">
                View on Apartments.com<ArrowSquareOutIcon aria-hidden="true" size={16} />
              </a>
            </div>
            <p className="font-parkBody text-xs text-surface-grey-2 mt-2">Sales close when the month starts: {formatTimestamp(selected.start)} ({humanDelta(selected.start, now)}).</p>
            {shortSale && (
              <div className="mt-3">
                <Notice tone="warn" testId="short-sale-warning">
                  Sales for {monthLabel(obsMonth)} close {humanDelta(selected.start, now)}. Few people may be able to buy before then; a later month gives the policy time to sell.
                </Notice>
              </div>
            )}
          </Section>

          <Section n={2} title="Set the payout and your price" hint="Buyers are paid more the higher the rent climbs between these two figures.">
            <div className="grid gap-5 sm:grid-cols-2">
              <AmountField label="Payout starts above" value={low} onChange={edit(setLow)} valid={lowP.ok} prefix="$" suffix="/mo" hint={fromOctober(lowCents)} testId="policy-low">
                {october && LOW_PRESETS.map((pct) => (
                  <Preset key={pct} active={low === strike(pct)} label={`+${pct}%: start payouts ${pct}% above the October rent`} onClick={() => edit(setLow)(strike(pct))}>+{pct}%</Preset>
                ))}
              </AmountField>
              <AmountField label="Full payout at" value={high} onChange={edit(setHigh)} valid={highP.ok} prefix="$" suffix="/mo" hint={fromOctober(highCents)} testId="policy-high">
                {october && HIGH_PRESETS.map((pct) => (
                  <Preset key={pct} active={high === strike(pct)} label={`+${pct}%: reach full payout ${pct}% above the October rent`} onClick={() => edit(setHigh)(strike(pct))}>+{pct}%</Preset>
                ))}
              </AmountField>
            </div>
            {lowCents !== undefined && highCents !== undefined && highCents > lowCents && (
              <div className="mt-5 rounded-xl border-2 border-paper-1 bg-paper-main p-3" data-testid="payout-preview">
                <p className="font-parkBody text-sm font-bold mb-1">What each claim pays</p>
                <PayoutCurve lowCents={lowCents} highCents={highCents} width={420} caption="Apartments.com headline rent, $ per month" />
              </div>
            )}
            <div className="grid gap-5 sm:grid-cols-2 mt-5">
              <AmountField label="Premium" value={premium} onChange={edit(setPremium)} valid={premP.ok} suffix="% of max payout" testId="policy-premium">
                {PREMIUM_PRESETS.map((v) => <Preset key={v} active={premium === v} label={`Set premium to ${v}%`} onClick={() => edit(setPremium)(v)}>{v}%</Preset>)}
              </AmountField>
              <AmountField label="Your escrow" value={capacity} onChange={edit(setCapacity)} valid={capP.ok} suffix={symbol} testId="policy-capacity">
                {ESCROW_PRESETS.map((v) => <Preset key={v} active={capacity === v} label={`Set escrow to ${v} ${symbol}`} onClick={() => edit(setCapacity)(v)}>${Number(v).toLocaleString("en-US")}</Preset>)}
              </AmountField>
            </div>
            {problems.length > 0 && (
              <div className="mt-4"><Notice tone="error" testId="form-errors"><ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul></Notice></div>
            )}
          </Section>

          <Section n={3} title="See what could happen" hint={`If all ${capP.ok ? money(capacityWei) : "of your escrow"} sells, once the ${monthLabel(obsMonth)} rent is recorded.`}>
            {example && creator && lowP.ok && highP.ok && premP.ok ? (
              <div className="space-y-4" data-testid="worked-example">
                {premP.value === 0 ? (
                  <Notice tone="warn" testId="zero-premium">
                    Premium is <strong>0%</strong>: buyers pay nothing and you earn nothing. You would be giving away up to {money(capacityWei)} of protection for free and only take on the risk.
                  </Notice>
                ) : (
                  <p className="font-parkBody text-sm">
                    Buyers pay you <strong>{money(example.premium)}</strong> in total ({premiumPct}% of their maximum payout).
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Outcome title="Best case for you" rentLine={`Rent at or below ${rent(lowP.value)}`} value={signedMoney(creator.bestCase)} tone={creator.bestCase > 0n ? "good" : "mid"} note="Buyers claim $0. Your whole escrow comes back." />
                  <Outcome title="In between" rentLine={`Rent of ${rent(example.midCents)}`} value={signedMoney(example.premium - example.midPayout)} tone={example.premium < example.midPayout ? "bad" : example.premium > example.midPayout ? "good" : "mid"} note={`Buyers claim ${money(example.midPayout)}. The rest comes back to you.`} />
                  <Outcome title="Worst case for you" rentLine={`Rent at or above ${rent(highP.value)}`} value={signedMoney(creator.worstCase)} tone={creator.worstCase < 0n ? "bad" : "mid"} note={`Buyers claim the full ${money(capacityWei)}.`} />
                </div>
                <p className="font-parkBody text-sm rounded-xl border-2 border-paper-1 px-4 py-3">
                  <strong>No qualifying email:</strong> the policy voids. Buyers take their premiums back and you take your escrow back.
                </p>
                <p className="font-parkBody text-xs text-surface-grey-2">Nothing sold means nothing earned, and you can cancel to take the escrow back.</p>
              </div>
            ) : <p className="font-parkBody text-sm">Fix the terms above to see what could happen.</p>}
            <div className="mt-6">
              <h3 className="font-parkBody font-bold text-sm mb-3">Key dates</h3>
              <KeyDates series={terms} now={now} />
              <p className="font-parkBody text-xs text-surface-grey-2 mt-3">Times are UTC. Your escrow is locked until claims close if anything sells.</p>
            </div>
          </Section>

          <Section n={4} title="Read this before you escrow">
            <RiskNotice side="create" />
          </Section>
        </div>

        <aside aria-label="Your policy" className="min-w-0 lg:sticky lg:top-6">
          <div className="overflow-hidden rounded-2xl border-2 border-core-green bg-paper-0">
            <div className="bg-green-1 px-5 py-4 text-white">
              <p className="font-parkBody text-xs font-bold">Your policy</p>
              <p className="font-parkDisplay font-bold text-2xl leading-tight mt-0.5 break-words">{entry?.geography ?? slug}</p>
              <p className="font-parkBody text-sm">{monthLabel(obsMonth)}</p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <SummaryRow label="You escrow" value={capP.ok ? money(capacityWei) : "\u2014"} />
                <SummaryRow label="You can earn" value={<span className="text-green-1">{creator ? signedMoney(creator.bestCase) : "\u2014"}</span>} />
                <SummaryRow label="You can lose" value={<span className="text-system-red">{creator ? money(creator.worstCase < 0n ? -creator.worstCase : 0n) : "\u2014"}</span>} />
                <SummaryRow label="Payout range" value={lowCents && highCents ? `${rent(lowCents)} to ${rent(highCents)}` : "\u2014"} />
                <SummaryRow label="Claims close" value={formatDate(terms.redeemEnd)} />
                {funds.balance !== undefined && <SummaryRow label="In your wallet" value={<span data-testid="wallet-balance">{money(funds.balance)}</span>} />}
              </div>
              {funds.stage === "noFunds" && (funds.balance ?? 0n) > 0n && (
                <Notice tone="warn" testId="escrow-over-balance">
                  {!accepted && <p>Your escrow is more than this wallet holds.</p>}
                  <button
                    type="button" className="min-h-11 font-bold underline" data-testid="use-balance"
                    onClick={() => edit(setCapacity)(formatUnits(funds.balance ?? 0n, CURRENCY_DECIMALS))}
                  >
                    Use my full balance
                  </button>
                </Notice>
              )}
              <label className="flex gap-3 font-parkBody text-sm min-h-11 items-start">
                <input type="checkbox" className="h-5 w-5 mt-0.5 shrink-0 accent-core-green" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="policy-accept" />
                <span>I understand these terms never change, that I can lose the whole escrow, and that the contracts are unaudited.</span>
              </label>
              <WalletGate why={`to escrow ${symbol} on ${networkName}`}>
                {accepted && valid ? (
                  <FundedAction need={capacityWei} funds={funds} what="your escrow">
                    <Button
                      data-testid="policy-create"
                      disabled={busy || tx.state.status === "confirmed"}
                      isLoading={txBusy(tx.state)}
                      showChildrenWhenLoading
                      onClick={() => void lock(create)}
                    >
                      {txBusy(tx.state) ? "Creating\u2026" : `Create and escrow ${money(capacityWei)}`}
                    </Button>
                  </FundedAction>
                ) : (
                  <p className="font-parkBody text-sm text-surface-grey-2" data-testid="create-blocked">{!valid ? "Fix the terms first." : "Tick the box above to continue."}</p>
                )}
              </WalletGate>
              <TxStatus state={tx.state} />
              <ActionFailureHint state={tx.state} />
              {tx.state.status === "confirmed" && <Notice tone="ok">Policy created. Opening it now so you can share the link.</Notice>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
