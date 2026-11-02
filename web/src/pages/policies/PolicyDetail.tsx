import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { decodeEventLog, formatUnits, type Address } from "viem";
import { Button } from "@decentralpark/ui";
import { CURRENCY_DECIMALS, poolFor, policyPoolAbi } from "../../chain/apartments";
import { formatCents, formatDate, formatTimestamp, truncateAddress } from "../../chain/format";
import { Card, EmptyState, RpcDownState, RpcStaleBanner, StatRow } from "../../components/States";
import { TxStatus } from "../../components/TxStatus";
import { monthLabel } from "../../lib/googleAlert";
import {
  WAD, buyExample, humanDelta, pageUrl, parseAmount, parsePolicyId, policyLabel, policyStatus, ratioPercent, renterStep, renterSteps,
  type PoolVersion,
} from "../../lib/policy";
import {
  ActionFailureHint, FundedAction, KeyDates, NotDeployed, Notice, PrimaryLink, RiskNotice, SkeletonCard, StepBar, WalletGate, chainId,
  explorerBase, inputClass, money, neighborhood, networkName, symbol, txBusy, txOpts, useClaims, useEarliest, useLock, useNow, usePolicyTx, useResumedTxs,
  useSeries, useWalletFunds, type ReceiptLike,
} from "./shared";

/** Payout paid by a Redeemed event in `logs`, if any. */
function redeemedPayout(logs: ReceiptLike["logs"]): bigint | undefined {
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: policyPoolAbi, data: log.data, topics: log.topics as [`0x${string}`] });
      if (event.eventName === "Redeemed" && event.args) return (event.args as { payout: bigint }).payout;
    } catch {
      // not a pool event
    }
  }
  return undefined;
}

/** A policy page. V2 policies live at /policies/:id, V1 ones at /policies/v1/:id. */
const DEFAULT_BUY = 10n * 10n ** BigInt(CURRENCY_DECIMALS);

