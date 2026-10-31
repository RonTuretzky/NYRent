import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type Address } from "viem";
import { useReadContract } from "wagmi";
import { Button } from "@decentralpark/ui";
import { APARTMENTS_ORACLE, APARTMENTS_POOL, CURRENCY_DECIMALS } from "../../chain/apartments";
import { apartmentsOracleAbi, apartmentsPoolAbi } from "../../chain/apartmentsAbi";
import { formatCents, formatDate, formatTimestamp, truncateAddress } from "../../chain/format";
import { useTx } from "../../chain/useTx";
import { Card, EmptyState, RpcDownState, RpcStaleBanner, StatRow } from "../../components/States";
import { TxStatus } from "../../components/TxStatus";
import { monthLabel } from "../../lib/googleAlert";
import { RENTER_STEPS, WAD, buyExample, humanDelta, pageUrl, parseAmount, parsePolicyId, policyStatus, ratioPercent } from "../../lib/policy";
import {
  ActionFailureHint, FundedAction, KeyDates, NotDeployed, Notice, REFETCH_MS, RiskNotice, SkeletonCard, StepBar, WalletGate, chainId, explorerBase,
  inputClass, money, neighborhood, networkName, pool, symbol, txBusy, txOpts, useClaims, useLock, useNow, useSeries, useWalletFunds,
} from "./shared";

