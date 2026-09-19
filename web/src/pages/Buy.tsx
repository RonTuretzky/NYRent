import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { formatUnits } from "viem";
import {
  useAccount,
  useCapabilities,
  useConfig,
  useSendCalls,
  useWaitForCallsStatus,
} from "wagmi";
import { waitForCallsStatus } from "wagmi/actions";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Button } from "@decentralpark/ui";
import { deployment, isDeployed } from "../chain/deployment";
import { erc20Abi, poolAbi } from "../chain/contracts";
import {
  useCoverBalance,
  useCurrencyMeta,
  usePoolStats,
  useQuote,
  useSeries,
  useUserCurrency,
} from "../chain/hooks";
import { useTx, type TxState } from "../chain/useTx";
import { decodeTxError, type DecodedTxError } from "../chain/errors";
import { pushTxToast, updateTxToast } from "../chain/txToasts";
import { txUrl } from "../chain/explorer";
import {
  PAYMENT_TOKENS,
  SWAP_ROUTER_02,
  buildBuyBatch,
  buildSwapTxRequest,
  friendlySwapError,
  supportsAtomicBatch,
  swapsAvailable,
  usePaymentBalances,
  useRouterAllowance,
  useSwapQuote,
  useWrapTx,
  type PaymentTokenId,
} from "../chain/swap";
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
  formatCurrency,
  nowSec,
  parseCurrency,
} from "../chain/format";

type StepId = "wrap" | "swap-approve" | "swap" | "pool-approve" | "buy";

function txBusy(state: TxState): boolean {
  return (
    state.status === "simulating" ||
    state.status === "wallet" ||
    state.status === "pending"
  );
}