export function PolicyDetail({ version = "v2" }: { version?: PoolVersion }) {
  const params = useParams();
  const pp = poolFor(version);
  const id = parsePolicyId(params.id);
  // Pending-transaction keys are per pool: V1 #0 and V2 #0 are different policies.
  const idText = `${version}:${String(id ?? 0n)}`;
  const now = useNow();
  const { series, slug, paused, notFound, refetch, isLoading, rpcDown, stale } = useSeries(pp, id);
  const claims = useClaims(pp, id);
  const earliest = useEarliest(series?.slugHash, series?.obsMonth);
  const [typed, setAmount] = useState<string>();
  // Until the buyer types, offer 10 USDC, or everything left when less remains.
  const left = series ? series.escrow - series.sold : 0n;
  const amount = typed ?? formatUnits(left > 0n && left < DEFAULT_BUY ? left : DEFAULT_BUY, CURRENCY_DECIMALS);
  const [addAmount, setAddAmount] = useState("");
  const [bought, setBought] = useState<{ maxClaim: bigint; premium: bigint }>();
  const [received, setReceived] = useState<bigint>();
  const [added, setAdded] = useState<bigint>();
  const buy = usePolicyTx({ label: "Buy protection", key: `buy:${idText}` });
  const action = usePolicyTx({ label: "Policy action", key: `act:${idText}` });
  const add = usePolicyTx({ label: "Add escrow", key: `add:${idText}` });
  const lock = useLock();

  const amountP = parseAmount(amount, CURRENCY_DECIMALS, "payout amount");
  const maxClaim = amountP.ok ? amountP.value : 0n;
  const premium = series ? (maxClaim * BigInt(series.premiumRateBps)) / 10_000n : 0n;
  const poolAddress = pp?.address as Address;
  const funds = useWalletFunds(premium, pp?.address);
  const addP = parseAmount(addAmount, CURRENCY_DECIMALS, "escrow amount");
  const addWei = addP.ok ? addP.value : 0n;
  const addFunds = useWalletFunds(addWei, pp?.address);

  const refreshAll = useCallback(
    () => Promise.all([refetch(), claims.refetch(), funds.refetch(), earliest.refetch()]),
    [refetch, claims, funds, earliest],
  );
  const resumedKeys = useMemo(() => [`buy:${idText}`, `act:${idText}`, `add:${idText}`], [idText]);
  const resumed = useResumedTxs(resumedKeys, (key, status, receipt) => {
    void refreshAll();
    if (status === "confirmed" && key.startsWith("act:") && receipt) {
      const payout = redeemedPayout(receipt.logs);
      if (payout !== undefined) setReceived(payout);
    }
  });

  if (!pp) return <NotDeployed />;
  if (id === null) {
    return (
      <EmptyState title="That is not a policy link">
        <p>Policy links look like <code>/policies/12</code> (or <code>/policies/v1/0</code> for the first pool). <PrimaryLink to="/policies">See all policies</PrimaryLink>.</p>
      </EmptyState>
    );
  }
  if (rpcDown) return <RpcDownState onRetry={() => void refetch()} />;
  if (isLoading) return <div className="max-w-2xl mx-auto space-y-6" aria-busy="true"><SkeletonCard lines={2} /><SkeletonCard lines={8} /><SkeletonCard lines={4} /></div>;
  if (notFound || !series || !slug) {
    return (
      <EmptyState title="Policy not found">
        <p>There is no policy {policyLabel(version, id)} on {networkName}. The link may be wrong{version === "v2" ? "; policies from the first pool live at /policies/v1/…" : ""}. <PrimaryLink to="/policies">See all policies</PrimaryLink>.</p>
      </EmptyState>
    );
  }

  const rules = pp.rules;
  const observed = earliest.data && earliest.data[0] !== 0n ? earliest.data : undefined;
  const recorded = Boolean(observed);
  const stoppedByRecord = rules.stopsOnRecord && recorded;
  const entry = neighborhood(slug);
  const status = policyStatus(series, now, paused, { rules, recorded });
  const onSale = status.phase === "onSale";
  const held = claims.data ?? 0n;
  const finalized = series.settled || series.voided;
  const claimWindow = now >= series.finalizeAt && now <= series.redeemEnd && !series.cancelled;
  const isCreator = funds.address?.toLowerCase() === series.creator.toLowerCase();
  const payoutPreview = series.voided ? (held * BigInt(series.premiumRateBps)) / 10_000n : (held * series.payoutRatioWad) / WAD;
  const available = series.escrow - series.sold;
  const tooMuch = amountP.ok && maxClaim > available;
  const roundsToZero = amountP.ok && series.premiumRateBps > 0 && premium === 0n;
  const amountValid = amountP.ok && !tooMuch && !roundsToZero;
  const example = buyExample(amountP.ok ? maxClaim : 0n, series.premiumRateBps, series.strikeLowCents, series.strikeHighCents);
  const busy = txBusy(buy.state) || txBusy(action.state) || txBusy(add.state) || resumed.busy;
  const salesOpenForCreator = now < series.saleEnd && !series.cancelled && !stoppedByRecord;
  const residual = series.escrow + series.premiumsAccrued - series.paidOut;

  const step = renterStep({
    phase: status.phase, held, claimWindow, fundsStage: funds.stage, amountValid,
    justBought: Boolean(bought), justClaimed: received !== undefined,
  });

  const run = (functionName: string, args: readonly unknown[]) => lock(async () => {
    const result = await action.send({ abi: policyPoolAbi, address: poolAddress, chainId, account: funds.address, functionName, args }, txOpts);
    if (result.status === "confirmed" && functionName === "redeem") {
      const payout = redeemedPayout(result.receipt.logs);
      setReceived(payout ?? 0n);
    }
    await refreshAll();
  });

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12 min-w-0">
      <div className="min-w-0">
        <p className="font-parkBody font-bold">Policy {policyLabel(version, id)} · <span data-testid="policy-status">{status.label}</span></p>
        <h1 className="font-parkDisplay font-bold text-3xl sm:text-4xl mt-2 break-words">{entry?.geography ?? slug}, {monthLabel(series.obsMonth)}</h1>
        <p className="font-parkBody text-sm mt-2 leading-relaxed" data-testid="status-next"><span className="font-bold">What happens next:</span> {status.next}</p>
        <a className="underline font-parkBody text-sm break-all inline-flex min-h-11 items-center" href={pageUrl(slug)} target="_blank" rel="noreferrer">{pageUrl(slug)}</a>
        {!entry && <Notice tone="warn">This page is not in the app's list of known neighborhoods. Open the link above and make sure it is the page you expect before buying.</Notice>}
      </div>
      {stale && <RpcStaleBanner />}
      {resumed.node}
      <Card><StepBar steps={renterSteps(rules)} view={step} title="Buy protection" /></Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-2xl mb-2">Terms</h2>
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
        <KeyDates series={series} now={now} rules={rules} />
      </Card>

      {onSale && bought && (
        <Card data-testid="buy-card">
          <h2 className="font-parkDisplay font-bold text-2xl mb-3">Bought</h2>
          <Notice tone="ok" testId="bought-ok">
            <p className="font-bold">Done. You bought {money(bought.maxClaim)} of protection for {money(bought.premium)}.</p>
            <p className="mt-1">It is listed under "Your protection" below. Nothing else to do until {formatDate(series.finalizeAt)}, when claims open.</p>
          </Notice>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <TxStatus state={buy.state} />
          </div>
          <div className="mt-3">
            <Button variant="secondary" data-testid="buy-more" onClick={() => { setBought(undefined); buy.reset(); setAmount(undefined); }}>Buy more protection</Button>
          </div>
        </Card>
      )}
      {onSale && !bought && (
        <Card data-testid="buy-card">
          <h2 className="font-parkDisplay font-bold text-2xl mb-3">Buy protection</h2>
          <label className="block font-parkBody mb-2">
            Maximum payout you want ({symbol})
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="buy-amount" aria-invalid={!amountValid} aria-describedby="buy-help" />
          </label>
          <p id="buy-help" className="font-parkBody text-xs text-surface-grey-2 mb-3">This is the most you can receive. The premium is {series.premiumRateBps / 100}% of it, paid now, and is not returned unless the policy voids.</p>
          {!amountP.ok ? <Notice tone="error" testId="buy-validation">{amountP.error}</Notice>
            : tooMuch ? <Notice tone="error" testId="buy-validation">Only {money(available)} is still available on this policy. Enter that amount or less.</Notice>
            : roundsToZero ? <Notice tone="error" testId="buy-validation">That amount is so small the premium rounds to zero, so the contract would refuse it. Enter a larger amount.</Notice>
            : null}
          <StatRow label="You pay now (premium)" value={money(premium)} />
          <StatRow label="Sales close" value={`${formatTimestamp(series.saleEnd)} (${humanDelta(series.saleEnd, now)})`} />
          {amountValid && (
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
              {resumed.busy ? (
                <Notice tone="info" testId="held-back">Waiting for your transaction in progress to finish before offering this again.</Notice>
              ) : amountValid ? (
                <FundedAction need={premium} funds={funds} what="the premium">
                  <Button
                    data-testid="buy-submit"
                    disabled={busy}
                    isLoading={txBusy(buy.state)}
                    showChildrenWhenLoading
                    onClick={() => void lock(async () => {
                      const result = await buy.send({ abi: policyPoolAbi, address: poolAddress, chainId, account: funds.address, functionName: "buyProtection", args: [id, maxClaim, premium] }, txOpts);
                      if (result.status === "confirmed") {
                        setBought({ maxClaim, premium });
                        setAmount("");
                      }
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
          </div>
        </Card>
      )}
      {!onSale && buy.state.status !== "idle" && !bought && (
        // The sale state changed under a click: keep the outcome of that click
        // on screen even though the buy card is gone.
        <div className="space-y-2"><TxStatus state={buy.state} /><ActionFailureHint state={buy.state} /></div>
      )}
      {stoppedByRecord && now < series.saleEnd && !series.cancelled && (
        <Notice tone="info" testId="sales-stopped-recorded">This month's rent is already recorded, so sales are closed.</Notice>
      )}
      {status.phase === "paused" && <Notice tone="warn" testId="paused-notice">Sales are paused by the creator, so nothing can be bought right now. Protection already bought is unaffected.</Notice>}
      {status.phase === "soldOut" && (
        <Notice tone="info" testId="sold-out-notice">
          Sold out: all {money(series.escrow)} of escrow is spoken for. {now < series.saleEnd ? "The creator can add escrow until sales close; check back, or try another policy." : "Sales are closed."}
        </Notice>
      )}

      {received !== undefined && (
        <Card data-testid="claim-card">
          <h2 className="font-parkDisplay font-bold text-2xl mb-2">{series.voided ? "Refunded" : "Claimed"}</h2>
          <Notice tone="ok" testId="claimed-ok">
            <p className="font-bold">You received {money(received)}{series.voided ? " as a refund of your premium" : " as a claim on the recorded rent"}.</p>
            <p className="mt-1">
              {series.voided
                ? "No qualifying email was recorded for this month, so the policy voided: this is your premium back, not a payout."
                : received === 0n
                  ? `The recorded rent stayed at or below ${formatCents(series.strikeLowCents)}, so the claim paid $0 and your protection was closed out.`
                  : `The recorded rent paid ${ratioPercent(series.payoutRatioWad)}% of each unit you held.`}
              {" "}This policy is done for you.
            </p>
          </Notice>
          <div className="mt-3"><TxStatus state={action.state} /></div>
        </Card>
      )}

      {received === undefined && funds.address && held === 0n && !onSale && status.phase !== "cancelled" && (
        <Notice tone="info" testId="nothing-to-claim">This wallet holds no protection on this policy, so there is nothing to claim here.</Notice>
      )}

      {held > 0n && received === undefined && (
        <Card data-testid="claim-card">
          <h2 className="font-parkDisplay font-bold text-2xl mb-2">Your protection</h2>
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
          <h2 className="font-parkDisplay font-bold text-2xl mb-2">Finalize</h2>
          <p className="font-parkBody text-sm mb-3">Anyone can lock in the result now. It costs only a network fee and lets every holder claim.</p>
          <WalletGate why="to finalize">
            <Button data-testid="finalize" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("finalize", [id])}>{txBusy(action.state) ? "Finalizing…" : "Finalize policy"}</Button>
          </WalletGate>
        </Card>
      )}
      {status.phase === "awaitingData" && (
        <Notice tone="info" testId="awaiting-data">
          Sales are closed. {observed ? `The earliest signed alert so far says ${formatCents(observed[1])}/mo.` : "No alert email has been recorded for this month yet."}{" "}
          <PrimaryLink to="/policies/submit">Record this month's Google Alert</PrimaryLink> if you have it; the earliest-signed one wins, until {formatTimestamp(series.finalizeAt)}.
        </Notice>
      )}

      {isCreator && (
        <Card data-testid="creator-card">
          <h2 className="font-parkDisplay font-bold text-2xl mb-3">You created this policy</h2>
          {series.residualWithdrawn ? (
            <p className="font-parkBody text-sm">{series.cancelled ? "You cancelled it and the escrow came back." : "You withdrew the remaining funds. Nothing is left here."}</p>
          ) : (
            <div className="space-y-3">
              <p className="font-parkBody text-sm leading-relaxed">
                Share the link to this page. Premiums so far: <strong>{money(series.premiumsAccrued)}</strong>.{" "}
                {series.sold === 0n && !finalized ? "Nothing has sold, so you can still cancel and take the escrow back."
                  : now > series.redeemEnd ? `Claims closed; ${money(residual)} is yours to withdraw.`
                  : `Your remaining funds unlock after ${formatDate(series.redeemEnd)} (${humanDelta(series.redeemEnd, now)}).`}
              </p>
              <WalletGate why="to manage this policy">
                <div className="flex flex-wrap gap-3">
                  {series.sold === 0n && !finalized && (
                    <Button variant="secondary" data-testid="cancel" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("cancelSeries", [id])}>Cancel and take back {money(series.escrow)}</Button>
                  )}
                  {salesOpenForCreator && (
                    <Button variant="secondary" data-testid="pause" disabled={busy} onClick={() => void run("setSeriesPaused", [id, !paused])}>{paused ? "Resume sales" : "Pause sales"}</Button>
                  )}
                  {now > series.redeemEnd && (
                    <Button data-testid="withdraw" disabled={busy} isLoading={txBusy(action.state)} showChildrenWhenLoading onClick={() => void run("withdrawResidual", [id])}>Withdraw {money(residual)}</Button>
                  )}
                </div>
                {salesOpenForCreator && (
                  <div className="mt-4 space-y-2" data-testid="add-escrow-card">
                    <h3 className="font-parkBody font-bold">Add escrow</h3>
                    <p className="font-parkBody text-sm">More escrow means more protection for sale{available === 0n ? " (this policy is sold out)" : ""}. Terms stay the same; you can add until sales close {formatTimestamp(series.saleEnd)}.</p>
                    <label className="block font-parkBody text-sm">
                      Amount to add ({symbol})
                      <input className={inputClass} inputMode="decimal" value={addAmount} onChange={(e) => { setAddAmount(e.target.value); setAdded(undefined); }} data-testid="add-amount" aria-invalid={addAmount !== "" && !addP.ok} />
                    </label>
                    {addAmount !== "" && !addP.ok && <Notice tone="error" testId="add-validation">{addP.error}</Notice>}
                    {added !== undefined && <Notice tone="ok" testId="added-ok">Added {money(added)}. The policy now escrows {money(series.escrow)} with {money(available)} still for sale.</Notice>}
                    {addP.ok && (
                      <FundedAction need={addWei} funds={addFunds} what="the extra escrow">
                        <Button
                          data-testid="add-escrow"
                          disabled={busy}
                          isLoading={txBusy(add.state)}
                          showChildrenWhenLoading
                          onClick={() => void lock(async () => {
                            const result = await add.send({ abi: policyPoolAbi, address: poolAddress, chainId, account: funds.address, functionName: "addCapacity", args: [id, addWei] }, txOpts);
                            if (result.status === "confirmed") {
                              setAdded(addWei);
                              setAddAmount("");
                            }
                            await Promise.all([refreshAll(), addFunds.refetch()]);
                          })}
                        >
                          {txBusy(add.state) ? "Adding…" : `Add ${money(addWei)} of escrow`}
                        </Button>
                      </FundedAction>
                    )}
                    <TxStatus state={add.state} />
                    <ActionFailureHint state={add.state} />
                  </div>
                )}
              </WalletGate>
            </div>
          )}
        </Card>
      )}
      {received === undefined && <TxStatus state={action.state} />}
      <ActionFailureHint state={action.state} />
      {held === 0n && received === undefined && !onSale && !isCreator && status.phase !== "cancelled" && (
        <p className="font-parkBody text-sm"><PrimaryLink to="/policies">See other policies</PrimaryLink></p>
      )}
    </div>
  );
}
