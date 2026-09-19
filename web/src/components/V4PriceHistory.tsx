import { useEffect, useState } from "react";
import { ArrowsLeftRightIcon, ArrowUpRightIcon } from "@phosphor-icons/react";
import { useActiveDeployment } from "../chain/registry";
import { txUrl } from "../chain/explorer";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbiItem } from "viem";
import { useV4Market } from "../chain/v4";
import { rentSpotPrice } from "../chain/v4Math";
import { Card } from "./States";
import { impliedRentCents } from "../lib/market";

const swapEvent = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");

export function V4PriceHistory({ presentation = false }: { presentation?: boolean }) {
  const market = useV4Market();
  const { deployment } = useActiveDeployment();
  const [visibleCount, setVisibleCount] = useState(10);
  const [presentationChart, setPresentationChart] = useState<SVGSVGElement | null>(null);
  const [presentationSize, setPresentationSize] = useState({ width: 710, height: 180 });
  useEffect(() => {
    if (!presentation || !presentationChart) return;
    const measure = () => {
      const bounds = presentationChart.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const width = Math.round(bounds.width);
      const height = Math.round(bounds.height);
      setPresentationSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(presentationChart);
    return () => observer.disconnect();
  }, [presentation, presentationChart]);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
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
  // Presentation has a short, wide viewport. Match its actual geometry so
  // the graph fills that viewport while labels retain their normal proportions.
  const chartWidth = presentation ? presentationSize.width : compact ? 320 : 710;
  const chartHeight = presentation ? presentationSize.height : 275;
  const left = presentation ? 60 : compact ? 48 : 55;
  const right = presentation ? chartWidth - (compact ? 14 : 104) : compact ? 306 : 595;
  const top = presentation ? 32 : 40;
  const bottom = presentation ? chartHeight - 30 : 220;
  const labelSize = presentation ? 14 : 12;
  const timeSize = presentation ? 14 : compact ? 10 : 12;
  const x = (time: number, index: number) => points.length === 1 ? (left + right) / 2 :
    left + (sameTimestamp ? index / (points.length - 1) : (time - minTime) / Math.max(1, maxTime - minTime)) * (right - left);
  const y = (price: number) => bottom - (price - minPrice) / (maxPrice - minPrice) * (bottom - top);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.time, i)},${y(p.p)}`).join(" ");
  const axisTime = (time: number) => new Date(time * 1000).toLocaleString(undefined, presentation && compact ? {hour: "2-digit", minute: "2-digit"} : compact ? {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"} : undefined);
  const rentAt = (p: number) => (impliedRentCents(m?.baseCents ?? 0, p) / 100).toFixed(2);
  return <Card className={presentation ? "story-price-history" : undefined}>
    {history.isPending ? <p>Loading recorded swaps…</p> : history.isError ? <p role="status">Trade history could not be loaded. The current spot price is shown above; no synthetic history is substituted.</p> : !points.length ? <p>No swaps were found in the scanned block window. Earlier trades may exist outside this window; the spot price above is a current pool-state reading.</p> : <>
      <svg ref={presentation ? setPresentationChart : undefined} viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full font-parkBody" role="img" data-testid="v4-price-history-chart" aria-label={presentation ? "RENT prices after recent on-chain swaps; up to 100 swaps in the latest 100,000 blocks" : compact ? "RENT prices after recent on-chain swaps; price-equivalent rent appears in the cards below" : "RENT prices after recent on-chain swaps; right axis gives price-equivalent rent"}>
        {[0, .5, 1].map(f => <g key={f}><line x1={left} x2={right} y1={bottom - (bottom - top) * f} y2={bottom - (bottom - top) * f} stroke="var(--color-paper-2)" /><text x={left - 7} y={bottom + 4 - (bottom - top) * f} textAnchor="end" fontSize={labelSize}>{(minPrice + (maxPrice - minPrice) * f).toFixed(4)}</text>{!compact && <text x={right + 10} y={bottom + 4 - (bottom - top) * f} fontSize={labelSize}>${rentAt(minPrice + (maxPrice - minPrice) * f)}</text>}</g>)}
        <path d={path} fill="none" stroke="var(--color-core-green)" strokeWidth="3" />
        {points.map((p, i) => <circle key={`${p.tx}:${i}`} cx={x(p.time, i)} cy={y(p.p)} r="4" fill="var(--color-core-green)" data-testid="v4-swap-point"><title>{new Date(p.time * 1000).toLocaleString()} · {p.p.toFixed(5)} {d?.symbol} / RENT</title></circle>)}
        <text x={left} y="20" fontSize={labelSize}>{d?.symbol} / RENT</text>{!compact && <text x={right + 10} y="20" fontSize={labelSize}>Rent /SF</text>}
        <text x={left} y={presentation ? chartHeight - 8 : 250} fontSize={timeSize}>{sameTimestamp ? "Swap 1" : axisTime(minTime)}</text><text x={right} y={presentation ? chartHeight - 8 : 250} textAnchor="end" fontSize={timeSize}>{sameTimestamp ? `Swap ${points.length}` : axisTime(maxTime)}</text>
      </svg>
      {!presentation && sameTimestamp && <p className="text-xs mb-3">These swaps share the timestamp {new Date(minTime * 1000).toLocaleString()}; horizontal position shows execution order.</p>}
      {!presentation && <section className="mt-6 border-t border-paper-2 pt-5" aria-labelledby="recorded-swaps-title" data-testid="recorded-swaps">
        <div className="flex items-center gap-3"><span className="rounded-xl bg-paper-1 p-2.5 text-core-green"><ArrowsLeftRightIcon size={22} weight="bold" /></span><div><h3 id="recorded-swaps-title" className="font-parkDisplay font-bold text-lg">Recorded swap prices</h3><p className="font-parkBody text-xs text-surface-grey-2 mt-1">Latest first · pool price immediately after each swap</p></div></div>
        <ul className="mt-4 space-y-3" aria-label="Recorded swap prices">
          {[...points].reverse().slice(0, visibleCount).map((point, i) => <SwapPriceRow key={`${point.tx}:${i}`} point={point} symbol={d?.symbol ?? "USDC"} impliedRent={rentAt(point.p)} explorer={deployment.explorerBase} />)}
        </ul>
        {points.length > visibleCount && <button type="button" className="mt-4 min-h-11 w-full rounded-xl border border-paper-2 bg-paper-1 px-4 py-2 font-parkBody text-sm font-bold text-core-green hover:border-core-green" onClick={() => setVisibleCount(count => count + 10)}>Show more swaps ({points.length - visibleCount} remaining)</button>}
      </section>}
    </>}
    {!presentation && <p className="text-xs mt-3">Last 100 swaps within the latest 100,000 blocks, read from this pool’s on-chain events. Price reflects risk, liquidity and fees; the implied rent is a price-equivalent level, not expected rent.</p>}
  </Card>;
}

function SwapPriceRow({ point, symbol, impliedRent, explorer }: {
  point: { time: number; p: number; tx: string }; symbol: string; impliedRent: string; explorer: string;
}) {
  const date = new Date(point.time * 1000);
  return <li className="rounded-xl border border-paper-2 bg-paper-1/50 p-4" data-testid="v4-swap-row" data-transaction={point.tx}>
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <time dateTime={date.toISOString()} className="font-parkBody text-xs text-surface-grey-2">{date.toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})} · {date.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit"})}</time>
      {explorer && <a href={txUrl(point.tx, explorer)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 rounded-lg font-parkBody text-xs font-bold text-core-green hover:underline focus-visible:outline-2 focus-visible:outline-core-green" aria-label={`View swap transaction ${point.tx.slice(0, 10)}`}>View transaction <ArrowUpRightIcon size={14} /></a>}
    </div>
    <dl className="grid grid-cols-2 gap-4 mt-2 font-parkBody">
      <div className="min-w-0"><dt className="text-xs text-surface-grey-2">RENT price</dt><dd className="font-parkDisplay text-xl font-bold text-core-green mt-1 break-words">{point.p.toFixed(5)} <span className="font-parkBody text-xs font-normal">{symbol}</span></dd></div>
      <div className="min-w-0"><dt className="text-xs text-surface-grey-2">Price-implied rent</dt><dd className="font-parkDisplay text-xl font-bold mt-1">${impliedRent} <span className="font-parkBody text-xs font-normal">/SF</span></dd></div>
    </dl>
  </li>;
}