export function Buy() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : undefined;
  const { series: s, isLoading, rpcError } = useSeries(seriesId);
  const { symbol, decimals } = useCurrencyMeta();
  const { stats } = usePoolStats();
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const config = useConfig();
  const { balance, allowance, refetch: refetchCurrency } = useUserCurrency();
  const { balance: coverBalance, refetch: refetchCover } =
    useCoverBalance(seriesId);

  const [amountInput, setAmountInput] = useState("");
  const [slippagePct, setSlippagePct] = useState("1");
  const [payToken, setPayToken] = useState<PaymentTokenId>("wxdai");
  const [swapSlippageInput, setSwapSlippageInput] = useState("");
  const [batchId, setBatchId] = useState<string | undefined>();
  const [batchError, setBatchError] = useState<DecodedTxError | undefined>();
  const [forceSequential, setForceSequential] = useState(false);

  const approveTx = useTx();
  const buyTx = useTx();
  const swapApproveTx = useTx();
  const swapTx = useTx();
  const wrapTx = useWrapTx();

  const token = PAYMENT_TOKENS[payToken];
  const isSwapRoute =
    token.route.kind === "single" || token.route.kind === "multi";

  const maxClaim = parseCurrency(amountInput, decimals);
  const premium = useQuote(seriesId, maxClaim, s?.premiumRateBps);

  const maxPremium = useMemo(() => {
    if (premium === undefined) return undefined;
    const pct = Number(slippagePct);
    if (!Number.isFinite(pct) || pct < 0) return undefined;
    return premium + (premium * BigInt(Math.round(pct * 100))) / 10_000n;
  }, [premium, slippagePct]);

  // Swap slippage: fixed per-token defaults, editable (bps) in the advanced
  // disclosure. Empty input = default.
  const swapSlippageTrimmed = swapSlippageInput.trim();
  const swapSlippageParsed =
    swapSlippageTrimmed === "" ? undefined : Number(swapSlippageTrimmed);
  const swapSlippageInvalid =
    swapSlippageParsed !== undefined &&
    (!Number.isFinite(swapSlippageParsed) ||
      swapSlippageParsed < 0 ||
      swapSlippageParsed > 1000);

  const swapQuote = useSwapQuote(
    payToken,
    premium,
    swapSlippageInvalid ? undefined : swapSlippageParsed,
  );
  const balances = usePaymentBalances(address);
  const { allowance: routerAllowance, refetch: refetchRouterAllowance } =
    useRouterAllowance(payToken, address);

  const capabilitiesQuery = useCapabilities({
    account: address,
    query: { enabled: isConnected && chainId === deployment.chainId },
  });
  const batchSupported = supportsAtomicBatch(
    capabilitiesQuery.data,
    deployment.chainId,
  );
  const { sendCallsAsync, isPending: sendCallsPending } = useSendCalls();
  const { data: callsStatus } = useWaitForCallsStatus({
    id: batchId,
    query: { enabled: !!batchId },
  });
  const batchStatus = batchId ? (callsStatus?.status ?? "pending") : undefined;

  // The batch TOAST is settled by a module-level waiter in onBatchBuy (like
  // useTx it outlives this component); this effect only refreshes the page's
  // own reads when the in-component wait sees success.
  useEffect(() => {
    if (batchStatus === "success") {
      refetchCurrency();
      refetchCover();
      balances.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchStatus]);

  const now = nowSec();
  const wxdaiBalance = balances.wxdai ?? balance;
  const selectedTokenBalance =
    payToken === "xdai"
      ? balances.native
      : payToken === "usdce"
        ? balances.usdce
        : payToken === "gno"
          ? balances.gno
          : wxdaiBalance;

  const flowDone =
    buyTx.state.status === "confirmed" || batchStatus === "success";

  // ---- funding progress -----------------------------------------------------
  // Once the premium sits in the wallet as WXDAI — because the wrap/swap step
  // confirmed, or because the user held enough WXDAI all along — the input
  // token stops mattering: the spent input balance and the (re-quoted) swap
  // route must no longer gate the remaining pool-approve/buy steps.
  const fundingTxRan =
    wrapTx.state.status === "confirmed" || swapTx.state.status === "confirmed";
  const premiumCovered =
    premium !== undefined &&
    wxdaiBalance !== undefined &&
    wxdaiBalance >= premium;
  const fundingDone = fundingTxRan || premiumCovered || flowDone;

  // ---- client-side validation (SPEC: > balance, > capacity, > maxPremium) --
  const validation = useMemo<string | null>(() => {
    if (!s) return null;
    if (amountInput.trim() === "") return null;
    if (maxClaim === null) return "Enter a valid decimal amount.";
    if (maxClaim <= 0n) return "Amount must be greater than zero.";
    const remainingCapacity = s.capacity - s.sold;
    if (maxClaim > remainingCapacity) {
      return `Exceeds remaining capacity of ${formatCurrency(remainingCapacity, { symbol, decimals })}.`;
    }
    if (stats.freeCapital !== undefined && premium !== undefined) {
      // issuance must keep Σ reserved ≤ balance after collecting the premium
      const headroom = stats.freeCapital + premium;
      if (maxClaim > headroom) {
        return `Exceeds pool solvency headroom of ${formatCurrency(headroom, { symbol, decimals })} — the sponsor must fund more capital first.`;
      }
    }
    if (payToken === "wxdai") {
      if (
        premium !== undefined &&
        balance !== undefined &&
        premium > balance
      ) {
        return `Premium ${formatCurrency(premium, { symbol, decimals })} exceeds your balance of ${formatCurrency(balance, { symbol, decimals })}.`;
      }
    } else if (fundingDone) {
      // The premium was already converted into WXDAI (or was held all along):
      // only WXDAI-side coverage gates the remaining steps. The single edge
      // worth flagging is the funded WXDAI leaving the wallet again.
      if (
        !flowDone &&
        premium !== undefined &&
        wxdaiBalance !== undefined &&
        premium > wxdaiBalance
      ) {
        return `Premium ${formatCurrency(premium, { symbol, decimals })} exceeds your ${symbol} balance of ${formatCurrency(wxdaiBalance, { symbol, decimals })} — the funded ${symbol} is no longer in this wallet.`;
      }
    } else if (payToken === "xdai") {
      if (
        premium !== undefined &&
        balances.native !== undefined &&
        premium > balances.native
      ) {
        return `Premium ${formatCurrency(premium, { symbol: "xDAI", decimals })} exceeds your xDAI balance of ${formatCurrency(balances.native, { symbol: "xDAI", decimals })}.`;
      }
    } else {
      if (swapSlippageInvalid) {
        return "Swap slippage must be between 0 and 1000 bps.";
      }
      if (swapQuote.quoteFailed) {
        return `No executable Uniswap route for ${token.symbol} right now — try another payment token.`;
      }
      if (
        swapQuote.amountInMaximum !== undefined &&
        selectedTokenBalance !== undefined &&
        swapQuote.amountInMaximum > selectedTokenBalance
      ) {
        return `Paying with ${token.symbol} needs up to ${formatCurrency(swapQuote.amountInMaximum, { symbol: token.symbol, decimals: token.decimals })}; you hold ${formatCurrency(selectedTokenBalance, { symbol: token.symbol, decimals: token.decimals })}.`;
      }
    }
    if (maxPremium === undefined) {
      return "Enter a valid slippage percentage.";
    }
    return null;
  }, [
    s,
    amountInput,
    maxClaim,
    premium,
    maxPremium,
    balance,
    stats.freeCapital,
    symbol,
    decimals,
    payToken,
    token.symbol,
    token.decimals,
    balances.native,
    selectedTokenBalance,
    swapQuote.quoteFailed,
    swapQuote.amountInMaximum,
    swapSlippageInvalid,
    fundingDone,
    flowDone,
    wxdaiBalance,
  ]);

  if (!isDeployed) {
    return (
      <EmptyState title="Not deployed yet">
        Buying opens once contracts are live.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid series id" />;
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
    return <EmptyState title={`Series #${seriesId} not found`} />;
  }

  // Mirrors buyProtection's own guards: time window AND not settled AND not paused
  // (buying a settled series is buying a known outcome — the chain reverts either way).
  const saleOpen = now <= s.saleEnd && !s.settled && stats.salesPaused !== true;
  const needsApproval =
    maxPremium !== undefined &&
    allowance !== undefined &&
    allowance < maxPremium;
  const needsSwapApproval =
    isSwapRoute &&
    swapQuote.amountInMaximum !== undefined &&
    (routerAllowance === undefined ||
      routerAllowance < swapQuote.amountInMaximum);
  const wrongNetwork = isConnected && chainId !== deployment.chainId;
  const busy =
    txBusy(approveTx.state) ||
    txBusy(buyTx.state) ||
    txBusy(swapApproveTx.state) ||
    txBusy(swapTx.state) ||
    txBusy(wrapTx.state) ||
    sendCallsPending ||
    batchStatus === "pending";

  // A live route quote is only required while the funding step is still
  // ahead; once the WXDAI premium is in the wallet the buy stands alone.
  const swapReady =
    !isSwapRoute || fundingDone || swapQuote.amountInMaximum !== undefined;
  const canSubmit =
    saleOpen &&
    isConnected &&
    !wrongNetwork &&
    maxClaim !== null &&
    maxClaim > 0n &&
    maxPremium !== undefined &&
    swapReady &&
    validation === null &&
    !busy;

  // ---- multi-step flow model (non-WXDAI tokens) ---------------------------
  const wrapDone = fundingDone;
  // fundingDone also pins the approve step: post-swap the router allowance
  // may drop below a FRESH quote, which must not bounce the flow backwards.
  const swapApproveDone =
    swapApproveTx.state.status === "confirmed" ||
    (isSwapRoute && (fundingDone || !needsSwapApproval));
  const swapDone = fundingDone;
  const poolApproveDone = approveTx.state.status === "confirmed" || !needsApproval;

  const useBatchUi =
    payToken !== "wxdai" && batchSupported && !forceSequential;

  // In the sequential stepper an auto-satisfied funding step (no wrap/swap
  // ever ran — the wallet simply held enough WXDAI) is shown as explicitly
  // skipped, not as a swap that supposedly happened. The batch list keeps the
  // real labels: the atomic batch genuinely executes the wrap/swap.
  const stepperSkipsFunding = fundingDone && !fundingTxRan && !useBatchUi;

  const flowSteps: { id: StepId; label: string; done: boolean }[] = [];
  if (payToken === "xdai") {
    flowSteps.push({
      id: "wrap",
      label: stepperSkipsFunding
        ? `You already hold enough ${symbol} — no wrap needed`
        : `Wrap ${premium !== undefined ? formatCurrency(premium, { symbol: "xDAI", decimals }) : "the premium"} into ${symbol}`,
      done: wrapDone,
    });
  } else if (isSwapRoute) {
    if (stepperSkipsFunding) {
      flowSteps.push({
        id: "swap",
        label: `You already hold the premium in ${symbol} — no swap needed`,
        done: true,
      });
    } else {
      flowSteps.push({
        id: "swap-approve",
        label: `Approve ${token.symbol} for the Uniswap router`,
        done: swapApproveDone,
      });
      flowSteps.push({
        id: "swap",
        label: `Swap ${token.symbol} → ${symbol} (exact output)`,
        done: swapDone,
      });
    }
  }
  if (payToken !== "wxdai") {
    flowSteps.push({
      id: "pool-approve",
      label: `Approve ${symbol} premium for the pool`,
      done: poolApproveDone,
    });
    flowSteps.push({ id: "buy", label: "Buy protection", done: flowDone });
  }
  const currentStepId = flowSteps.find((st) => !st.done)?.id;

  // ---- token menu ---------------------------------------------------------
  const balanceLabel = (v: bigint | undefined, dec: number, sym: string) =>
    v === undefined
      ? "—"
      : formatCurrency(v, { decimals: dec, symbol: sym, precision: 4 });
  const zeroReason = (v: bigint | undefined, sym: string) =>
    v !== undefined && v === 0n ? `No ${sym} balance` : undefined;

  const tokenOptions: TokenOption[] = [
    {
      id: "wxdai",
      symbol: PAYMENT_TOKENS.wxdai.symbol,
      name: PAYMENT_TOKENS.wxdai.name,
      balanceLabel: balanceLabel(wxdaiBalance, 18, "WXDAI"),
      routeLabel: PAYMENT_TOKENS.wxdai.routeLabel,
    },
    {
      id: "xdai",
      symbol: PAYMENT_TOKENS.xdai.symbol,
      name: PAYMENT_TOKENS.xdai.name,
      balanceLabel: balanceLabel(balances.native, 18, "xDAI"),
      routeLabel: PAYMENT_TOKENS.xdai.routeLabel,
      disabledReason: zeroReason(balances.native, "xDAI"),
    },
  ];
  if (swapsAvailable) {
    tokenOptions.push(
      {
        id: "usdce",
        symbol: PAYMENT_TOKENS.usdce.symbol,
        name: PAYMENT_TOKENS.usdce.name,
        balanceLabel: balanceLabel(balances.usdce, 6, "USDC.e"),
        routeLabel: PAYMENT_TOKENS.usdce.routeLabel,
        disabledReason: zeroReason(balances.usdce, "USDC.e"),
      },
      {
        id: "gno",
        symbol: PAYMENT_TOKENS.gno.symbol,
        name: PAYMENT_TOKENS.gno.name,
        balanceLabel: balanceLabel(balances.gno, 18, "GNO"),
        routeLabel: PAYMENT_TOKENS.gno.routeLabel,
        disabledReason: zeroReason(balances.gno, "GNO"),
      },
    );
    if (balances.oldUsdc !== undefined && balances.oldUsdc > 0n) {
      tokenOptions.push({
        id: "old-usdc",
        symbol: "USDC (old)",
        name: "Legacy bridged USDC",
        balanceLabel: balanceLabel(balances.oldUsdc, 6, "USDC"),
        disabledReason: "No Uniswap route — migrate to USDC.e",
      });
    }
  }

  const effectiveRate =
    swapQuote.amountIn !== undefined && premium !== undefined && premium > 0n
      ? Number(formatUnits(swapQuote.amountIn, token.decimals)) /
        Number(formatUnits(premium, decimals))
      : undefined;

  const batchReceiptHash =
    callsStatus?.receipts && callsStatus.receipts.length > 0
      ? callsStatus.receipts[callsStatus.receipts.length - 1].transactionHash
      : undefined;

  function resetFlow() {
    approveTx.reset();
    buyTx.reset();
    swapApproveTx.reset();
    swapTx.reset();
    wrapTx.reset();
    setBatchId(undefined);
    setBatchError(undefined);
  }

  function selectToken(id: string) {
    if (id === "wxdai" || id === "xdai" || id === "usdce" || id === "gno") {
      setPayToken(id);
      setSwapSlippageInput("");
      setForceSequential(false);
      resetFlow();
    }
  }

  function switchToSequential() {
    setForceSequential(true);
    setBatchId(undefined);
    setBatchError(undefined);
  }

  async function onApprove() {
    if (maxPremium === undefined) return;
    const result = await approveTx.send(
      {
        abi: erc20Abi,
        address: deployment.currency,
        functionName: "approve",
        args: [deployment.pool, maxPremium],
        account: address,
      },
      { label: `Approve ${symbol}` },
    );
    if (result.status === "confirmed") refetchCurrency();
  }

  async function onBuy() {
    if (maxClaim === null || maxPremium === undefined) return;
    const result = await buyTx.send(
      {
        abi: poolAbi,
        address: deployment.pool,
        functionName: "buyProtection",
        args: [BigInt(seriesId!), maxClaim, maxPremium],
        account: address,
      },
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
    const result = await wrapTx.wrap(premium, address);
    if (result.status === "confirmed") {
      refetchCurrency();
      balances.refetch();
    }
  }

  async function onSwapApprove() {
    if (swapQuote.amountInMaximum === undefined || !token.address) return;
    const result = await swapApproveTx.send(
      {
        abi: erc20Abi,
        address: token.address,
        functionName: "approve",
        args: [SWAP_ROUTER_02, swapQuote.amountInMaximum],
        account: address,
      },
      { label: `Approve ${token.symbol} for swap` },
    );
    if (result.status === "confirmed") refetchRouterAllowance();
  }

  async function onSwap() {
    if (
      premium === undefined ||
      swapQuote.amountInMaximum === undefined ||
      !address
    )
      return;
    const result = await swapTx.send(
      buildSwapTxRequest(payToken, premium, swapQuote.amountInMaximum, address),
      {
        label: `Swap ${token.symbol} → ${symbol}`,
        // Same friendly router-revert copy inline AND in the global toast.
        transformError: friendlySwapError,
      },
    );
    if (result.status === "confirmed") {
      refetchCurrency();
      balances.refetch();
    }
  }

  async function onBatchBuy() {
    if (
      premium === undefined ||
      maxPremium === undefined ||
      maxClaim === null ||
      !address
    )
      return;
    setBatchError(undefined);
    try {
      const calls = buildBuyBatch({
        tokenId: payToken,
        premiumWei: premium,
        maxPremium,
        amountInMaximum: swapQuote.amountInMaximum,
        recipient: address,
        seriesId: BigInt(seriesId!),
        maxClaim,
        needsPoolApproval: needsApproval || allowance === undefined,
        needsSwapApproval,
      });
      const { id: callsId } = await sendCallsAsync({
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })),
        forceAtomic: true,
      });
      setBatchId(callsId);
      const toastId = pushTxToast({
        label: `Buy protection with ${token.symbol} (batch)`,
        status: "pending",
      });
      // Settle the toast from a module-level waiter (wagmi ACTION, not the
      // mounted hook): like useTx's wait promise it survives navigation and
      // resetFlow, so the pending toast can't be orphaned by an unmount.
      void waitForCallsStatus(config, { id: callsId, timeout: 120_000 })
        .then((status) => {
          const receipts = status.receipts;
          const minedHash =
            receipts && receipts.length > 0
              ? receipts[receipts.length - 1].transactionHash
              : undefined;
          if (status.status === "success") {
            updateTxToast(toastId, { status: "confirmed", hash: minedHash });
          } else if (status.status === "failure") {
            updateTxToast(toastId, {
              status: "failed",
              error: "The batch failed — no step was executed.",
            });
          }
        })
        .catch(() => {
          updateTxToast(toastId, {
            error:
              "Lost contact while waiting for the batch — it may still confirm. Check your wallet's activity.",
          });
        });
    } catch (error) {
      setBatchError(friendlySwapError(decodeTxError(error)));
    }
  }

  const stepAction: Record<
    StepId,
    { onClick: () => void; buttonLabel: string; state: TxState }
  > = {
    wrap: { onClick: onWrap, buttonLabel: "Wrap xDAI", state: wrapTx.state },
    "swap-approve": {
      onClick: onSwapApprove,
      buttonLabel: `Approve ${token.symbol}`,
      state: swapApproveTx.state,
    },
    swap: {
      onClick: onSwap,
      buttonLabel: "Swap via Uniswap v3",
      state: swapTx.state,
    },
    "pool-approve": {
      onClick: onApprove,
      buttonLabel: `Approve ${symbol}`,
      state: approveTx.state,
    },
    buy: { onClick: onBuy, buttonLabel: "Buy protection", state: buyTx.state },
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Buy protection · series #{seriesId}
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Pay a {formatBps(s.premiumRateBps)} premium, receive cover tokens
          redeemable for maxClaim × settlement ratio.
        </p>
      </header>

      {!saleOpen ? (
        <EmptyState
          title={
            s.settled
              ? "Series settled"
              : stats.salesPaused
                ? "Sales paused"
                : "Sale closed"
          }
        >
          {s.settled
            ? "This series has settled — the outcome is known, so protection can no longer be bought. You can still "
            : stats.salesPaused
              ? "The sponsor has paused new sales. Existing cover is unaffected — you can still "
              : "The sale window for this series ended. You can still "}{" "}
          <Link className="underline" to={`/settle/${seriesId}`}>
            settle
          </Link>{" "}
          or{" "}
          <Link className="underline" to={`/redeem/${seriesId}`}>
            redeem
          </Link>
          .
        </EmptyState>
      ) : (
        <Card>
          <label className="block">
            <span className="font-parkBody text-sm text-surface-grey-2">
              Max claim ({symbol})
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(e) => {
                setAmountInput(e.target.value);
                resetFlow();
              }}
              placeholder="0.001"
              data-testid="buy-amount"
              className="mt-1 w-full rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-3 py-2 font-parkBody bg-paper-0"
            />
            <span className="mt-1 block font-parkBody text-xs text-surface-grey">
              1 cover unit per wei of claim — you enter whole {symbol}.
            </span>
          </label>
          <div className="mt-3 flex items-center gap-2">
            <span className="font-parkBody text-sm text-surface-grey-2">
              Premium slippage allowance
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
              className="w-16 rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-2 py-1 font-parkBody text-sm bg-paper-0"
              aria-label="Slippage percent"
            />
            <span className="font-parkBody text-sm text-surface-grey-2">%</span>
          </div>

          <div className="mt-4 border-t border-paper-1 pt-3">
            <StatRow
              label="Your balance"
              value={formatCurrency(balance, { symbol, decimals })}
            />
            <StatRow
              label="Remaining capacity"
              value={formatCurrency(s.capacity - s.sold, { symbol, decimals })}
            />
            <StatRow
              label="Quoted premium"
              value={
                premium !== undefined
                  ? formatCurrency(premium, { symbol, decimals })
                  : "—"
              }
            />
            <StatRow
              label="Max premium (with slippage)"
              value={
                maxPremium !== undefined
                  ? formatCurrency(maxPremium, { symbol, decimals })
                  : "—"
              }
            />
            {coverBalance !== undefined && coverBalance > 0n ? (
              <StatRow
                label="Cover you already hold"
                value={formatCurrency(coverBalance, { symbol, decimals })}
              />
            ) : null}
          </div>

          <PricingPanel
            premiumRateBps={s.premiumRateBps}
            maxClaimWei={maxClaim ?? 0n}
            decimals={decimals}
            symbol={symbol}
            strikeLowCents={s.strikeLowCents}
            strikeHighCents={s.strikeHighCents}
          />

          <div className="mt-4 border-t border-paper-1 pt-3">
            <TokenSelect
              options={tokenOptions}
              value={payToken}
              onChange={selectToken}
            />

            {payToken === "xdai" ? (
              <p className="mt-2 font-parkBody text-xs text-surface-grey-2">
                {symbol} is wrapped xDAI — wrapping is 1:1 with no swap fee.
                Keep a little xDAI unwrapped for gas.
              </p>
            ) : null}

            {isSwapRoute ? (
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
                          ? formatCurrency(swapQuote.amountIn, {
                              symbol: token.symbol,
                              decimals: token.decimals,
                            })
                          : swapQuote.isLoading
                            ? "quoting…"
                            : "—"
                      }
                    />
                    <StatRow
                      label={`Max input (${swapQuote.slippageBps} bps slippage)`}
                      value={
                        swapQuote.amountInMaximum !== undefined
                          ? formatCurrency(swapQuote.amountInMaximum, {
                              symbol: token.symbol,
                              decimals: token.decimals,
                            })
                          : "—"
                      }
                    />
                    <StatRow
                      label="Rate"
                      value={
                        effectiveRate !== undefined
                          ? `1 ${symbol} ≈ ${effectiveRate.toFixed(4)} ${token.symbol}`
                          : "—"
                      }
                    />
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
                      bps (default {token.defaultSlippageBps})
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
          ) : (
          <div className="mt-5 flex flex-col gap-3">
            {payToken === "wxdai" ? (
              <>
                {needsApproval ? (
                  <>
                    <StatRow
                      label="Current allowance"
                      value={`${formatCurrency(allowance, { symbol, decimals })} — approving ${formatCurrency(maxPremium, { symbol, decimals })}`}
                    />
                    <Button
                      app="fund"
                      variant="secondary"
                      disabled={!canSubmit}
                      onClick={onApprove}
                      data-testid="approve-button"
                    >
                      1 · Approve {symbol}
                    </Button>
                    <TxStatus state={approveTx.state} label="Approve" />
                  </>
                ) : null}
                <Button
                  app="fund"
                  disabled={!canSubmit || needsApproval}
                  onClick={onBuy}
                  data-testid="buy-button"
                >
                  {needsApproval ? "2 · " : ""}Buy protection
                </Button>
                <TxStatus state={buyTx.state} label="Buy" />
              </>
            ) : useBatchUi ? (
              <>
                <ol className="space-y-1" data-testid="batch-steps">
                  {flowSteps.map((st, i) => (
                    <li
                      key={st.id}
                      className="font-parkBody text-sm text-surface-grey-2 flex items-center gap-2"
                    >
                      <span
                        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${
                          batchStatus === "success"
                            ? "bg-system-green text-white"
                            : "bg-paper-1 text-text-standard"
                        }`}
                      >
                        {batchStatus === "success" ? "✓" : i + 1}
                      </span>
                      {st.label}
                    </li>
                  ))}
                </ol>
                <Button
                  app="fund"
                  disabled={!canSubmit}
                  onClick={onBatchBuy}
                  data-testid="batch-buy-button"
                >
                  Buy with {token.symbol} — one confirmation
                </Button>
                {batchStatus === "pending" ? (
                  <p
                    className="font-parkBody text-sm text-primary-sky"
                    data-testid="batch-pending"
                  >
                    Batch submitted — waiting for confirmation…
                  </p>
                ) : null}
                {batchStatus === "success" && batchReceiptHash ? (
                  <p className="font-parkBody text-sm text-system-green">
                    Batch confirmed —{" "}
                    <a
                      href={txUrl(batchReceiptHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-dotted"
                    >
                      view transaction
                    </a>
                  </p>
                ) : null}
                {batchStatus === "failure" ? (
                  <p
                    className="font-parkBody text-sm text-system-red"
                    role="alert"
                  >
                    The batch failed — it is atomic, so no step was executed.
                    Try again, or{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={switchToSequential}
                    >
                      run the steps one by one
                    </button>
                    .
                  </p>
                ) : null}
                {batchError ? (
                  <TxStatus
                    state={{ status: "reverted", error: batchError }}
                    label="Batch"
                  />
                ) : null}
                <button
                  type="button"
                  className="self-start font-parkBody text-xs text-surface-grey-2 underline"
                  onClick={switchToSequential}
                >
                  Prefer separate transactions? Use the step-by-step flow.
                </button>
              </>
            ) : (
              <ol className="space-y-3" data-testid="buy-stepper">
                {flowSteps.map((st, i) => {
                  const action = stepAction[st.id];
                  const isCurrent = st.id === currentStepId && !flowDone;
                  return (
                    <li key={st.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 font-parkBody text-sm">
                        <span
                          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                            st.done
                              ? "bg-system-green text-white"
                              : isCurrent
                                ? "bg-core-green text-white"
                                : "bg-paper-1 text-surface-grey-2"
                          }`}
                        >
                          {st.done ? "✓" : i + 1}
                        </span>
                        <span
                          className={
                            st.done
                              ? "text-surface-grey-2 line-through"
                              : "text-text-standard"
                          }
                        >
                          {st.label}
                        </span>
                      </div>
                      {isCurrent && st.id === "pool-approve" ? (
                        <StatRow
                          label="Current allowance"
                          value={`${formatCurrency(allowance, { symbol, decimals })}${maxPremium !== undefined ? ` — approving ${formatCurrency(maxPremium, { symbol, decimals })}` : ""}`}
                        />
                      ) : null}
                      {isCurrent ? (
                        <Button
                          app="fund"
                          variant={st.id === "buy" ? undefined : "secondary"}
                          disabled={!canSubmit}
                          onClick={action.onClick}
                          data-testid={`step-${st.id}-button`}
                        >
                          {action.buttonLabel}
                        </Button>
                      ) : null}
                      <TxStatus state={action.state} />
                    </li>
                  );
                })}
              </ol>
            )}

            {flowDone ? (
              <p className="font-parkBody text-sm text-system-green">
                Cover minted. See{" "}
                <Link className="underline font-bold" to={`/series/${seriesId}`}>
                  series #{seriesId}
                </Link>{" "}
                or head to{" "}
                <Link className="underline font-bold" to={`/redeem/${seriesId}`}>
                  redeem
                </Link>{" "}
                after settlement.
              </p>
            ) : null}
          </div>
          )}
        </Card>
      )}
    </div>
  );
}
