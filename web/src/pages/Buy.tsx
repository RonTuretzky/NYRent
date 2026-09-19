import { ACTIVE_MARKET_ID } from "../lib/market";
import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useAccount, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Button } from "@decentralpark/ui";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import {
  useCoverUnits,
  useSeriesRow,
  useWalletCurrency,
} from "../chain/poolHooks";
import {
  approveCurrencyRequest,
  approveRouterRequest,
  buyProtectionRequest,
  premiumFor,
  premiumRoundsToZero,
  swapAndBuyRequest,
  wrapNativeRequest,
} from "../chain/router";
import {
  friendlySwapError,
  usePaymentBalances,
  usePaymentTokens,
  useRouterAllowance,
  useSwapQuote,
  type PaymentToken,
} from "../chain/swap";
import { useTx, type TxState } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import { TokenSelect, type TokenOption } from "../components/TokenSelect";
import { PricingPanel } from "../components/PricingPanel";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  StatRow,
} from "../components/States";
import {
  formatBps,
  formatCents,
  formatCurrency,
  formatDate,
  nowSec,
  parseCurrency,
} from "../chain/format";

function txBusy(state: TxState): boolean {
  return (
    state.status === "simulating" ||
    state.status === "wallet" ||
    state.status === "pending"
  );
}

/** A dotted-underline term with a plain-language tooltip. */
function Term({ children, tip }: { children: string; tip: string }) {
  return (
    <span
      title={tip}
      className="underline decoration-dotted decoration-surface-grey cursor-help"
    >
      {children}
    </span>
  );
}

