import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { decodeEventLog, type Address } from "viem";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Button } from "@decentralpark/ui";
import {
  APARTMENTS_CHAIN_ID,
  APARTMENTS_ORACLE,
  APARTMENTS_POOL,
  APARTMENTS_TOKEN,
  CURRENCY_DECIMALS,
  WRAPPED_NATIVE,
  claimTokenAbi,
  wrappedNativeAbi,
} from "../chain/apartments";
import { apartmentsOracleAbi, apartmentsPoolAbi } from "../chain/apartmentsAbi";
import { DEPLOYMENTS } from "../chain/registry";
import { formatCents, formatCurrency, formatDate, formatTimestamp, nowSec, parseCurrency, truncateAddress } from "../chain/format";
import { useTx } from "../chain/useTx";
import { Card, EmptyState, LoadingSkeleton, StatRow } from "../components/States";
import { TxStatus } from "../components/TxStatus";
import { parseEmailBytes, toHex } from "../emailkit/bridge";
import {
  extractAlertResults,
  monthLabel,
  payoutFraction,
  policyTerms,
  publishedRecipient,
  type AlertResult,
} from "../lib/googleAlert";
import catalog from "../data/apartments-series.json";

const WAD = 10n ** 18n;
const pool = APARTMENTS_POOL as Address;
const chainId = APARTMENTS_CHAIN_ID;
const symbol = DEPLOYMENTS[chainId]?.currency.symbol ?? "";
const inputClass =
  "w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0";

interface SeriesRow {
  creator: Address;
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  obsMonth: number;
  settled: boolean;
  voided: boolean;
  cancelled: boolean;
  residualWithdrawn: boolean;
  saleEnd: bigint;
  finalizeAt: bigint;
  redeemEnd: bigint;
  payoutRatioWad: bigint;
  observationT: bigint;
  escrow: bigint;
  sold: bigint;
  premiumsAccrued: bigint;
  paidOut: bigint;
  slugHash: `0x${string}`;
  emailId: `0x${string}`;
}

function neighborhood(slug: string) {
  return catalog.series.find((s) => s.slug === slug);
}

function pageUrl(slug: string) {
  return `https://www.apartments.com/rent-market-trends/${slug}/`;
}

function money(wei: bigint) {
  return formatCurrency(wei, { decimals: CURRENCY_DECIMALS, symbol });
}

function statusOf(s: SeriesRow, now: bigint) {
  if (s.cancelled) return "Cancelled";
  if (s.settled) return "Settled";
  if (s.voided) return "Void: premiums refundable";
  if (now < s.saleEnd) return "On sale";
  if (now > s.redeemEnd) return "Claims closed";
  if (now >= s.finalizeAt) return "Ready to finalize";
  return "Awaiting rent data";
}

function NotDeployed() {
  return <EmptyState title="Not deployed yet">Residential policies open once the contracts are live.</EmptyState>;
}

function WalletGate({ children }: { children: React.ReactNode }) {
  const account = useAccount();
  const { openConnectModal } = useConnectModal();
  if (!account.address) return <Button onClick={() => openConnectModal?.()}>Connect wallet</Button>;
  if (account.chainId !== chainId) {
    return <p className="font-parkBody text-sm">Switch your wallet to {DEPLOYMENTS[chainId]?.name} using the header.</p>;
  }
  return <>{children}</>;
}

