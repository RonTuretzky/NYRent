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
import { useV4Market, v4QuoterAbi } from "../chain/v4";
import { RentV4MarketAbi, RentV4RouterAbi } from "../chain/v4Abi";
import { fullRangeAmounts, fullRangeLiquidity, FULL_RANGE_LOWER, FULL_RANGE_UPPER, minimumOutput } from "../chain/v4Math";

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
  const smallPilot = m.supply < parseUnits("10", d.decimals);
  const queryClient = useQueryClient();
  const tx = useTx();
  const [buyRent, setBuyRent] = useState(true);
  const [amount, setAmount] = useState(mode === "trade" && smallPilot ? "0.01" : "1");
  const [rentBudget, setRentBudget] = useState("1");
  const [cashBudget, setCashBudget] = useState("0.285");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [search] = useSearchParams();
  const targetRent = units(search.get("amount") ?? "", d.decimals);
  const [prefilled, setPrefilled] = useState(false);
  const amountIn = units(amount, d.decimals);
  const rentMaximum = units(rentBudget, d.decimals);
  const cashMaximum = units(cashBudget, d.decimals);
  const rentIs0 = d.poolKey.currency0.toLowerCase() === d.market.toLowerCase();
  const max0 = rentIs0 ? rentMaximum : cashMaximum;
  const max1 = rentIs0 ? cashMaximum : rentMaximum;
  const liquidityToAdd = fullRangeLiquidity(m.sqrtPriceX96, max0, max1);
  const inputToken = buyRent ? d.currency : d.market;
  const targetQuote = useQuery({
    queryKey: ["v4-target-quote", d.chainId, d.market, targetRent.toString()],
    enabled: mode === "trade" && buyRent && targetRent > 0n && !!client && m.tradingOpen && m.liquidity > 0n && !prefilled,
    retry: false,
    queryFn: async () => {
      const result = await client!.simulateContract({ address: d.quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: [{ poolKey: d.poolKey, zeroForOne: d.currency.toLowerCase() === d.poolKey.currency0.toLowerCase(), exactAmount: targetRent, hookData: "0x" }] });
      return result.result[0];
    },
  });
  useEffect(() => {
    if (targetQuote.data && !prefilled) { setAmount(formatUnits(targetQuote.data, d.decimals)); setPrefilled(true); }
  }, [targetQuote.data, prefilled, d.decimals]);
  const quote = useQuery({
    queryKey: ["v4-quote", d.chainId, d.market, buyRent, amountIn.toString()],
    enabled: mode === "trade" && !!client && amountIn > 0n && m.tradingOpen && m.liquidity > 0n,
    refetchInterval: 10000,
    retry: false,
    queryFn: async () => {
      const result = await client!.simulateContract({ address: d.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
        args: [{ poolKey: d.poolKey, zeroForOne: inputToken.toLowerCase() === d.poolKey.currency0.toLowerCase(), exactAmount: amountIn, hookData: "0x" }] });
      return { amountOut: result.result[0], quotedAt: Date.now() };
    },
  });
  const wallet = useQuery({
    queryKey: ["v4-wallet", d.chainId, d.market, address],
    enabled: !!address && !!client,
    refetchInterval: 10000,
    queryFn: async () => {
      const [rent, cash, residual, shares, liquidity] = await Promise.all([
        client!.readContract({ address: d.market, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.readContract({ address: d.currency, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.readContract({ address: d.market, abi: RentV4MarketAbi, functionName: "residualOf", args: [address!] }),
        client!.readContract({ address: d.market, abi: RentV4MarketAbi, functionName: "residualShares", args: [address!] }),
        client!.readContract({ address: d.router, abi: RentV4RouterAbi, functionName: "liquidityOf", args: [address!, d.market, FULL_RANGE_LOWER, FULL_RANGE_UPPER] }),
      ]);
      return { rent, cash, residual, shares, liquidity };
    },
  });
  useEffect(() => { setError(""); tx.reset(); }, [address, buyRent]); // eslint-disable-line react-hooks/exhaustive-deps
  const connected = !!address && walletChainId === d.chainId;
  const busy = working || ["wallet", "pending", "simulating", "stillPending"].includes(tx.state.status);
  const ready = connected && !busy && !market.isError && !wallet.isError;
  const inputClass = "w-full rounded-lg border border-paper-2 bg-paper-0 p-3 font-parkBody";

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
    // Capture a bounded quote before any approval request; refresh after approval to avoid stale quotes.
    await approve(inputToken, d.router, amountIn);
    const fresh = await quote.refetch();
    if (!fresh.data || fresh.isError) throw new Error("No current executable quote. Please try a smaller amount.");
    const minimum = minimumOutput(fresh.data.amountOut);
    await send(d.router, RentV4RouterAbi, "swapExactInput", [{ market: d.market, buyRent, amountIn, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], buyRent ? "Buy RENT" : "Sell RENT");
  }
  async function provideLiquidity() {
    if (!m.tradingOpen || liquidityToAdd <= 0n || liquidityToAdd >= 2n ** 127n) throw new Error("Enter a valid pair of liquidity amounts.");
    await approve(d.poolKey.currency0, d.router, max0);
    await approve(d.poolKey.currency1, d.router, max1);
    await send(d.router, RentV4RouterAbi, "modifyLiquidity", [{ market: d.market, tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: liquidityToAdd, amount0Limit: max0, amount1Limit: max1, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], "Add trading liquidity");
  }
  async function removeLiquidity() {
    if (!wallet.data?.liquidity || !m.removalOpen) throw new Error("Liquidity removal is currently locked.");
    const [a0, a1] = fullRangeAmounts(m.sqrtPriceX96, wallet.data.liquidity);
    await send(d.router, RentV4RouterAbi, "modifyLiquidity", [{ market: d.market, tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: -wallet.data.liquidity, amount0Limit: a0 * 99n / 100n, amount1Limit: a1 * 99n / 100n, recipient: address!, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }], "Remove trading liquidity");
  }

  return <div className="max-w-3xl mx-auto space-y-6" data-testid="v4-market-actions">
    <Card><p className="text-sm font-bold uppercase text-primary-green">Live trading market · {networkName}</p><h1 className="text-3xl font-parkDisplay font-bold mt-2">{mode === "trade" ? "Buy or sell RENT" : mode === "underwrite" ? "Fund cover and provide liquidity" : "Redeem RENT"}</h1>
      <p className="mt-3">Each RENT is backed by one {d.symbol} in escrow and pays the settled ratio. Trading ends before the observation window. Pool liquidity is separate from collateral.</p>
      <p className="mt-3 font-bold">1 RENT ≈ {m.p.toFixed(4)} {d.symbol} · {m.tradingOpen ? "Trading open" : m.settled ? "Settled — trading closed" : "Trading closed"}</p>
      <p className="mt-2 text-sm">{wallet.data ? `Your wallet: ${short(wallet.data.rent, d.decimals)} RENT · ${short(wallet.data.cash, d.decimals)} ${d.symbol}` : "Connect your wallet to see your balances."}</p>
      {!connected && <div className="mt-4">
        <Button app="fund" isLoading={switchingChain} onClick={() => address ? switchChain({ chainId: d.chainId }) : openConnectModal?.()}>
          {address ? `Switch to ${networkName}` : "Connect wallet to trade"}
        </Button>
        <p className="mt-2 text-sm">Pay with native {d.symbol}; keep {chainById(d.chainId)?.nativeCurrency.symbol ?? "native currency"} for network fees.</p>
      </div>}
      {market.isError && <p role="alert">Market data is unavailable. Transactions are disabled until it refreshes.</p>}
    </Card>
    {mode === "trade" && <Card>
      {smallPilot && <p className="mb-4 text-sm">Small pilot: {short(m.supply, d.decimals)} RENT backed by {short(m.escrow, d.decimals)} {d.symbol}. The form starts with a small trade; the quote below reflects the available liquidity.</p>}
      {targetRent > 0n && buyRent && <p className="mb-4">Your calculator target is {short(targetRent, d.decimals)} RENT. {prefilled ? "The spending amount below is estimated for that target; check the current receipt quote before confirming." : targetQuote.isError || m.liquidity === 0n ? "There is not an executable quote for that target. You can choose a smaller spending amount below." : "Estimating its cost…"}</p>}
      <div className="flex gap-3 mb-4"><Button app="fund" variant={buyRent ? "primary" : "secondary"} disabled={busy} onClick={() => setBuyRent(true)}>Buy RENT</Button><Button app="fund" variant={!buyRent ? "primary" : "secondary"} disabled={busy} onClick={() => setBuyRent(false)}>Sell RENT</Button></div>
      <label className="block">You pay ({buyRent ? d.symbol : "RENT"})<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
      <p className="my-3">{quote.data && !quote.isError ? `Estimated receipt: ${short(quote.data.amountOut, d.decimals)} ${buyRent ? "RENT" : d.symbol}` : m.liquidity === 0n ? "This pool has no active liquidity. A quote is not available." : quote.isError ? "No executable quote for this amount. Try a smaller trade." : "Enter an amount to get a quote."}</p>
      <p className="text-sm mb-4">Maximum slippage: 1%. Pool fees are included in the quote. Selling needs sufficient liquidity and may return less than you paid.</p>
      <Button app="fund" disabled={!ready || !m.tradingOpen || !quote.data || quote.isError || amountIn === 0n || (wallet.data ? (buyRent ? wallet.data.cash : wallet.data.rent) < amountIn : true)} onClick={() => void run(trade)}>{buyRent ? "Buy RENT" : "Sell RENT"}</Button>
    </Card>}
    {mode === "underwrite" && <>
      <Card><h2 className="text-xl font-bold">1. Mint backed RENT</h2><p className="my-3">Deposit collateral and receive the same amount of RENT. Your collateral stays locked until the claim deadline; holding or removing trading liquidity does not release it. Escrow yield is not active.</p>
        <label>Collateral ({d.symbol})<input className={inputClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} disabled={busy} /></label>
        <Button app="fund" className="mt-4" disabled={!ready || !m.tradingOpen || amountIn === 0n || !wallet.data || wallet.data.cash < amountIn} onClick={() => void run(async () => { await approve(d.currency, d.market, amountIn); await send(d.market, RentV4MarketAbi, "depositAndMint", [amountIn, address!], "Escrow collateral and mint RENT"); })}>Deposit and mint RENT</Button>
      </Card>
      <Card><h2 className="text-xl font-bold">2. Add trading liquidity</h2><p className="my-3">Offer RENT alongside {d.symbol} across the full price range. Traders change the mix you hold; fees accrue to the position. These funds are additional to the backing escrow.</p>
        <div className="grid sm:grid-cols-2 gap-4"><label>Maximum RENT<input className={inputClass} inputMode="decimal" value={rentBudget} onChange={e => setRentBudget(e.target.value)} disabled={busy} /></label><label>Maximum {d.symbol}<input className={inputClass} inputMode="decimal" value={cashBudget} onChange={e => setCashBudget(e.target.value)} disabled={busy} /></label></div>
        <Button app="fund" className="mt-4" disabled={!ready || !m.tradingOpen || liquidityToAdd <= 0n || !wallet.data || wallet.data.rent < rentMaximum || wallet.data.cash < cashMaximum} onClick={() => void run(provideLiquidity)}>Add liquidity</Button>
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