export function Buy() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : ACTIVE_MARKET_ID;
  const { deployment } = useActiveDeployment();
  const { symbol, decimals } = deployment.currency;

  const { series: s, paused, isLoading, rpcError } = useSeriesRow(seriesId);
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const {
    balance,
    allowance,
    refetch: refetchCurrency,
  } = useWalletCurrency();
  const { balance: coverBalance, refetch: refetchCover } =
    useCoverUnits(seriesId);

  // ---- wizard prefill (route state or ?amount=/&pay= from /choose) --------
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const prefillAmount =
    searchParams.get("amount") ??
    (location.state as { amount?: string } | null)?.amount ??
    "";
  const prefillPay =
    searchParams.get("pay") ??
    (location.state as { pay?: string } | null)?.pay ??
    undefined;
  const fromWizard = prefillAmount !== "";

  const tokens = usePaymentTokens();
  const directToken = useMemo(
    () => tokens.find((t) => t.route.kind === "direct") ?? tokens[0],
    [tokens],
  );

  const [amountInput, setAmountInput] = useState(prefillAmount);
  const [payTokenId, setPayTokenId] = useState<string>(
    prefillPay && tokens.some((t) => t.id === prefillPay)
      ? prefillPay
      : directToken.id,
  );
  const [swapSlippageInput, setSwapSlippageInput] = useState("");

  const approveTx = useTx();
  const buyTx = useTx();
  const wrapTx = useTx();
  const swapApproveTx = useTx();
  const swapBuyTx = useTx();

  function resetFlow() {
    approveTx.reset();
    buyTx.reset();
    wrapTx.reset();
    swapApproveTx.reset();
    swapBuyTx.reset();
  }

  // Chain switch: the token menu is per-chain, so reselect the pool currency
  // and clear any in-progress flow.
  const activeChainId = deployment.chainId;
  useEffect(() => {
    setPayTokenId((current) =>
      tokens.some((t) => t.id === current) ? current : directToken.id,
    );
    setSwapSlippageInput("");
    resetFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChainId]);

  const token: PaymentToken =
    tokens.find((t) => t.id === payTokenId) ?? directToken;
  const route = token.route;
  const isDirect = route.kind === "direct";
  const isWrap = route.kind === "wrap";
  const isRouter = route.kind === "router";
  const isNativeRouter = isRouter && route.native === true;

  const maxClaim = parseCurrency(amountInput, decimals);
  const premium =
    s !== undefined && maxClaim !== null && maxClaim > 0n
      ? premiumFor(maxClaim, s.premiumRateBps)
      : undefined;
  // The premium rate is immutable on-chain, so the price cannot move between
  // quote and purchase: maxPremium is the exact premium (no slippage jargon).
  const maxPremium = premium;

  // Swap slippage override (bps) from the advanced disclosure; empty = default.
  const swapSlippageTrimmed = swapSlippageInput.trim();
  const swapSlippageParsed =
    swapSlippageTrimmed === "" ? undefined : Number(swapSlippageTrimmed);
  const swapSlippageInvalid =
    swapSlippageParsed !== undefined &&
    (!Number.isFinite(swapSlippageParsed) ||
      swapSlippageParsed < 0 ||
      swapSlippageParsed > 1000);

  const swapQuote = useSwapQuote(
    isRouter ? token : undefined,
    premium,
    swapSlippageInvalid ? undefined : swapSlippageParsed,
  );
  const balances = usePaymentBalances(tokens, address);
  const { allowance: routerAllowance, refetch: refetchRouterAllowance } =
    useRouterAllowance(token, address);

  const now = nowSec();
  const selectedBalance = balances.byId[token.id];
  const flowDone =
    buyTx.state.status === "confirmed" ||
    swapBuyTx.state.status === "confirmed";

  // Wrap route: once the premium sits in the wallet as the pool currency —
  // because the wrap confirmed, or because they held enough all along — the
  // remaining steps are exactly the direct flow.
  const currencyCovered =
    premium !== undefined && balance !== undefined && balance >= premium;
  const wrapDone =
    wrapTx.state.status === "confirmed" || currencyCovered || flowDone;

  // ---- validation (plain sentences only) ----------------------------------
  const validation = useMemo<string | null>(() => {
    if (!s) return null;
    if (amountInput.trim() === "") return null;
    if (maxClaim === null) {
      return "That doesn't look like a number — enter an amount like 100.";
    }
    if (maxClaim <= 0n) return "Enter an amount greater than zero.";
    if (premiumRoundsToZero(maxClaim, s.premiumRateBps)) {
      return "That amount is too small to price — try a bigger one.";
    }
    const capacityLeft = s.escrow - s.sold;
    if (maxClaim > capacityLeft) {
      return `Only ${formatCurrency(capacityLeft, { symbol, decimals })} of protection is still available in this market.`;
    }
    if (premium === undefined) return null;
    if (isDirect || (isWrap && wrapDone)) {
      if (balance !== undefined && premium > balance) {
        return `Your one-time price is ${formatCurrency(premium, { symbol, decimals })} but your ${symbol} balance is ${formatCurrency(balance, { symbol, decimals })}.`;
      }
    } else if (isWrap) {
      if (selectedBalance !== undefined && premium > selectedBalance) {
        return `Your one-time price is ${formatCurrency(premium, { symbol: token.symbol, decimals: token.decimals })} but you hold ${formatCurrency(selectedBalance, { symbol: token.symbol, decimals: token.decimals })} — and you'll still need a little extra for gas.`;
      }
    } else if (isRouter) {
      if (swapSlippageInvalid) {
        return "Swap slippage must be between 0 and 1000 bps.";
      }
      if (swapQuote.quoteFailed) {
        return `No live market route for ${token.symbol} right now — try another way to pay.`;
      }
      if (
        swapQuote.amountInMaximum !== undefined &&
        selectedBalance !== undefined &&
        swapQuote.amountInMaximum > selectedBalance
      ) {
        return `Paying with ${token.symbol} needs up to ${formatCurrency(swapQuote.amountInMaximum, { symbol: token.symbol, decimals: token.decimals })}; you hold ${formatCurrency(selectedBalance, { symbol: token.symbol, decimals: token.decimals })}${isNativeRouter ? " (keep a little aside for gas)" : ""}.`;
      }
    }
    return null;
  }, [
    s,
    amountInput,
    maxClaim,
    premium,
    balance,
    selectedBalance,
    symbol,
    decimals,
    token.symbol,
    token.decimals,
    isDirect,
    isWrap,
    isRouter,
    isNativeRouter,
    wrapDone,
    swapQuote.quoteFailed,
    swapQuote.amountInMaximum,
    swapSlippageInvalid,
  ]);

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Buying opens once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid market id" />;
  }
  if (isLoading) {
    return (
      <Card className="max-w-xl mx-auto">
        <LoadingSkeleton lines={5} />
      </Card>
    );
  }
  if (!s && rpcError) {
    return <RpcDownState />;
  }
  if (!s) {
    return <EmptyState title={`Market #${seriesId} not found`} />;
  }

  // Mirrors buyProtectionFor's own guards: window, not settled, not
  // cancelled, not paused (the chain would revert either way).
  const saleOpen = now <= s.saleEnd && !s.settled && !s.cancelled && !paused;
  const capacityLeft = s.escrow - s.sold;

  const needsApproval =
    maxPremium !== undefined &&
    allowance !== undefined &&
    allowance < maxPremium;
  const needsRouterApproval =
    isRouter &&
    !isNativeRouter &&
    swapQuote.amountInMaximum !== undefined &&
    (routerAllowance === undefined ||
      routerAllowance < swapQuote.amountInMaximum);
  const wrongNetwork = isConnected && walletChainId !== deployment.chainId;
  const busy =
    txBusy(approveTx.state) ||
    txBusy(buyTx.state) ||
    txBusy(wrapTx.state) ||
    txBusy(swapApproveTx.state) ||
    txBusy(swapBuyTx.state);

  const routeReady =
    !isRouter || swapQuote.amountInMaximum !== undefined;
  const canSubmit =
    saleOpen &&
    isConnected &&
    !wrongNetwork &&
    maxClaim !== null &&
    maxClaim > 0n &&
    maxPremium !== undefined &&
    routeReady &&
    validation === null &&
    !busy;

  // ---- token menu ----------------------------------------------------------
  const tokenOptions: TokenOption[] = tokens
    .filter(
      (t) =>
        t.route.kind !== "unroutable" ||
        (balances.byId[t.id] !== undefined && balances.byId[t.id]! > 0n),
    )
    .map((t) => {
      const bal = balances.byId[t.id];
      const zero = bal !== undefined && bal === 0n;
      return {
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        balanceLabel:
          bal === undefined
            ? "—"
            : formatCurrency(bal, {
                decimals: t.decimals,
                symbol: t.symbol,
                precision: 4,
              }),
        routeLabel: t.routeLabel || undefined,
        disabledReason:
          t.route.kind === "unroutable"
            ? t.route.reason
            : t.route.kind !== "direct" && zero
              ? `No ${t.symbol} balance`
              : undefined,
      };
    });

  function selectToken(tid: string) {
    const next = tokens.find((t) => t.id === tid);
    if (!next || next.route.kind === "unroutable") return;
    setPayTokenId(tid);
    setSwapSlippageInput("");
    resetFlow();
  }

  // ---- actions --------------------------------------------------------------
  async function onApprove() {
    if (maxPremium === undefined) return;
    const result = await approveTx.send(
      approveCurrencyRequest(deployment, maxPremium, address),
      { label: `Approve ${symbol}` },
    );
    if (result.status === "confirmed") refetchCurrency();
  }

  async function onBuy() {
    if (maxClaim === null || maxPremium === undefined) return;
    const result = await buyTx.send(
      buyProtectionRequest(
        deployment,
        BigInt(seriesId!),
        maxClaim,
        maxPremium,
        address,
      ),
      { label: "Buy protection" },
    );
    if (result.status === "confirmed") {
      refetchCurrency();
      refetchCover();
      balances.refetch();
    }
  }

  async function onWrap() {
    if (premium === undefined) return;
    const result = await wrapTx.send(
      wrapNativeRequest(deployment, premium, address),
      { label: `Wrap ${token.symbol}` },
    );
    if (result.status === "confirmed") {
      refetchCurrency();
      balances.refetch();
    }
  }

  async function onSwapApprove() {
    if (swapQuote.amountInMaximum === undefined) return;
    const result = await swapApproveTx.send(
      approveRouterRequest(deployment, token, swapQuote.amountInMaximum, address),
      { label: `Approve ${token.symbol}` },
    );
    if (result.status === "confirmed") refetchRouterAllowance();
  }

  async function onSwapBuy() {
    if (
      route.kind !== "router" ||
      maxClaim === null ||
      swapQuote.amountInMaximum === undefined
    )
      return;
    const result = await swapBuyTx.send(
      swapAndBuyRequest(
        deployment,
        route,
        swapQuote.amountInMaximum,
        BigInt(seriesId!),
        maxClaim,
        address,
        swapQuote.path,
      ),
      {
        label: `Buy protection with ${token.symbol}`,
        // Friendly swap-revert copy inline AND in the global toast.
        transformError: friendlySwapError,
      },
    );
    if (result.status === "confirmed") {
      refetchCurrency();
      refetchCover();
      balances.refetch();
    }
  }

  const fmtC = (wei: bigint | undefined) =>
    formatCurrency(wei, { symbol, decimals });
  const fmtT = (wei: bigint | undefined) =>
    formatCurrency(wei, { symbol: token.symbol, decimals: token.decimals });

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Get rent protection
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          You pay once, now. If the reported rent number rises past this
          market' trigger, you get paid — up to the amount you choose. If it
          doesn't, you owe nothing more.
        </p>
        <p className="font-parkBody text-xs text-surface-grey mt-1">
          Market #{seriesId} · price {formatBps(s.premiumRateBps)} of the
          amount you protect · pays in full at{" "}
          {formatCents(s.strikeHighCents)}/SF
        </p>
      </header>

      {!saleOpen ? (
        <EmptyState
          title={
            s.cancelled
              ? "Market cancelled"
              : s.settled
                ? "Market settled"
                : paused
                  ? "Sales paused"
                  : "Sale closed"
          }
        >
          {s.cancelled
            ? "The creator cancelled this market before anything was sold — nothing can be bought here anymore."
            : s.settled
              ? "This market has settled — the outcome is known, so protection can no longer be bought. You can still "
              : paused
                ? "The market creator has paused new purchases. Existing protection is unaffected — you can still "
                : "The sale window for this market ended. You can still "}
          {!s.cancelled ? (
            <>
              <Link className="underline" to={`/settle/${seriesId}`}>
                settle
              </Link>{" "}
              or{" "}
              <Link className="underline" to={`/redeem/${seriesId}`}>
                redeem
              </Link>
              .
            </>
          ) : null}
        </EmptyState>
      ) : (
        <Card>
          {fromWizard ? (
            <p
              className="mb-3 rounded-lg bg-paper-1 px-3 py-2 font-parkBody text-xs text-surface-grey-2"
              data-testid="wizard-prefill-note"
            >
              We filled this in from your answers — adjust anything freely.
            </p>
          ) : null}

          <label className="block">
            <span className="font-parkBody text-sm text-surface-grey-2">
              How much protection do you want? ({symbol})
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => {
                setAmountInput(e.target.value);
                resetFlow();
              }}
              placeholder="100"
              data-testid="buy-amount"
              className="mt-1 w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
            />
            <span className="mt-1 block font-parkBody text-xs text-surface-grey">
              This is the most you can be paid (your{" "}
              <Term tip="The largest payout this purchase can ever produce.">
                maximum payout
              </Term>
              ). Your one-time price is {formatBps(s.premiumRateBps)} of it.
            </span>
          </label>

          <div className="mt-4 border-t border-paper-1 pt-3">
            <StatRow label={`Your ${symbol} balance`} value={fmtC(balance)} />
            <StatRow label="Still available to buy" value={fmtC(capacityLeft)} />
            <StatRow
              label="Your price (paid once)"
              value={premium !== undefined ? fmtC(premium) : "—"}
            />
            {coverBalance !== undefined && coverBalance > 0n ? (
              <StatRow
                label="Protection you already hold"
                value={fmtC(coverBalance)}
              />
            ) : null}
          </div>

          <div className="mt-4">
            <PricingPanel
              premiumRateBps={s.premiumRateBps}
              maxClaimWei={maxClaim ?? 0n}
              decimals={decimals}
              symbol={symbol}
              strikeLowCents={s.strikeLowCents}
              strikeHighCents={s.strikeHighCents}
            />
          </div>

          <div className="mt-4 border-t border-paper-1 pt-3">
            <TokenSelect
              options={tokenOptions}
              value={token.id}
              onChange={selectToken}
            />

            {token.note && !isRouter ? (
              <p className="mt-2 font-parkBody text-xs text-surface-grey-2">
                {token.note}
              </p>
            ) : null}

            {isRouter ? (
              <div
                className="mt-3 rounded-lg border-2 border-paper-2 bg-paper-0 px-3 py-2"
                data-testid="swap-quote"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-block rounded-full bg-paper-1 px-2 py-0.5 font-parkBody text-xs font-bold text-text-standard">
                    via Uniswap v3
                  </span>
                  <span className="font-parkBody text-xs text-surface-grey-2">
                    {token.routeLabel}
                  </span>
                </div>
                {swapQuote.rpcError ? (
                  <p className="font-parkBody text-sm text-system-red">
                    Can't reach the RPC for a swap quote.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => swapQuote.refetch()}
                    >
                      Retry
                    </button>
                  </p>
                ) : (
                  <>
                    <StatRow
                      label="You pay ≈"
                      value={
                        swapQuote.amountIn !== undefined
                          ? fmtT(swapQuote.amountIn)
                          : swapQuote.isLoading
                            ? "getting a live price…"
                            : "—"
                      }
                    />
                    <StatRow
                      label="Never more than"
                      value={
                        swapQuote.amountInMaximum !== undefined
                          ? fmtT(swapQuote.amountInMaximum)
                          : "—"
                      }
                    />
                    <p className="font-parkBody text-xs text-surface-grey-2 mt-1">
                      One transaction converts your {token.symbol} into exactly{" "}
                      {premium !== undefined ? fmtC(premium) : "the price"} and
                      buys your protection; anything unused comes straight
                      back. The "never more than" cap includes a{" "}
                      {swapQuote.slippageBps} bps price-move allowance.
                    </p>
                    {swapQuote.usedFallback ? (
                      <p className="font-parkBody text-xs text-surface-grey-2 mt-1">
                        Using the backup 0.3% pool — the primary pool had no
                        price just now.
                      </p>
                    ) : null}
                    {token.note ? (
                      <p className="font-parkBody text-xs text-surface-grey-2 mt-1">
                        {token.note}
                      </p>
                    ) : null}
                  </>
                )}
                <details className="mt-1">
                  <summary className="cursor-pointer font-parkBody text-xs text-surface-grey-2">
                    Advanced: swap slippage
                  </summary>
                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={swapSlippageInput}
                      onChange={(e) => setSwapSlippageInput(e.target.value)}
                      placeholder={String(token.defaultSlippageBps)}
                      className="w-20 rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-2 py-1 font-parkBody text-sm bg-paper-0"
                      aria-label="Swap slippage in basis points"
                    />
                    <span className="font-parkBody text-xs text-surface-grey-2">
                      bps (default {token.defaultSlippageBps}) — how much the
                      market price may move before the purchase refuses to
                      overpay.
                    </span>
                  </label>
                </details>
              </div>
            ) : null}
          </div>

          {validation ? (
            <p
              className="mt-3 font-parkBody text-sm text-system-red font-bold"
              data-testid="buy-validation"
              role="alert"
            >
              {validation}
            </p>
          ) : null}

          {premium !== undefined && maxClaim !== null && validation === null ? (
            <div
              className="mt-4 rounded-xl border-2 border-core-green/40 bg-paper-0 px-4 py-3"
              data-testid="protection-summary"
            >
              <p className="font-parkBody text-sm font-bold text-text-standard">
                How you're protected
              </p>
              <ul className="mt-1 space-y-1 font-parkBody text-sm text-surface-grey-2 list-disc list-inside">
                <li>
                  You pay {fmtC(premium)} once
                  {isRouter && swapQuote.amountIn !== undefined
                    ? ` (≈ ${fmtT(swapQuote.amountIn)})`
                    : isWrap
                      ? ` (wrapped 1:1 from your ${token.symbol})`
                      : ""}
                  .
                </li>
                <li>
                  If the reported rent goes above{" "}
                  {formatCents(s.strikeLowCents)}/SF, you get paid — up to{" "}
                  {fmtC(maxClaim)}, claimable after{" "}
                  {formatDate(s.obsStart)}.
                </li>
                <li>
                  If it stays below {formatCents(s.strikeLowCents)}/SF, you get
                  nothing more and owe nothing.
                </li>
                <li>
                  Your payout is held in a contract nobody can pause or take
                  away.
                </li>
              </ul>
            </div>
          ) : null}

          <p
            className="mt-3 font-parkBody text-xs text-surface-grey"
            data-testid="index-disclosure"
          >
            This index tracks Manhattan office rent (commercial, not
            residential). Full details on the{" "}
            <Link className="underline" to={`/market/${seriesId}`}>
              market page
            </Link>{" "}
            and in the{" "}
            <Link className="underline" to="/docs">
              docs
            </Link>
            .
          </p>

          {!isConnected ? (
            <div className="mt-5 flex flex-col gap-3">
              <Button
                app="fund"
                onClick={() => openConnectModal?.()}
                data-testid="connect-cta"
              >
                Connect wallet to buy
              </Button>
            </div>
          ) : wrongNetwork ? (
            <div className="mt-5 flex flex-col gap-3">
              <p className="font-parkBody text-sm text-surface-grey-2">
                Your wallet is on a different network than {deployment.name}.
              </p>
              <Button
                app="fund"
                variant="secondary"
                disabled={switchPending}
                onClick={() => switchChain({ chainId: deployment.chainId })}
                data-testid="buy-switch-chain"
              >
                Switch wallet to {deployment.name}
              </Button>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              {isWrap && !wrapDone ? (
                <>
                  <p className="font-parkBody text-xs text-surface-grey-2">
                    Step 1 of {needsApproval ? 3 : 2}: wrap exactly your price
                    into {symbol} — same money, 1:1, no fee.
                  </p>
                  <Button
                    app="fund"
                    variant="secondary"
                    disabled={!canSubmit}
                    onClick={onWrap}
                    data-testid="wrap-button"
                  >
                    Wrap {premium !== undefined ? fmtT(premium) : token.symbol}
                  </Button>
                  <TxStatus state={wrapTx.state} label="Wrap" />
                </>
              ) : null}

              {(isDirect || (isWrap && wrapDone)) && !flowDone ? (
                <>
                  {needsApproval ? (
                    <>
                      <p className="font-parkBody text-xs text-surface-grey-2">
                        First confirmation: allow the protection contract to
                        take your one-time price — nothing moves yet.
                      </p>
                      <StatRow
                        label="Currently allowed"
                        value={`${fmtC(allowance)} — allowing ${fmtC(maxPremium)}`}
                      />
                      <Button
                        app="fund"
                        variant="secondary"
                        disabled={!canSubmit}
                        onClick={onApprove}
                        data-testid="approve-button"
                      >
                        Approve {symbol}
                      </Button>
                      <TxStatus state={approveTx.state} label="Approve" />
                    </>
                  ) : null}
                  <p className="font-parkBody text-xs text-surface-grey-2">
                    {needsApproval ? "Then the" : "One"} confirmation buys your
                    protection: it takes{" "}
                    {premium !== undefined ? fmtC(premium) : "your price"} and
                    locks in your payout rights.
                  </p>
                  <Button
                    app="fund"
                    disabled={!canSubmit || needsApproval}
                    onClick={onBuy}
                    data-testid="buy-button"
                  >
                    Buy protection
                  </Button>
                  <TxStatus state={buyTx.state} label="Buy" />
                </>
              ) : null}

              {isRouter && !flowDone ? (
                <>
                  {needsRouterApproval ? (
                    <>
                      <p className="font-parkBody text-xs text-surface-grey-2">
                        First confirmation: allow the swap contract to use your{" "}
                        {token.symbol} — nothing moves yet.
                      </p>
                      <Button
                        app="fund"
                        variant="secondary"
                        disabled={!canSubmit}
                        onClick={onSwapApprove}
                        data-testid="swap-approve-button"
                      >
                        Approve {token.symbol}
                      </Button>
                      <TxStatus state={swapApproveTx.state} label="Approve" />
                    </>
                  ) : null}
                  <p className="font-parkBody text-xs text-surface-grey-2">
                    {needsRouterApproval
                      ? "Then one confirmation does the rest:"
                      : "One confirmation does everything:"}{" "}
                    it converts your {token.symbol}, buys your protection and
                    returns anything unused
                    {isNativeRouter ? ` (as W${token.symbol})` : ""} — all in a
                    single transaction that either fully succeeds or fully
                    cancels.
                  </p>
                  <Button
                    app="fund"
                    disabled={!canSubmit || needsRouterApproval}
                    onClick={onSwapBuy}
                    data-testid="swap-buy-button"
                  >
                    Buy protection with {token.symbol}
                  </Button>
                  <TxStatus state={swapBuyTx.state} label="Buy" />
                </>
              ) : null}

              {flowDone ? (
                <p className="font-parkBody text-sm text-system-green">
                  Cover minted. You're protected — see{" "}
                  <Link
                    className="underline font-bold"
                    to={`/market/${seriesId}`}
                  >
                    market #{seriesId}
                  </Link>{" "}
                  or head to{" "}
                  <Link
                    className="underline font-bold"
                    to={`/redeem/${seriesId}`}
                  >
                    redeem
                  </Link>{" "}
                  once the rent number is in.
                </p>
              ) : null}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