export function PolicyDetail() {
  const params = useParams();
  const id = parsePolicyId(params.id);
  const now = useNow();
  const { series, slug, paused, notFound, refetch, isLoading, rpcDown, stale } = useSeries(id);
  const claims = useClaims(id);
  const earliest = useReadContract({
    address: APARTMENTS_ORACLE as Address, abi: apartmentsOracleAbi, chainId, functionName: "earliest",
    args: series ? [series.slugHash, series.obsMonth] : undefined,
    query: { enabled: Boolean(series && APARTMENTS_ORACLE), refetchInterval: REFETCH_MS },
  });
  const [amount, setAmount] = useState("10");
  const buy = useTx({ label: "Buy protection" });
  const action = useTx({ label: "Policy action" });
  const lock = useLock();

  const amountP = parseAmount(amount, CURRENCY_DECIMALS, "payout amount");
  const maxClaim = amountP.ok ? amountP.value : 0n;
  const premium = series ? (maxClaim * BigInt(series.premiumRateBps)) / 10_000n : 0n;
  const funds = useWalletFunds(premium);

  if (!APARTMENTS_POOL) return <NotDeployed />;
  if (id === null) {
    return (
      <EmptyState title="That is not a policy link">
        <p>Policy links look like <code>/policies/12</code>. <Link className="underline font-bold text-core-green" to="/policies">See all policies</Link>.</p>
      </EmptyState>
    );
  }
  if (rpcDown) return <RpcDownState chainId={chainId} onRetry={() => void refetch()} />;
  if (isLoading) return <div className="max-w-2xl mx-auto space-y-6" aria-busy="true"><SkeletonCard lines={2} /><SkeletonCard lines={8} /><SkeletonCard lines={4} /></div>;
  if (notFound || !series || !slug) {
    return (
      <EmptyState title="Policy not found">
        <p>There is no policy #{String(id)} on {networkName}. The link may be wrong or the policy may be on a newer deployment. <Link className="underline font-bold text-core-green" to="/policies">See all policies</Link>.</p>
      </EmptyState>
    );
  }

  const entry = neighborhood(slug);
  const status = policyStatus(series, now, paused);
  const onSale = status.phase === "onSale";
  const held = claims.data ?? 0n;
  const finalized = series.settled || series.voided;
  const claimWindow = now >= series.finalizeAt && now <= series.redeemEnd && !series.cancelled;
  const isCreator = funds.address?.toLowerCase() === series.creator.toLowerCase();
  const observed = earliest.data && earliest.data[0] !== 0n ? earliest.data : undefined;
  const payoutPreview = series.voided ? (held * BigInt(series.premiumRateBps)) / 10_000n : (held * series.payoutRatioWad) / WAD;
  const available = series.escrow - series.sold;
  const tooMuch = amountP.ok && maxClaim > available;
  const roundsToZero = amountP.ok && series.premiumRateBps > 0 && premium === 0n;
  const example = buyExample(amountP.ok ? maxClaim : 0n, series.premiumRateBps, series.strikeLowCents, series.strikeHighCents);
  const busy = txBusy(buy.state) || txBusy(action.state);

  const step = held > 0n
    ? (status.phase === "settled" || status.phase === "void" || claimWindow ? 6 : 5)
    : !onSale ? 1
    : funds.stage === "connect" || funds.stage === "network" || funds.stage === "noGas" || funds.stage === "noFunds" ? 2
    : funds.stage === "approve" ? 3
    : funds.stage === "ready" ? 4 : 1;

  const refreshAll = () => Promise.all([refetch(), claims.refetch(), funds.refetch(), earliest.refetch()]);
  const run = (functionName: string, args: readonly unknown[]) => lock(async () => {
    await action.send({ abi: apartmentsPoolAbi, address: pool, chainId, account: funds.address, functionName, args }, txOpts);
    await refreshAll();
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12 min-w-0">
      <div className="min-w-0">
        <p className="font-parkBody font-bold">Policy #{String(id)} · <span data-testid="policy-status">{status.label}</span></p>
        <h1 className="font-parkHeading text-3xl sm:text-4xl mt-2 break-words">{entry?.geography ?? slug}, {monthLabel(series.obsMonth)}</h1>
        <p className="font-parkBody text-sm mt-2 leading-relaxed" data-testid="status-next"><span className="font-bold">What happens next:</span> {status.next}</p>
        <a className="underline font-parkBody text-sm break-all inline-flex min-h-11 items-center" href={pageUrl(slug)} target="_blank" rel="noreferrer">{pageUrl(slug)}</a>
        {!entry && <Notice tone="warn">This page is not in the app's list of known neighborhoods. Open the link above and make sure it is the page you expect before buying.</Notice>}
      </div>
      {stale && <RpcStaleBanner />}
      <Card><StepBar steps={RENTER_STEPS} current={step} title="Buy protection" /></Card>

      <Card>
        <h2 className="font-parkHeading text-2xl mb-2">Terms</h2>
        <StatRow label="Payout starts above" value={`${formatCents(series.strikeLowCents)}/mo`} />
        <StatRow label="Full payout at" value={`${formatCents(series.strikeHighCents)}/mo`} />
        <StatRow label="Premium" value={`${series.premiumRateBps / 100}% of max payout`} />
        <StatRow label="Escrowed by the creator" value={money(series.escrow)} />
        <StatRow label="Sold so far" value={money(series.sold)} />
        <StatRow label="Still available" value={money(available)} />
        <StatRow label="Creator" value={<a className="underline" href={`${explorerBase}/address/${series.creator}`} target="_blank" rel="noreferrer">{truncateAddress(series.creator)}</a>} mono />
        {observed && <StatRow label="Earliest signed rent so far" value={`${formatCents(observed[1])}/mo`} />}
        {series.settled && <StatRow label="Final payout" value={`${ratioPercent(series.payoutRatioWad)}% of each claim`} />}
        <h3 className="font-parkBody font-bold text-sm mt-4 mb-2">Key dates</h3>
        <KeyDates series={series} now={now} />
      </Card>

      {onSale && (
        <Card data-testid="buy-card">
          <h2 className="font-parkHeading text-2xl mb-3">Buy protection</h2>
          <label className="block font-parkBody mb-2">
            Maximum payout you want ({symbol})
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="buy-amount" aria-invalid={!amountP.ok || tooMuch || roundsToZero} aria-describedby="buy-help" />
          </label>
          <p id="buy-help" className="font-parkBody text-xs text-surface-grey-2 mb-3">This is the most you can receive. The premium is {series.premiumRateBps / 100}% of it, paid now, and is not returned unless the policy voids.</p>
          {!amountP.ok ? <Notice tone="error" testId="buy-validation">{amountP.error}</Notice>
            : tooMuch ? <Notice tone="error" testId="buy-validation">Only {money(available)} is still available on this policy. Enter that amount or less.</Notice>
            : roundsToZero ? <Notice tone="error" testId="buy-validation">That amount is so small the premium rounds to zero, so the contract would refuse it. Enter a larger amount.</Notice>
            : null}
          <StatRow label="You pay now (premium)" value={money(premium)} />
          <StatRow label="Sales close" value={`${formatTimestamp(series.saleEnd)} (${humanDelta(series.saleEnd, now)})`} />
          {amountP.ok && !tooMuch && (
            <div className="my-3" data-testid="worked-example">
              <p className="font-parkBody text-sm font-bold">What {money(premium)} buys you</p>
              <ul className="font-parkBody text-sm list-disc pl-5 mt-1 space-y-1 leading-relaxed">
                <li>If the {monthLabel(series.obsMonth)} headline rent reaches <strong>{formatCents(series.strikeHighCents)}</strong> or more, you get <strong>{money(maxClaim)}</strong>.</li>
                <li>If it is <strong>{formatCents(example.midCents)}</strong>, you get {money(example.midPayout)} (it rises in a straight line between the two rents).</li>
                <li>If it stays at or below <strong>{formatCents(series.strikeLowCents)}</strong>, you get <strong>$0</strong> and the premium is gone.</li>
                <li>If no qualifying alert email arrives for that month, the policy voids and you get your <strong>{money(premium)}</strong> premium back. That is a refund, not a claim.</li>
              </ul>
              <p className="font-parkBody text-xs text-surface-grey-2 mt-2">You must claim between {formatDate(series.finalizeAt)} and {formatDate(series.redeemEnd)}; after that the money returns to the creator. Claims cannot be transferred to another wallet.</p>
            </div>
          )}
          <div className="space-y-3 mt-3">
            <RiskNotice side="buy" />
            <WalletGate why={`to pay the premium in ${symbol} on ${networkName}`}>
              {amountP.ok && !tooMuch && !roundsToZero ? (
                <FundedAction need={premium} funds={funds} what="the premium">
                  <Button
                    data-testid="buy-submit"
                    disabled={busy}
                    isLoading={txBusy(buy.state)}
                    showChildrenWhenLoading
                    onClick={() => void lock(async () => {
                      await buy.send({ abi: apartmentsPoolAbi, address: pool, chainId, account: funds.address, functionName: "buyProtection", args: [id, maxClaim, premium] }, txOpts);
                      await refreshAll();
                    })}
                  >
                    {txBusy(buy.state) ? "Buying…" : `Buy ${money(maxClaim)} of protection for ${money(premium)}`}
                  </Button>
                </FundedAction>
              ) : <p className="font-parkBody text-sm">Fix the amount above first.</p>}
            </WalletGate>
            <TxStatus state={buy.state} />
            <ActionFailureHint state={buy.state} />
            {buy.state.status === "confirmed" && <Notice tone="ok" testId="bought-ok">Done. Your protection is listed below; nothing else to do until {formatDate(series.finalizeAt)}.</Notice>}
          </div>
        </Card>
      )}
      {!onSale && buy.state.status !== "idle" && (
        // The sale state changed under a click: keep the outcome of that click
        // on screen even though the buy card is gone.
        <div className="space-y-2"><TxStatus state={buy.state} /><ActionFailureHint state={buy.state} /></div>
      )}
      {status.phase === "paused" && <Notice tone="warn" testId="paused-notice">Sales are paused by the creator, so nothing can be bought right now. Protection already bought is unaffected.</Notice>}
      {status.phase === "soldOut" && <Notice tone="info" testId="sold-out-notice">Sold out: all {money(series.escrow)} of escrow is spoken for. Try another policy or ask the creator to add capacity.</Notice>}

      {funds.address && held === 0n && !onSale && status.phase !== "cancelled" && (
        <Notice tone="info" testId="nothing-to-claim">This wallet holds no protection on this policy, so there is nothing to claim here.</Notice>
      )}

      {held > 0n && (
        <Card data-testid="claim-card">
          <h2 className="font-parkHeading text-2xl mb-2">Your protection</h2>
          <StatRow label="Maximum payout you hold" value={money(held)} />
          {finalized && <StatRow label={series.voided ? "Refund (your premium back)" : "Your claim"} value={money(payoutPreview)} />}
          {claimWindow ? (
            <div className="mt-3 space-y-2">
              <p className="font-parkBody text-sm leading-relaxed">
                {series.voided ? `No qualifying email was recorded, so this is a refund of your premium, ${money(payoutPreview)}.`
                  : series.settled ? `The recorded rent pays ${ratioPercent(series.payoutRatioWad)}% of each claim, so you receive ${money(payoutPreview)}.`
                  : "Nobody has finalized yet. Claiming finalizes first, then pays whatever the recorded rent earned you, or refunds your premium if nothing was recorded."}
                {" "}Claims close {formatDate(series.redeemEnd)} ({humanDelta(series.redeemEnd, now)}).
              </p>
              {(!finalized || payoutPreview > 0n) ? (
                <Button data-testid="redeem" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("redeem", [id, held])}>
                  {txBusy(action.state) ? "Claiming…" : finalized ? `Claim ${money(payoutPreview)}` : "Finalize and claim"}
                </Button>
              ) : <Notice tone="info" testId="zero-claim">The rent stayed at or below {formatCents(series.strikeLowCents)}, so your claim pays $0. There is nothing to collect.</Notice>}
            </div>
          ) : (
            <p className="font-parkBody text-sm mt-3" data-testid="claim-timing">
              {now > series.redeemEnd ? `Claims closed ${formatDate(series.redeemEnd)}. Anything unclaimed went back to the creator.`
                : series.cancelled ? "This policy was cancelled."
                : `Claims open ${formatTimestamp(series.finalizeAt)} (${humanDelta(series.finalizeAt, now)}). Until then, the month's rent still has to be recorded.`}
            </p>
          )}
        </Card>
      )}

      {!finalized && !series.cancelled && claimWindow && held === 0n && (
        <Card>
          <h2 className="font-parkHeading text-2xl mb-2">Finalize</h2>
          <p className="font-parkBody text-sm mb-3">Anyone can lock in the result now. It costs only a network fee and lets every holder claim.</p>
          <WalletGate why="to finalize">
            <Button data-testid="finalize" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("finalize", [id])}>{txBusy(action.state) ? "Finalizing…" : "Finalize policy"}</Button>
          </WalletGate>
        </Card>
      )}
      {status.phase === "awaitingData" && (
        <Notice tone="info" testId="awaiting-data">
          Sales are closed. {observed ? `The earliest signed alert so far says ${formatCents(observed[1])}/mo.` : "No alert email has been recorded for this month yet."}{" "}
          <Link className="underline font-bold text-core-green" to="/policies/submit">Record this month's Google Alert</Link> if you have it; the earliest-signed one wins, until {formatTimestamp(series.finalizeAt)}.
        </Notice>
      )}

      {isCreator && (
        <Card data-testid="creator-card">
          <h2 className="font-parkHeading text-2xl mb-3">You created this policy</h2>
          {series.residualWithdrawn ? (
            <p className="font-parkBody text-sm">{series.cancelled ? "You cancelled it and the escrow came back." : "You withdrew the remaining funds. Nothing is left here."}</p>
          ) : (
            <div className="space-y-3">
              <p className="font-parkBody text-sm leading-relaxed">
                Share the link to this page. Premiums so far: <strong>{money(series.premiumsAccrued)}</strong>.{" "}
                {series.sold === 0n && !finalized ? "Nothing has sold, so you can still cancel and take the escrow back."
                  : now > series.redeemEnd ? `Claims closed; ${money(series.escrow + series.premiumsAccrued - series.paidOut)} is yours to withdraw.`
                  : `Your remaining funds unlock after ${formatDate(series.redeemEnd)} (${humanDelta(series.redeemEnd, now)}).`}
              </p>
              <WalletGate why="to manage this policy">
                <div className="flex flex-wrap gap-3">
                  {series.sold === 0n && !finalized && (
                    <Button variant="secondary" data-testid="cancel" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("cancelSeries", [id])}>Cancel and take back {money(series.escrow)}</Button>
                  )}
                  {now < series.saleEnd && (
                    <Button variant="secondary" data-testid="pause" disabled={busy} onClick={() => void run("setSeriesPaused", [id, !paused])}>{paused ? "Resume sales" : "Pause sales"}</Button>
                  )}
                  {now > series.redeemEnd && (
                    <Button data-testid="withdraw" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("withdrawResidual", [id])}>Withdraw {money(series.escrow + series.premiumsAccrued - series.paidOut)}</Button>
                  )}
                </div>
              </WalletGate>
            </div>
          )}
        </Card>
      )}
      <TxStatus state={action.state} />
      <ActionFailureHint state={action.state} />
    </div>
  );
}