/** Wraps and approves as needed, then shows `children` once `need` is spendable. */
function FundedAction({ need, children }: { need: bigint; children: React.ReactNode }) {
  const { address } = useAccount();
  const wrap = useTx({ label: `Wrap ${symbol}` });
  const approve = useTx({ label: `Approve ${symbol}` });
  const native = useBalance({ address, chainId });
  const balance = useReadContract({
    address: WRAPPED_NATIVE, abi: wrappedNativeAbi, chainId, functionName: "balanceOf", args: address ? [address] : undefined,
  });
  const allowance = useReadContract({
    address: WRAPPED_NATIVE, abi: wrappedNativeAbi, chainId, functionName: "allowance", args: address ? [address, pool] : undefined,
  });
  const shortfall = need - (balance.data ?? 0n);
  if (need === 0n) return <>{children}</>;
  if (balance.data === undefined || allowance.data === undefined) return <LoadingSkeleton lines={1} />;
  if (shortfall > 0n) {
    const enough = (native.data?.value ?? 0n) >= shortfall;
    return (
      <div className="space-y-2">
        <p className="font-parkBody text-sm">You need {money(shortfall)} more wrapped balance.</p>
        <Button
          disabled={!enough}
          onClick={async () => {
            await wrap.send({ abi: wrappedNativeAbi, address: WRAPPED_NATIVE, chainId, functionName: "deposit", value: shortfall, account: address });
            await balance.refetch();
          }}
        >
          {enough ? "Wrap funds" : "Insufficient balance"}
        </Button>
        <TxStatus state={wrap.state} />
      </div>
    );
  }
  if (allowance.data < need) {
    return (
      <div className="space-y-2">
        <Button
          onClick={async () => {
            await approve.send({ abi: wrappedNativeAbi, address: WRAPPED_NATIVE, chainId, functionName: "approve", args: [pool, need], account: address });
            await allowance.refetch();
          }}
        >
          Approve {money(need)}
        </Button>
        <TxStatus state={approve.state} />
      </div>
    );
  }
  return <>{children}</>;
}

function useSeries(id: bigint) {
  const read = useReadContracts({
    contracts: [
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "series", args: [id] },
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesSlug", args: [id] },
    ],
    query: { enabled: Boolean(APARTMENTS_POOL) },
  });
  const series = read.data?.[0]?.result as unknown as SeriesRow | undefined;
  const slug = read.data?.[1]?.result as string | undefined;
  return { series, slug, refetch: read.refetch, isLoading: read.isLoading };
}

// ─────────────────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────────────────

