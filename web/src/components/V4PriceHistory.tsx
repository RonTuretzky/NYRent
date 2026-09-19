import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { useV4Market } from "../chain/v4";
import { rentSpotPrice } from "../chain/v4Math";
import { Card } from "./States";
import { impliedRentCents } from "../lib/market";

const swapEvent = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");

export function V4PriceHistory() {
  const market = useV4Market();
  const d = market.deployment;
  const m = market.data;
  const client = usePublicClient({ chainId: d?.chainId });
  const history = useQuery({
    queryKey: ["v4-price-history", d?.chainId, d?.market],
    enabled: !!d && !!m && !!client,
    refetchInterval: 60000,
    retry: false,
    queryFn: async () => {
      // A trader can open this page immediately after a receipt. Wagmi's shared
      // client may still cache the pre-trade head; scanning to it would omit the
      // very swaps the trader just completed.
      const latest = await client!.getBlockNumber({ cacheTime: 0 });
      const creation = BigInt(d!.deploymentBlock);
      const start = latest - creation > 100000n ? latest - 100000n : creation;
      const points: { block: bigint; time: number; p: number; tx: string }[] = [];
      const ranges = [];
      for (let from = start; from <= latest; from += 5000n) ranges.push([from, from + 4999n > latest ? latest : from + 4999n] as const);
      // Bounded batches avoid overwhelming shared public RPC providers.
      for (let i = 0; i < ranges.length; i += 4) {
        const pages = await Promise.all(ranges.slice(i, i + 4).map(([fromBlock, toBlock]) => client!.getLogs({ address: d!.poolManager, event: swapEvent, args: { id: m!.poolId }, fromBlock, toBlock })));
        for (const logs of pages) for (const log of logs) {
          if (log.args.sqrtPriceX96 === undefined) continue;
          points.push({ block: log.blockNumber, time: 0, p: rentSpotPrice(log.args.sqrtPriceX96, d!.poolKey, d!.market), tx: log.transactionHash });
        }
      }
      // Last 100 swaps are sufficient for the chart; do not imply full archival indexing.
      const recent = points.slice(-100);
      const times = new Map<bigint, number>();
      await Promise.all([...new Set(recent.map(p => p.block))].map(async blockNumber => {
        const block = await client!.getBlock({ blockNumber }); times.set(blockNumber, Number(block.timestamp));
      }));
      return recent.map(p => ({ ...p, time: times.get(p.block)! }));
    },
  });
  const points = history.data ?? [];
  const minTime = points[0]?.time ?? 0;
  const maxTime = points.at(-1)?.time ?? minTime + 1;
  const sameTimestamp = points.length > 1 && minTime === maxTime;
  const lowest = points.length ? Math.min(...points.map(p => p.p)) : 0;
  const highest = points.length ? Math.max(...points.map(p => p.p)) : 1;
  const padding = Math.max((highest - lowest) * 0.2, highest * 0.01, 0.0001);
  const minPrice = Math.max(0, lowest - padding);
  const maxPrice = highest + padding;
  const x = (time: number, index: number) => points.length === 1 ? 325 :
    55 + (sameTimestamp ? index / (points.length - 1) : (time - minTime) / Math.max(1, maxTime - minTime)) * 540;
  const y = (price: number) => 220 - (price - minPrice) / (maxPrice - minPrice) * 180;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.time, i)},${y(p.p)}`).join(" ");
  const rentAt = (p: number) => (impliedRentCents(m?.baseCents ?? 0, p) / 100).toFixed(2);
  return <Card>
    {history.isPending ? <p>Loading recorded swaps…</p> : history.isError ? <p role="status">Trade history could not be loaded. The current spot price is shown above; no synthetic history is substituted.</p> : !points.length ? <p>No swaps were found in the scanned block window. Earlier trades may exist outside this window; the spot price above is a current pool-state reading.</p> : <>
      <svg viewBox="0 0 710 275" className="w-full" role="img" data-testid="v4-price-history-chart" aria-label="RENT prices after recent on-chain swaps; right axis gives price-equivalent rent">
        {[0, .5, 1].map(f => <g key={f}><line x1="55" x2="595" y1={220 - 180 * f} y2={220 - 180 * f} stroke="#d4d4d0" /><text x="48" y={224 - 180 * f} textAnchor="end" fontSize="12">{(minPrice + (maxPrice - minPrice) * f).toFixed(4)}</text><text x="605" y={224 - 180 * f} fontSize="12">${rentAt(minPrice + (maxPrice - minPrice) * f)}</text></g>)}
        <path d={path} fill="none" stroke="#16a34a" strokeWidth="3" />
        {points.map((p, i) => <circle key={`${p.tx}:${i}`} cx={x(p.time, i)} cy={y(p.p)} r="4" fill="#16a34a" data-testid="v4-swap-point"><title>{new Date(p.time * 1000).toLocaleString()} · {p.p.toFixed(5)} {d?.symbol} / RENT</title></circle>)}
        <text x="55" y="20" fontSize="12">{d?.symbol} / RENT</text><text x="605" y="20" fontSize="12">Rent /SF</text>
        <text x="55" y="250" fontSize="12">{sameTimestamp ? "Swap 1" : new Date(minTime * 1000).toLocaleString()}</text><text x="595" y="250" textAnchor="end" fontSize="12">{sameTimestamp ? `Swap ${points.length}` : new Date(maxTime * 1000).toLocaleString()}</text>
      </svg>
      {sameTimestamp && <p className="text-xs mb-3">These swaps share the timestamp {new Date(minTime * 1000).toLocaleString()}; horizontal position shows execution order.</p>}
      <details><summary className="cursor-pointer text-sm">Recorded swap prices</summary><div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>Time</th><th>RENT price</th><th>Price-implied rent</th></tr></thead><tbody>{points.map((p, i) => <tr key={`${p.tx}:${i}`} data-testid="v4-swap-row" data-transaction={p.tx}><td>{new Date(p.time * 1000).toLocaleString()}</td><td>{p.p.toFixed(5)}</td><td>${rentAt(p.p)} /SF</td></tr>)}</tbody></table></div></details>
    </>}
    <p className="text-xs mt-3">Last 100 swaps within the latest 100,000 blocks, read from this pool’s on-chain events. Price reflects risk, liquidity and fees; the right axis is a price-equivalent rent level, not expected rent.</p>
  </Card>;
}
