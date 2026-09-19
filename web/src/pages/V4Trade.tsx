import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useAccount, usePublicClient, useSwitchChain } from "wagmi";
import { erc20Abi, formatUnits, parseUnits, type Address, type Abi } from "viem";
import { Button } from "@decentralpark/ui";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { chainById } from "../chain/wagmi";
import { Card } from "../components/States";
import { TxStatus } from "../components/TxStatus";
import { useTx } from "../chain/useTx";
import { useV4Market, v4QuoterAbi, v4StateAbi } from "../chain/v4";
import { RentV4MarketAbi, RentV4RouterAbi } from "../chain/v4Abi";
import { fullRangeAmounts, quoteFullRangeDeposit, FULL_RANGE_LOWER, FULL_RANGE_UPPER, LIQUIDITY_SLIPPAGE_BPS, minimumOutput, quotePriceImpact, spotOutput, rentSpotPrice, MAX_TRADE_PRICE_IMPACT_BPS, type FullRangeDeposit } from "../chain/v4Math";

export type V4Mode = "trade" | "underwrite" | "redeem";
const U128_MAX = 2n ** 128n - 1n;
function units(text: string, decimals: number): bigint {
  try {
    if (!/^\d+(?:\.\d*)?$/.test(text) || (text.split(".")[1]?.length ?? 0) > decimals) return 0n;
    const amount = parseUnits(text, decimals);
    return amount > U128_MAX ? 0n : amount;
  } catch { return 0n; }
}
function short(n: bigint, decimals: number): string {
  return Number(formatUnits(n, decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}
function exactAmount(n: bigint, decimals: number): string {
  const [integer, fraction] = formatUnits(n, decimals).split(".");
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

/** The key discards transaction form state when the selected chain/market changes. */
export function V4Trade({ mode = "trade" }: { mode?: V4Mode }) {
  const market = useV4Market();
  if (!market.deployment) return <Card><h1 className="font-bold text-2xl">Trading pool unavailable</h1><p>A RENT trading pool has not been deployed on this network. The current fixed-price market remains available.</p></Card>;
  if (!market.data) return <Card><p role="status">{market.isError ? "Could not read the trading market. Please retry before making a transaction." : "Reading the trading market…"}</p></Card>;
  return <V4Panel key={`${market.deployment.chainId}:${market.deployment.market}:${mode}`} mode={mode} />;
}

function V4Panel({ mode }: { mode: V4Mode }) {
  const market = useV4Market();
  const d = market.deployment!;
  const m = market.data!;
  const { address, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId: d.chainId });
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending: switchingChain } = useSwitchChain();
  const networkName = chainById(d.chainId)?.name ?? `Chain ${d.chainId}`;
  const nativeSymbol = chainById(d.chainId)?.nativeCurrency.symbol ?? "native currency";
  const smallMarket = m.supply < parseUnits("10", d.decimals);
  const queryClient = useQueryClient();
  const tx = useTx();
  const [buyRent, setBuyRent] = useState(true);
  const [amount, setAmount] = useState(mode === "trade" && smallMarket ? "0.01" : "1");
  const [rentBudget, setRentBudget] = useState("1");
  const [lockedDeposit, setLockedDeposit] = useState<FullRangeDeposit | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [search] = useSearchParams();
  const targetRent = units(search.get("amount") ?? "", d.decimals);
  const [prefilled, setPrefilled] = useState(false);
  const [amountEdited, setAmountEdited] = useState(false);
  const amountIn = units(amount, d.decimals);
  const rentMaximum = units(rentBudget, d.decimals);
  const rentIs0 = d.poolKey.currency0.toLowerCase() === d.market.toLowerCase();
  const liquidityDeposit = lockedDeposit ?? quoteFullRangeDeposit(m.sqrtPriceX96, rentMaximum, rentIs0);
  const inputToken = buyRent ? d.currency : d.market;
  const zeroForOne = inputToken.toLowerCase() === d.poolKey.currency0.toLowerCase();
  const targetExceedsSupply = targetRent > m.supply;
  const targetQuote = useQuery({
    queryKey: ["v4-target-quote", d.chainId, d.market, targetRent.toString()],
    enabled: mode === "trade" && buyRent && targetRent > 0n && !!client && m.tradingOpen && m.liquidity > 0n && !prefilled && !amountEdited && !targetExceedsSupply,
    retry: false,
    queryFn: async () => {
      const result = await client!.simulateContract({ address: d.quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: [{ poolKey: d.poolKey, zeroForOne: d.currency.toLowerCase() === d.poolKey.currency0.toLowerCase(), exactAmount: targetRent, hookData: "0x" }] });
      return result.result[0];
    },
  });
  useEffect(() => {
    if (targetQuote.data && !prefilled && !amountEdited) { setAmount(formatUnits(targetQuote.data, d.decimals)); setPrefilled(true); }
  }, [targetQuote.data, prefilled, amountEdited, d.decimals]);
  const quote = useQuery({
    queryKey: ["v4-quote", d.chainId, d.market, buyRent, amountIn.toString()],
    enabled: mode === "trade" && !!client && amountIn > 0n && m.tradingOpen && m.liquidity > 0n,
    refetchInterval: 10000,
    retry: false,
    queryFn: async () => {
      // Compare the order against the price from the same block as its quote.
      const blockNumber = await client!.getBlockNumber({ cacheTime: 0 });
      const [result, slot] = await Promise.all([
        client!.simulateContract({ address: d.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", blockNumber,
          args: [{ poolKey: d.poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" }] }),
        client!.readContract({ address: d.stateView, abi: v4StateAbi, functionName: "getSlot0", args: [m.poolId], blockNumber }),
      ]);
      return { amountOut: result.result[0], sqrtPriceX96: slot[0], quotedAt: Date.now() };
    },
  });
  const currentQuote = quote.isError ? undefined : quote.data;
  const currentSqrt = currentQuote?.sqrtPriceX96 ?? m.sqrtPriceX96;
  const currentPrice = rentSpotPrice(currentSqrt, d.poolKey, d.market);
  const atSpot = spotOutput(amountIn, currentSqrt, zeroForOne);
  const impact = currentQuote ? quotePriceImpact(amountIn, currentQuote.amountOut, currentSqrt, zeroForOne) : undefined;
  const outputSymbol = buyRent ? "RENT" : d.symbol;
  const averagePrice = currentQuote && currentQuote.amountOut > 0n && amountIn > 0n
    ? buyRent ? Number(amountIn) / Number(currentQuote.amountOut) : Number(currentQuote.amountOut) / Number(amountIn)
    : null;
  const highImpact = impact?.bps !== null && impact?.bps !== undefined && impact.bps > MAX_TRADE_PRICE_IMPACT_BPS;
  const wallet = useQuery({
    queryKey: ["v4-wallet", d.chainId, d.market, address],
    enabled: !!address && !!client,
    refetchInterval: 10000,
    queryFn: async () => {
      const [rent, cash, residual, shares, liquidity, native] = await Promise.all([
        client!.readContract({ address: d.market, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.readContract({ address: d.currency, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.readContract({ address: d.market, abi: RentV4MarketAbi, functionName: "residualOf", args: [address!] }),
        client!.readContract({ address: d.market, abi: RentV4MarketAbi, functionName: "residualShares", args: [address!] }),
        client!.readContract({ address: d.router, abi: RentV4RouterAbi, functionName: "liquidityOf", args: [address!, d.market, FULL_RANGE_LOWER, FULL_RANGE_UPPER] }),
        client!.getBalance({ address: address! }),
      ]);
      return { rent, cash, residual, shares, liquidity, native };
    },
  });
  useEffect(() => { setError(""); tx.reset(); }, [address, buyRent]); // eslint-disable-line react-hooks/exhaustive-deps
  const connected = !!address && walletChainId === d.chainId;
  const busy = working || ["wallet", "pending", "simulating", "stillPending"].includes(tx.state.status);
  const ready = connected && !busy && !market.isError && !wallet.isError && !!wallet.data && wallet.data.native > 0n;
  const paySymbol = buyRent ? d.symbol : "RENT";
  const payBalance = wallet.data ? buyRent ? wallet.data.cash : wallet.data.rent : undefined;
  const insufficientFunds = payBalance !== undefined && amountIn > payBalance;
  const liquidityRentShortfall = wallet.data && liquidityDeposit && wallet.data.rent < liquidityDeposit.rentMaximum ? liquidityDeposit.rentMaximum - wallet.data.rent : 0n;
  const liquidityCashShortfall = wallet.data && liquidityDeposit && wallet.data.cash < liquidityDeposit.cashMaximum ? liquidityDeposit.cashMaximum - wallet.data.cash : 0n;
  const inputClass = "w-full min-w-0 min-h-12 rounded-lg border border-paper-2 bg-paper-0 p-3 font-parkBody text-base";

  async function send(target: Address, abi: Abi, functionName: string, args: readonly unknown[], label: string) {
    const result = await tx.send({ address: target, abi, functionName, args, chainId: d.chainId, account: address }, { label });
    if (result.status !== "confirmed") throw new Error(result.status === "stillPending" ? "Transaction is still pending. Check its receipt before retrying." : "Transaction was not completed.");
  }
  async function approve(token: Address, spender: Address, required: bigint) {
    const allowance = await client!.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address!, spender] });
    if (allowance < required) await send(token, erc20Abi, "approve", [spender, required], "Approve the exact amount");
  }
  async function run(action: () => Promise<void>) {
    if (!ready) return;
    setWorking(true); setError("");
    try { await action(); await queryClient.invalidateQueries({ queryKey: ["v4-wallet"] }); await queryClient.invalidateQueries({ queryKey: ["v4-market"] }); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to complete transaction"); }
    finally { setWorking(false); }
  }
  async function trade() {
    if (!m.tradingOpen || !quote.data || quote.isError || Date.now() - quote.data.quotedAt > 30000) throw new Error("Refresh the quote before trading.");
    if (quotePriceImpact(amountIn, quote.data.amountOut, quote.data.sqrtPriceX96, zeroForOne).blocked) throw new Error("This amount moves the price too far. Reduce the order before trading.");
    // Check price impact before approval and again after refreshing the final swap quote.
    await approve(inputToken, d.router, amountIn);
    const fresh = await quote.refetch();
    if (!fresh.data || fresh.isError) throw new Error("Could not refresh the price for this order. Please try again.");
    if (quotePriceImpact(amountIn, fresh.data.amountOut, fresh.data.sqrtPriceX96, zeroForOne).blocked) throw new Error("The price changed too much. Reduce the amount and review a new quote.");
    const minimum = minimumOutput(fresh.data.amountOut);
    await send(d.router, RentV4RouterAbi, "swapExactInput", [{ market: d.market, buyRent, amountIn, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], buyRent ? "Buy RENT" : "Sell RENT");
  }
  async function provideLiquidity() {
    const reviewed = liquidityDeposit;
    if (!m.tradingOpen || !reviewed) throw new Error("Enter a valid RENT amount to add.");
    setLockedDeposit(reviewed);
    try {
      const refreshDeposit = async () => {
        const slot = await client!.readContract({ address: d.stateView, abi: v4StateAbi, functionName: "getSlot0", args: [m.poolId] });
        const fresh = quoteFullRangeDeposit(slot[0], reviewed.rentMaximum, rentIs0);
        if (!fresh || fresh.cashAmount > reviewed.cashMaximum || fresh.rentAmount > reviewed.rentMaximum) {
          await queryClient.invalidateQueries({ queryKey: ["v4-market"] });
          throw new Error("The pool price moved beyond your reviewed USDC maximum. Review the updated amount and try again.");
        }
        return fresh;
      };
      await refreshDeposit();
      const balances = await wallet.refetch();
      if (balances.isError || !balances.data) throw new Error("Could not refresh your wallet balances. Retry before adding liquidity.");
      if (balances.data.rent < reviewed.rentMaximum || balances.data.cash < reviewed.cashMaximum) throw new Error(`Your wallet needs the RENT amount and the displayed ${d.symbol} maximum on ${networkName}. Reduce the RENT amount or add funds.`);
      await approve(d.market, d.router, reviewed.rentMaximum);
      await approve(d.currency, d.router, reviewed.cashMaximum);
      const fresh = await refreshDeposit();
      const max0 = rentIs0 ? reviewed.rentMaximum : reviewed.cashMaximum;
      const max1 = rentIs0 ? reviewed.cashMaximum : reviewed.rentMaximum;
      await send(d.router, RentV4RouterAbi, "modifyLiquidity", [{ market: d.market, tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: fresh.liquidity, amount0Limit: max0, amount1Limit: max1, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], "Add trading liquidity");
    } finally { setLockedDeposit(null); }
  }
  async function removeLiquidity() {
    if (!wallet.data?.liquidity || !m.removalOpen) throw new Error("Liquidity removal is currently locked.");
    const [a0, a1] = fullRangeAmounts(m.sqrtPriceX96, wallet.data.liquidity);
    await send(d.router, RentV4RouterAbi, "modifyLiquidity", [{ market: d.market, tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: -wallet.data.liquidity, amount0Limit: a0 * 99n / 100n, amount1Limit: a1 * 99n / 100n, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], "Remove trading liquidity");
  }

  return <div className="max-w-3xl mx-auto space-y-6" data-testid="v4-market-actions">
    <Card><p className="text-xs sm:text-sm font-bold uppercase text-primary-green">Live trading market · {networkName}</p><h1 className="text-3xl font-parkDisplay font-bold mt-2">{mode === "trade" ? "Buy & Sell" : mode === "underwrite" ? "Fund cover and provide liquidity" : "Redeem RENT"}</h1>
      {mode === "trade" ? <>
        <div className="mt-5 rounded-xl bg-paper-1 p-4" data-testid="rent-current-price">
          <p className="text-sm text-surface-grey-2">Current RENT price</p>
          <p className="font-parkDisplay text-3xl font-bold mt-1">{currentPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} {d.symbol} <span className="text-base font-normal">per RENT</span></p>
          <p className="text-sm mt-2">{m.tradingOpen ? "Trading open" : m.settled ? "Settled — trading closed" : "Trading closed"}</p>
        </div>
        <p className="mt-3 text-sm">This is the price before your trade. Your order can change it when liquidity is limited.</p>
      </> : <>
        <p className="mt-3">Each RENT is backed by one {d.symbol} in escrow and pays the settled ratio. Pool liquidity is separate from collateral.</p>
        <p className="mt-3 font-bold">1 RENT ≈ {m.p.toFixed(4)} {d.symbol} · {m.tradingOpen ? "Trading open" : m.settled ? "Settled — trading closed" : "Trading closed"}</p>
      </>}
      <p className="mt-2 text-sm">{!address ? "Connect your wallet to see your balances." : wallet.isError ? `Could not load your balances on ${networkName}.` : wallet.data ? `Your wallet: ${short(wallet.data.rent, d.decimals)} RENT · ${short(wallet.data.cash, d.decimals)} ${d.symbol}` : `Checking your balances on ${networkName}…`}</p>
      {address && wallet.isError && <p role="alert" className="mt-2 text-sm">Balance checks are unavailable, so transactions are paused. <button type="button" className="font-bold underline" onClick={() => void wallet.refetch()}>Retry balance check</button></p>}
      {!connected && <div className="mt-4">
        <Button app="fund" isLoading={switchingChain} onClick={() => address ? switchChain({ chainId: d.chainId }) : openConnectModal?.()}>
          {address ? `Switch to ${networkName}` : "Connect wallet"}
        </Button>
        <p className="mt-2 text-sm">Pay with native {d.symbol}; keep {nativeSymbol} for network fees.</p>
      </div>}
      {address && wallet.data?.native === 0n && <div role="alert" className="mt-4 rounded-xl border border-system-warning bg-system-warning/10 p-4" data-testid="missing-gas">
        <p className="font-bold">You also need {nativeSymbol} for network fees</p>
        <p className="text-sm mt-2">This wallet has no {nativeSymbol} on {networkName}. {nativeSymbol} is required to submit a transaction on this network.</p>
      </div>}
      {market.isError && <p role="alert">Market data is unavailable. Transactions are disabled until it refreshes.</p>}
    </Card>
    {mode === "trade" && <Card>
      <div role="group" aria-label="Trade direction" className="flex gap-3 mb-5">
        <Button aria-pressed={buyRent} app="fund" variant={buyRent ? "primary" : "secondary"} disabled={busy} onClick={() => setBuyRent(true)}>Buy</Button>
        <Button aria-pressed={!buyRent} app="fund" variant={!buyRent ? "primary" : "secondary"} disabled={busy} onClick={() => setBuyRent(false)}>Sell</Button>
      </div>
      {targetRent > 0n && buyRent && !amountEdited && <p className="mb-4 text-sm" data-testid="coverage-request">
        {!m.tradingOpen ? <>Trading has closed for this market. New RENT purchases are unavailable.</>
          : targetExceedsSupply ? <>Your coverage calculation needs {short(targetRent, d.decimals)} RENT, but this market has only {short(m.supply, d.decimals)} RENT in total. Enter a smaller purchase below.</>
          : prefilled ? <>Your coverage selection was {short(targetRent, d.decimals)} RENT. We filled in its current cost below; review how much you receive before buying.</>
          : targetQuote.isError || m.liquidity === 0n ? <>The pool cannot currently price a purchase of {short(targetRent, d.decimals)} RENT. Enter a smaller purchase below.</>
          : <>Finding the current cost of {short(targetRent, d.decimals)} RENT…</>}
      </p>}
      <label className="block font-bold">You pay ({buyRent ? d.symbol : "RENT"})<input className={`${inputClass} mt-2 text-xl font-normal`} inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setAmountEdited(true); }} disabled={busy} /></label>
      <div className="flex flex-wrap justify-between items-center gap-2 mt-2 text-sm" data-testid="pay-balance">
        <p>{!address ? `Connect your wallet to see your ${paySymbol} balance on ${networkName}.` : wallet.isError ? `Could not load your ${paySymbol} balance on ${networkName}.` : payBalance === undefined ? `Checking your ${paySymbol} balance on ${networkName}…` : <>Available on {networkName}: <strong>{short(payBalance, d.decimals)} {paySymbol}</strong></>}</p>
        {payBalance !== undefined && payBalance > 0n && <button type="button" disabled={busy} className="font-bold underline text-core-green" onClick={() => { setAmount(formatUnits(payBalance, d.decimals)); setAmountEdited(true); }}>Use available balance</button>}
      </div>
      {address && payBalance !== undefined && (payBalance === 0n || insufficientFunds) && <div role="alert" className="mt-4 rounded-xl border border-system-warning bg-system-warning/10 p-4" data-testid="insufficient-funds">
        <p className="font-bold">{payBalance === 0n ? `No ${paySymbol} on ${networkName}` : `Not enough ${paySymbol} on ${networkName}`}</p>
        <p className="text-sm mt-2">{payBalance === 0n ? buyRent ? `Add ${d.symbol} to this wallet on ${networkName} to buy RENT.` : `You need RENT in this wallet on ${networkName} before you can sell it.` : `You have ${short(payBalance, d.decimals)} ${paySymbol}, but this order needs ${short(amountIn, d.decimals)} ${paySymbol}. You need ${short(amountIn - payBalance, d.decimals)} more ${paySymbol}, or a smaller order.`}</p>
        {buyRent && <p className="text-sm mt-2">Balances on other networks do not count here.{d.symbol === "USDC" ? " Use native USDC, not USDC.e." : ""}</p>}
      </div>}
      {amountIn > 0n && <div className="my-4 rounded-xl bg-paper-1 p-4" data-testid="spot-conversion">
        <p className="text-sm font-bold">At the current price</p>
        <p className="mt-1">{short(amountIn, d.decimals)} {buyRent ? d.symbol : "RENT"} {buyRent ? "÷" : "×"} {currentPrice.toLocaleString(undefined, { maximumFractionDigits: 6 })} ≈ <strong>{short(atSpot, d.decimals)} {outputSymbol}</strong></p>
        <p className="text-xs text-surface-grey-2 mt-2">Before trading fees or any price movement caused by your order.</p>
      </div>}
      <div className="my-5" aria-live="polite" data-testid="trade-receive">
        <p className="text-sm font-bold">You receive · live pool quote</p>
        <p className="font-parkDisplay text-3xl font-bold mt-2">{currentQuote ? `${short(currentQuote.amountOut, d.decimals)} ${outputSymbol}` : "—"}</p>
        {currentQuote ? <p className="text-xs text-surface-grey-2 mt-2">Includes trading fees and the effect of your order on the price.{quote.isFetching ? " Refreshing…" : ""}</p>
          : <p className="text-sm mt-2">{!m.tradingOpen ? "Trading is closed." : m.liquidity === 0n ? "The pool has no trading liquidity." : quote.isError ? "Could not price this order. Try a smaller amount or refresh the quote." : amountIn > 0n ? "Fetching a live quote…" : "Enter an amount to see what you receive."}</p>}
      </div>
      {currentQuote && <dl className="space-y-3 text-sm border-t border-paper-2 pt-4" data-testid="trade-price-details">
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4"><dt>Average price for your order</dt><dd className="sm:text-right font-bold break-words">{averagePrice?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? "—"} {d.symbol} / RENT</dd></div>
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4"><dt>Price impact + trading fees</dt><dd className={`sm:text-right font-bold ${highImpact ? "text-system-red" : ""}`}>{impact?.bps !== null && impact?.bps !== undefined ? `${(Number(impact.bps) / 100).toFixed(2)}%` : "—"}</dd></div>
        {!impact?.blocked && <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4"><dt>Minimum you receive</dt><dd className="sm:text-right break-words">{short(minimumOutput(currentQuote.amountOut), d.decimals)} {outputSymbol}</dd></div>}
      </dl>}
      {highImpact && <div role="alert" className="mt-5 rounded-xl border border-system-warning bg-system-warning/10 p-4" data-testid="price-impact-warning">
        <p className="font-bold">This order is too large for the available liquidity.</p>
        <p className="text-sm mt-2">You would receive {(Number(impact!.bps!) / 100).toFixed(2)}% less {outputSymbol} than the current-price calculation. Orders above {Number(MAX_TRADE_PRICE_IMPACT_BPS) / 100}% are blocked here. Reduce your amount, or wait for more liquidity.</p>
        {buyRent && atSpot > m.supply && <p className="text-sm mt-2">The market has only {short(m.supply, d.decimals)} RENT in total; it cannot supply {short(atSpot, d.decimals)} RENT.</p>}
      </div>}
      {currentQuote && impact?.blocked && !highImpact && <p role="alert" className="mt-4 text-sm">This amount is too small to trade with minimum-output protection.</p>}
      <p className="text-xs text-surface-grey-2 mt-4 mb-5">The quote refreshes automatically. A 1% slippage limit protects against further price changes after the quote; it does not remove the price impact shown above. Network fees are paid separately.</p>
      <Button app="fund" disabled={!ready || !m.tradingOpen || !currentQuote || impact?.blocked || quote.isFetching || amountIn === 0n || (wallet.data ? (buyRent ? wallet.data.cash : wallet.data.rent) < amountIn : true)} onClick={() => void run(trade)}>Confirm trade</Button>
      <details className="mt-5 text-sm"><summary className="cursor-pointer font-bold">What does owning RENT mean?</summary><p className="mt-2">RENT is a rent-protection token. Each token is backed by one {d.symbol} in escrow and pays up to one {d.symbol} after settlement. Its trading price is separate from the rent index and its eventual payout.</p></details>
    </Card>}
    {mode === "underwrite" && <>
      <Card><h2 className="text-xl font-bold">1. Mint backed RENT</h2><p className="my-3">Deposit collateral and receive the same amount of RENT. Your collateral stays locked until the claim deadline; holding or removing trading liquidity does not release it.</p>
        <label>Collateral ({d.symbol})<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
        <Button app="fund" className="mt-4" disabled={!ready || !m.tradingOpen || amountIn === 0n || !wallet.data || wallet.data.cash < amountIn} onClick={() => void run(async () => { await approve(d.currency, d.market, amountIn); await send(d.market, RentV4MarketAbi, "depositAndMint", [amountIn, address!], "Escrow collateral and mint RENT"); })}>Deposit and mint RENT</Button>
      </Card>
      <Card><h2 className="text-xl font-bold">2. Make RENT available to trade</h2>
        <p className="my-3">Choose how much RENT to add. We calculate the matching {d.symbol} at the pool's current price. This is additional trading money; the USDC backing your RENT stays in escrow.</p>
        <div className="rounded-xl bg-paper-1 p-4 my-4" data-testid="liquidity-price">
          <p className="text-sm text-surface-grey-2">This pool's current price</p>
          <p className="font-parkDisplay text-2xl font-bold mt-1">{m.p.toLocaleString(undefined, {maximumFractionDigits: 6})} {d.symbol} per RENT</p>
          <p className="text-sm mt-2">Adding liquidity does not set a new price. Buying and selling RENT moves the price.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4" data-testid="liquidity-deposit-controls"><label>RENT to add<input className={inputClass} inputMode="decimal" value={rentBudget} onChange={e => setRentBudget(e.target.value)} disabled={busy} /></label><div><p>Matching {d.symbol}</p><output aria-label={`${d.symbol} required`} className="mt-0 block min-h-12 rounded-lg border border-paper-2 bg-paper-1 p-3 font-parkDisplay font-bold break-words" data-testid="liquidity-usdc-required">{liquidityDeposit ? `${exactAmount(liquidityDeposit.cashAmount, d.decimals)} ${d.symbol}` : "—"}</output><p className="mt-1 text-xs text-surface-grey-2">Calculated automatically from your RENT amount.</p></div></div>
        {liquidityDeposit ? <>
          <p className="mt-3 text-sm" data-testid="liquidity-deposit-preview">Estimated deposit: <strong>{exactAmount(liquidityDeposit.rentAmount, d.decimals)} RENT + {exactAmount(liquidityDeposit.cashAmount, d.decimals)} {d.symbol}</strong>. Unused tokens stay in your wallet.</p>
          <p className="mt-2 text-sm">Maximum {d.symbol}: <strong data-testid="liquidity-usdc-maximum">{exactAmount(liquidityDeposit.cashMaximum, d.decimals)} {d.symbol}</strong>, including {LIQUIDITY_SLIPPAGE_BPS / 100}% for pool-price movement. The transaction never takes more RENT than you entered or more {d.symbol} than this reviewed maximum.</p>
        </> : rentBudget !== "" && <p className="mt-3 text-sm">Enter a RENT amount that this pool can accept to see the matching {d.symbol}.</p>}
        <p className="text-sm mt-3">Renters' purchases put {d.symbol} into the pool and take RENT out. Your position holds its share of that inventory and trading fees. The purchase is the renter's premium; it is not an immediate payment into your wallet or a fixed price for all your RENT.</p>
        {wallet.data && liquidityDeposit && (liquidityRentShortfall > 0n || liquidityCashShortfall > 0n) && <div role="alert" className="mt-3 rounded-xl border border-system-warning bg-system-warning/10 p-4 text-sm" data-testid="liquidity-funds-warning">
          <p className="font-bold">Not enough {liquidityRentShortfall > 0n ? "RENT" : d.symbol} on {networkName}</p>
          {liquidityRentShortfall > 0n && <p className="mt-2">You have {exactAmount(wallet.data.rent, d.decimals)} RENT. Add {exactAmount(liquidityRentShortfall, d.decimals)} more RENT or enter a smaller amount.</p>}
          {liquidityCashShortfall > 0n && <p className="mt-2">You have {exactAmount(wallet.data.cash, d.decimals)} {d.symbol}. Add {exactAmount(liquidityCashShortfall, d.decimals)} more {d.symbol} to cover the displayed maximum, or reduce the RENT amount.</p>}
        </div>}
        <Button app="fund" className="mt-4" disabled={!ready || !m.tradingOpen || !liquidityDeposit || !wallet.data || liquidityRentShortfall > 0n || liquidityCashShortfall > 0n} onClick={() => void run(provideLiquidity)}>Add liquidity</Button>
        {!!wallet.data?.liquidity && <div className="mt-5"><p className="mb-3">Your full-range position can be removed before observation, after settlement, or after expiry. During observation it is locked.</p><Button app="fund" variant="secondary" disabled={!ready || !m.removalOpen} onClick={() => void run(removeLiquidity)}>Remove my liquidity</Button></div>}
      </Card>
      {!!wallet.data?.shares && <Card><h2 className="font-bold">Remaining escrow</h2><p className="my-3">After the claim deadline, original depositors share the unclaimed escrow in proportion to their deposits. Claim holders must redeem their RENT separately.</p><Button app="fund" disabled={!ready || wallet.data.residual === 0n} onClick={() => void run(() => send(d.market, RentV4MarketAbi, "withdrawResidual", [address!], "Withdraw remaining escrow"))}>Withdraw {short(wallet.data.residual, d.decimals)} {d.symbol}</Button></Card>}
    </>}
    {mode === "redeem" && <Card><h2 className="text-xl font-bold">Collect the settled payout</h2><p className="my-3">{m.settled ? `Each RENT pays ${Number(m.payoutRatioWad) / 1e18} ${d.symbol}.` : "The market has not settled yet."} Redeeming burns your RENT. Claim before {new Date(Number(m.redeemEnd) * 1000).toLocaleDateString()}.</p>
      <label>RENT to redeem<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
      <Button app="fund" className="mt-4" disabled={!ready || !m.settled || Date.now() / 1000 > Number(m.redeemEnd) || amountIn === 0n || !wallet.data || wallet.data.rent < amountIn} onClick={() => void run(() => send(d.market, RentV4MarketAbi, "redeem", [amountIn, address!], "Redeem RENT"))}>Redeem RENT</Button>
    </Card>}
    <TxStatus state={tx.state} />{error && <p role="alert" className="text-system-red">{error}</p>}
  </div>;
}