export function PolicyList() {
  const count = useReadContract({
    address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesCount", query: { enabled: Boolean(APARTMENTS_POOL) },
  });
  const ids = useMemo(() => Array.from({ length: Number(count.data ?? 0n) }, (_, i) => BigInt(i)).reverse(), [count.data]);
  const rows = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "series", args: [id] } as const,
      { address: pool, abi: apartmentsPoolAbi, chainId, functionName: "seriesSlug", args: [id] } as const,
    ]),
    query: { enabled: ids.length > 0 },
  });
  if (!APARTMENTS_POOL) return <NotDeployed />;
  const now = nowSec();
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div>
        <p className="font-parkBody font-bold">Permissionless residential protection</p>
        <h1 className="font-parkHeading text-4xl mt-2">Neighborhood rent policies</h1>
        <p className="font-parkBody mt-4">
          Anyone can open a policy on an Apartments.com neighborhood page: name a premium, escrow the full payout, and let
          others buy protection. The headline rent in a Google-signed alert for that month decides the payout.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/policies/new"><Button>Create a policy</Button></Link>
        <Link to="/policies/submit"><Button variant="secondary">Submit a Google Alert</Button></Link>
      </div>
      <Card>
        <p className="font-parkBody text-sm">
          These contracts are unaudited, ownerless and cannot be changed. Only use money you can afford to lose. A policy that
          receives no qualifying email voids: buyers get their premium back and the creator gets the escrow back.
        </p>
      </Card>
      {count.isLoading ? <LoadingSkeleton lines={3} /> : ids.length === 0 ? (
        <EmptyState title="No policies yet">Be the first to create one.</EmptyState>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {ids.map((id, i) => {
            const series = rows.data?.[i * 2]?.result as unknown as SeriesRow | undefined;
            const slug = rows.data?.[i * 2 + 1]?.result as string | undefined;
            if (!series || !slug) return <Card key={String(id)}><LoadingSkeleton lines={2} /></Card>;
            return (
              <Link key={String(id)} to={`/policies/${id}`} data-testid={`policy-${id}`}>
                <Card className="hover:border-core-green h-full">
                  <p className="font-parkHeading text-xl">{neighborhood(slug)?.geography ?? slug}</p>
                  <p className="font-parkBody text-sm mb-2">{monthLabel(series.obsMonth)} · {statusOf(series, now)}</p>
                  <StatRow label="Pays from" value={`${formatCents(series.strikeLowCents)}/mo`} />
                  <StatRow label="Full payout at" value={`${formatCents(series.strikeHighCents)}/mo`} />
                  <StatRow label="Premium" value={`${series.premiumRateBps / 100}%`} />
                  <StatRow label="Available" value={money(series.escrow - series.sold)} />
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

function nextMonths(count: number) {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function CreatePolicy() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const tx = useTx({ label: "Create policy" });
  const months = useMemo(() => nextMonths(6), []);
  const first = catalog.series[0] as (typeof catalog.series)[number] & { october2026Cents?: number };
  const baseline = (c?: number) => Math.round((c ?? 0) / 100);
  const [slug, setSlug] = useState(first.slug);
  const [month, setMonth] = useState(months[0]);
  const [low, setLow] = useState(String(Math.round(baseline(first.october2026Cents) * 1.03)));
  const [high, setHigh] = useState(String(Math.round(baseline(first.october2026Cents) * 1.1)));
  const [premium, setPremium] = useState("10");
  const [capacity, setCapacity] = useState("100");
  const [accepted, setAccepted] = useState(false);

  const entry = neighborhood(slug) as (typeof first) | undefined;
  const terms = policyTerms(
    { slug, month, lowDollars: Number(low), highDollars: Number(high), premiumPercent: Number(premium) },
    Number(nowSec()),
  );
  const capacityWei = parseCurrency(capacity, CURRENCY_DECIMALS) ?? 0n;
  const invalid = typeof terms === "string" ? terms : capacityWei === 0n ? "Enter an escrow amount." : "";

  function pick(next: string) {
    setSlug(next);
    const cents = (neighborhood(next) as typeof first | undefined)?.october2026Cents;
    if (cents) {
      setLow(String(Math.round(baseline(cents) * 1.03)));
      setHigh(String(Math.round(baseline(cents) * 1.1)));
    }
  }

  async function create() {
    if (typeof terms === "string") return;
    const result = await tx.send({
      abi: apartmentsPoolAbi,
      address: pool,
      chainId,
      account: address,
      functionName: "createSeries",
      args: [slug, terms.obsMonth, terms.strikeLowCents, terms.strikeHighCents, terms.premiumRateBps, terms.saleEnd, terms.redeemEnd, capacityWei],
    });
    if (result.status !== "confirmed") return;
    for (const log of result.receipt?.logs ?? []) {
      try {
        const event = decodeEventLog({ abi: apartmentsPoolAbi, data: log.data, topics: log.topics as [`0x${string}`] });
        if (event.eventName === "SeriesCreated" && event.args) navigate(`/policies/${event.args.seriesId}`);
      } catch {
        // not a pool event
      }
    }
  }

  if (!APARTMENTS_POOL) return <NotDeployed />;
  const low$ = Number(low);
  const high$ = Number(high);
  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <h1 className="font-parkHeading text-4xl">Create a rent policy</h1>
      <Card>
        <label className="block font-parkBody mb-4">
          Neighborhood
          <select className={inputClass} value={slug} onChange={(e) => pick(e.target.value)} data-testid="policy-slug">
            {catalog.series.map((s) => <option key={s.slug} value={s.slug}>{s.geography}</option>)}
          </select>
        </label>
        <a className="underline font-parkBody text-sm" href={pageUrl(slug)} target="_blank" rel="noreferrer">Apartments.com source page</a>
        {entry?.october2026Cents && (
          <p className="font-parkBody text-sm mt-1">October 2026 headline rent from a received alert: {formatCents(entry.october2026Cents)}/mo</p>
        )}
        <label className="block font-parkBody my-4">
          Policy month
          <select className={inputClass} value={month} onChange={(e) => setMonth(e.target.value)} data-testid="policy-month">
            {months.map((m) => <option key={m} value={m}>{monthLabel(Number(m.replace("-", "")))}</option>)}
          </select>
        </label>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block font-parkBody">Payout starts above ($/mo)<input className={inputClass} inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value)} data-testid="policy-low" /></label>
          <label className="block font-parkBody">Full payout at ($/mo)<input className={inputClass} inputMode="numeric" value={high} onChange={(e) => setHigh(e.target.value)} data-testid="policy-high" /></label>
          <label className="block font-parkBody">Premium (% of max payout)<input className={inputClass} inputMode="decimal" value={premium} onChange={(e) => setPremium(e.target.value)} data-testid="policy-premium" /></label>
          <label className="block font-parkBody">Your escrow ({symbol})<input className={inputClass} inputMode="decimal" value={capacity} onChange={(e) => setCapacity(e.target.value)} data-testid="policy-capacity" /></label>
        </div>
        {typeof terms !== "string" && (
          <div className="mt-4">
            <StatRow label="Sales close" value={formatTimestamp(terms.saleEnd)} />
            <StatRow label="Finalizes from" value={formatTimestamp(terms.finalizeAt)} />
            <StatRow label="Claims close, unclaimed funds return to you" value={formatTimestamp(terms.redeemEnd)} />
            <StatRow label={`Rent of ${formatCents(Math.round(((low$ + high$) / 2) * 100))}/mo pays`} value={`${(payoutFraction((low$ + high$) / 2, low$, high$) * 100).toFixed(0)}% of each claim`} />
          </div>
        )}
        <p className="font-parkBody text-sm mt-4">
          The first Google-signed alert for this page dated inside the policy month sets the rent. With none, buyers get
          premiums back and your escrow returns. Terms never change, and your escrow is locked until claims close if anything
          sells. These contracts are unaudited.
        </p>
        <label className="flex gap-3 my-4 font-parkBody">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-testid="policy-accept" />
          I reviewed these immutable terms and accept the risk of loss.
        </label>
        {invalid && <p className="font-parkBody text-sm mb-3" role="alert">{invalid}</p>}
        <WalletGate>
          {accepted && !invalid ? (
            <FundedAction need={capacityWei}>
              <Button onClick={() => void create()} data-testid="policy-create">Create and escrow {money(capacityWei)}</Button>
            </FundedAction>
          ) : <Button disabled>Create policy</Button>}
        </WalletGate>
        <div className="mt-3"><TxStatus state={tx.state} /></div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────────────────────

export function PolicyDetail() {
  const params = useParams();
  const id = BigInt(params.id ?? "0");
  const { address } = useAccount();
  const { series, slug, refetch, isLoading } = useSeries(id);
  const claims = useReadContract({
    address: APARTMENTS_TOKEN as Address, abi: claimTokenAbi, chainId, functionName: "balanceOf",
    args: address ? [address, id] : undefined, query: { enabled: Boolean(APARTMENTS_TOKEN && address) },
  });
  const earliest = useReadContract({
    address: APARTMENTS_ORACLE as Address, abi: apartmentsOracleAbi, chainId, functionName: "earliest",
    args: series ? [series.slugHash, series.obsMonth] : undefined, query: { enabled: Boolean(series && APARTMENTS_ORACLE) },
  });
  const [amount, setAmount] = useState("10");
  const buy = useTx({ label: "Buy protection" });
  const action = useTx({ label: "Policy action" });

  if (!APARTMENTS_POOL) return <NotDeployed />;
  if (isLoading) return <LoadingSkeleton lines={4} />;
  if (!series || !slug) return <EmptyState title="Policy not found">This policy does not exist.</EmptyState>;

  const now = nowSec();
  const entry = neighborhood(slug);
  const maxClaim = parseCurrency(amount, CURRENCY_DECIMALS) ?? 0n;
  const premium = (maxClaim * BigInt(series.premiumRateBps)) / 10_000n;
  const onSale = !series.cancelled && now < series.saleEnd;
  const held = claims.data ?? 0n;
  const finalized = series.settled || series.voided;
  const claimable = now >= series.finalizeAt && now <= series.redeemEnd && !series.cancelled;
  const isCreator = address?.toLowerCase() === series.creator.toLowerCase();
  const observed = earliest.data && earliest.data[0] !== 0n ? earliest.data : undefined;
  const payoutPreview = series.voided
    ? (held * BigInt(series.premiumRateBps)) / 10_000n
    : (held * series.payoutRatioWad) / WAD;

  const run = async (functionName: string, args: readonly unknown[]) => {
    await action.send({ abi: apartmentsPoolAbi, address: pool, chainId, account: address, functionName, args });
    await Promise.all([refetch(), claims.refetch()]);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <div>
        <p className="font-parkBody font-bold">Policy #{String(id)} · {statusOf(series, now)}</p>
        <h1 className="font-parkHeading text-4xl mt-2">{entry?.geography ?? slug}, {monthLabel(series.obsMonth)}</h1>
        <a className="underline font-parkBody text-sm" href={pageUrl(slug)} target="_blank" rel="noreferrer">Apartments.com source page</a>
        {!entry && <p className="font-parkBody text-sm mt-2" role="alert">This page is not in the curated list. Check that it is the neighborhood you expect before buying.</p>}
      </div>
      <Card>
        <StatRow label="Payout starts above" value={`${formatCents(series.strikeLowCents)}/mo`} />
        <StatRow label="Full payout at" value={`${formatCents(series.strikeHighCents)}/mo`} />
        <StatRow label="Premium" value={`${series.premiumRateBps / 100}% of max payout`} />
        <StatRow label="Escrowed" value={money(series.escrow)} />
        <StatRow label="Sold" value={money(series.sold)} />
        <StatRow label="Sales close" value={formatTimestamp(series.saleEnd)} />
        <StatRow label="Finalizes from" value={formatTimestamp(series.finalizeAt)} />
        <StatRow label="Claims close" value={formatDate(series.redeemEnd)} />
        <StatRow label="Creator" value={truncateAddress(series.creator)} mono />
        {observed && <StatRow label="Earliest signed rent so far" value={`${formatCents(observed[1])}/mo`} />}
        {series.settled && <StatRow label="Final payout" value={`${Number((series.payoutRatioWad * 10_000n) / WAD) / 100}% of each claim`} />}
      </Card>

      {onSale && (
        <Card>
          <h2 className="font-parkHeading text-2xl mb-3">Buy protection</h2>
          <label className="block font-parkBody mb-3">Max payout ({symbol})<input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="buy-amount" /></label>
          <StatRow label="You pay" value={money(premium)} />
          <StatRow label="Available" value={money(series.escrow - series.sold)} />
          <p className="font-parkBody text-sm my-3">
            Claims cannot be transferred. If rent stays at or below {formatCents(series.strikeLowCents)} you receive nothing. If
            no qualifying email exists, your premium comes back. You must claim before {formatDate(series.redeemEnd)}.
          </p>
          <WalletGate>
            <FundedAction need={premium}>
              <Button
                disabled={maxClaim === 0n}
                data-testid="buy-submit"
                onClick={async () => {
                  await buy.send({ abi: apartmentsPoolAbi, address: pool, chainId, account: address, functionName: "buyProtection", args: [id, maxClaim, premium] });
                  await Promise.all([refetch(), claims.refetch()]);
                }}
              >
                Buy for {money(premium)}
              </Button>
            </FundedAction>
          </WalletGate>
          <div className="mt-3"><TxStatus state={buy.state} /></div>
        </Card>
      )}

      {held > 0n && (
        <Card>
          <h2 className="font-parkHeading text-2xl mb-2">Your claim</h2>
          <StatRow label="Your protection" value={money(held)} />
          {finalized && <StatRow label="You receive" value={money(payoutPreview)} />}
          {claimable ? (
            <div className="mt-3"><Button data-testid="redeem" onClick={() => void run("redeem", [id, held])}>{finalized ? "Claim" : "Finalize and claim"}</Button></div>
          ) : (
            <p className="font-parkBody text-sm mt-3">
              {now > series.redeemEnd ? `Claims closed ${formatDate(series.redeemEnd)}.` : `Claims open ${formatTimestamp(series.finalizeAt)}.`}
            </p>
          )}
        </Card>
      )}

      {!finalized && !series.cancelled && claimable && (
        <Button data-testid="finalize" onClick={() => void run("finalize", [id])}>Finalize policy</Button>
      )}
      {!finalized && !series.cancelled && now > series.saleEnd && now < series.finalizeAt && (
        <p className="font-parkBody"><Link className="underline" to="/policies/submit">Submit a Google Alert</Link> to record this month's rent.</p>
      )}

      {isCreator && !series.residualWithdrawn && (
        <Card>
          <h2 className="font-parkHeading text-2xl mb-3">Creator controls</h2>
          <div className="flex flex-wrap gap-3">
            {series.sold === 0n && !finalized && <Button variant="secondary" onClick={() => void run("cancelSeries", [id])}>Cancel and refund</Button>}
            {now > series.redeemEnd && <Button onClick={() => void run("withdrawResidual", [id])}>Withdraw remaining funds</Button>}
          </div>
          {now <= series.redeemEnd && series.sold > 0n && <p className="font-parkBody text-sm mt-3">Your remaining funds unlock after {formatDate(series.redeemEnd)}.</p>}
        </Card>
      )}
      <TxStatus state={action.state} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────────────────────────────────────

interface Prepared {
  fileName: string;
  headers: Uint8Array;
  body: Uint8Array;
  sig: Uint8Array;
  emailId: string;
  recipient: string | null;
  signedAt: number;
  results: AlertResult[];
}

export function SubmitAlert() {
  const { address } = useAccount();
  const tx = useTx({ label: "Record rent" });
  const [prepared, setPrepared] = useState<Prepared>();
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  useEffect(() => setConsent(false), [prepared]);

  async function load(file: File | undefined) {
    setPrepared(undefined);
    setError("");
    tx.reset();
    if (!file) return;
    if (file.size > 1024 * 1024) return setError("Choose the original alert email, under 1 MB.");
    try {
      const parsed = await parseEmailBytes(new Uint8Array(await file.arrayBuffer()), { domain: "google.com" });
      const signedAt = Number(parsed.tags.raw["t"]);
      setPrepared({
        fileName: file.name,
        headers: parsed.signedHeaders,
        body: parsed.canonBody,
        sig: parsed.sig,
        emailId: parsed.emailId,
        recipient: publishedRecipient(parsed.signedHeaders),
        signedAt,
        results: extractAlertResults(parsed.canonBody, signedAt),
      });
    } catch {
      setError("This is not an original Google Alert email. Use Gmail's Download message to get the .eml file.");
    }
  }

  if (!APARTMENTS_POOL) return <NotDeployed />;
  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12">
      <h1 className="font-parkHeading text-4xl">Submit a Google Alert</h1>
      <Card>
        <p className="font-parkBody mb-4">
          Anyone can record a rent. Upload the original .eml of an Apartments.com alert. Your browser checks it locally, and the
          contract verifies Google's signature. For each page and month, the earliest signed email counts.
        </p>
        <input className={inputClass} type="file" accept=".eml,message/rfc822" onChange={(e) => void load(e.target.files?.[0])} data-testid="alert-file" />
        {error && <p className="font-parkBody text-sm mt-3" role="alert">{error}</p>}
      </Card>
      {prepared && (
        <Card>
          <h2 className="font-parkHeading text-2xl mb-2">{prepared.fileName}</h2>
          <StatRow label="Signed by Google" value={formatTimestamp(BigInt(prepared.signedAt))} />
          {prepared.results.length === 0 ? (
            <p className="font-parkBody mt-3" role="alert">No qualifying rent in this email, so the contract would reject it. It needs the exact "As of Month Year, the average rent in Name was $n/mo." sentence, signed during that month.</p>
          ) : (
            prepared.results.map((r) => (
              <StatRow key={r.slug} label={`${neighborhood(r.slug)?.geography ?? r.slug}, ${monthLabel(r.yyyymm)}`} value={`${formatCents(r.cents)}/mo`} />
            ))
          )}
          {prepared.results.length > 0 && (
            <>
              <div className="border-2 border-paper-2 rounded-lg p-3 mt-4 font-parkBody text-sm" role="alert">
                <p className="font-bold">This publishes the full email permanently on a public blockchain.</p>
                <p className="mt-1">
                  That includes the recipient address{prepared.recipient ? ` (${prepared.recipient})` : ""}, your alert's search
                  text and the links inside it, including its unsubscribe link. It can never be removed. Use a mailbox dedicated to these alerts.
                </p>
              </div>
              <label className="flex gap-3 my-4 font-parkBody">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="alert-consent" />
                I understand and want to publish this email.
              </label>
              <WalletGate>
                <Button
                  disabled={!consent}
                  data-testid="alert-submit"
                  onClick={() => void tx.send({
                    abi: apartmentsOracleAbi, address: APARTMENTS_ORACLE as Address, chainId, account: address,
                    functionName: "submitObservation", args: [toHex(prepared.headers), toHex(prepared.body), toHex(prepared.sig)],
                  })}
                >
                  Publish and record rent
                </Button>
              </WalletGate>
            </>
          )}
          <div className="mt-3"><TxStatus state={tx.state} /></div>
        </Card>
      )}
    </div>
  );
}
