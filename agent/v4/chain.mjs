import { isAddress, parseAbi, parseAbiItem } from "viem";

export const ERC20_ABI = parseAbi([
  "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
]);
export const MARKET_ABI = parseAbi([
  "function factory() view returns (address)", "function currency() view returns (address)",
  "function oracle() view returns (address)", "function strikeLowCents() view returns (uint32)",
  "function strikeHighCents() view returns (uint32)", "function saleEnd() view returns (uint64)",
  "function obsStart() view returns (uint64)", "function obsEnd() view returns (uint64)",
  "function tradingOpen() view returns (bool)", "function liquidityRemovalOpen() view returns (bool)",
  "function residualShares(address) view returns (uint256)", "function depositAndMint(uint256,address)",
]);
export const FACTORY_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function isMarket(address) view returns (bool)", "function poolKey(address) view returns (PoolKey)",
  "function poolManager() view returns (address)", "function currency() view returns (address)",
  "function oracle() view returns (address)", "function hook() view returns (address)",
]);
export const ROUTER_ABI = parseAbi([
  "struct LiquidityRequest { address market; int24 tickLower; int24 tickUpper; int128 liquidityDelta; uint128 amount0Limit; uint128 amount1Limit; address recipient; uint256 deadline; }",
  "function modifyLiquidity(LiquidityRequest) returns (int256)",
  "function factory() view returns (address)", "function poolManager() view returns (address)",
  "function liquidityOf(address,address,int24,int24) view returns (uint128)",
]);
export const STATE_ABI = parseAbi([
  "function poolManager() view returns (address)",
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);
const ORACLE_ABI = parseAbi([
  "function observationCount() view returns (uint256)",
  "function observations(uint256) view returns (uint64 t,uint32 cents,bytes32 emailId)",
]);
export const TARGET_FIELDS = ["wallet", "market", "factory", "router", "poolManager", "currency", "oracle", "stateView", "hook"];
export function sameAddress(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
export function validateTarget(target) {
  for (const f of TARGET_FIELDS) if (!isAddress(target[f]) || /^0x0{40}$/i.test(target[f])) throw new Error(`Invalid target.${f}`);
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) throw new Error("Invalid target.chainId");
}

/** All contract reads are pinned to one chain block. The target must be operator supplied, not model output. */
export async function readV4State(publicClient, target, trackedPositions = null) {
  validateTarget(target);
  if (await publicClient.getChainId() !== target.chainId) throw new Error("Target chain mismatch");
  const block = await publicClient.getBlock();
  const blockNumber = block.number;
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args, blockNumber });
  const [registered, poolKey, factoryManager, factoryCurrency, factoryOracle, factoryHook, marketFactory,
    marketCurrency, marketOracle, routerFactory, routerManager, viewManager] = await Promise.all([
    read(target.factory, FACTORY_ABI, "isMarket", [target.market]), read(target.factory, FACTORY_ABI, "poolKey", [target.market]),
    read(target.factory, FACTORY_ABI, "poolManager"), read(target.factory, FACTORY_ABI, "currency"),
    read(target.factory, FACTORY_ABI, "oracle"), read(target.factory, FACTORY_ABI, "hook"),
    read(target.market, MARKET_ABI, "factory"), read(target.market, MARKET_ABI, "currency"), read(target.market, MARKET_ABI, "oracle"),
    read(target.router, ROUTER_ABI, "factory"), read(target.router, ROUTER_ABI, "poolManager"), read(target.stateView, STATE_ABI, "poolManager"),
  ]);
  if (!registered || !sameAddress(factoryManager, target.poolManager) || !sameAddress(factoryCurrency, target.currency)
    || !sameAddress(factoryOracle, target.oracle) || !sameAddress(factoryHook, target.hook)
    || !sameAddress(marketFactory, target.factory) || !sameAddress(marketCurrency, target.currency)
    || !sameAddress(marketOracle, target.oracle) || !sameAddress(routerFactory, target.factory)
    || !sameAddress(routerManager, target.poolManager) || !sameAddress(viewManager, target.poolManager)
    || !sameAddress(poolKey.hooks, target.hook) || poolKey.fee !== 0x800000 || poolKey.tickSpacing !== 60) {
    throw new Error("Immutable deployment wiring mismatch");
  }
  const { encodeAbiParameters, keccak256 } = await import("viem");
  const poolId = keccak256(encodeAbiParameters(
    [{type:"address"},{type:"address"},{type:"uint24"},{type:"int24"},{type:"address"}],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
  const [decimals, rentDecimals, currencyBalance, rentBalance, residualShares, strikeLowCents, strikeHighCents,
    saleEnd, obsStart, obsEnd, tradingOpen, removalOpen, slot, count] = await Promise.all([
    read(target.currency, ERC20_ABI, "decimals"), read(target.market, ERC20_ABI, "decimals"),
    read(target.currency, ERC20_ABI, "balanceOf", [target.wallet]), read(target.market, ERC20_ABI, "balanceOf", [target.wallet]),
    read(target.market, MARKET_ABI, "residualShares", [target.wallet]), read(target.market, MARKET_ABI, "strikeLowCents"),
    read(target.market, MARKET_ABI, "strikeHighCents"), read(target.market, MARKET_ABI, "saleEnd"),
    read(target.market, MARKET_ABI, "obsStart"), read(target.market, MARKET_ABI, "obsEnd"),
    read(target.market, MARKET_ABI, "tradingOpen"), read(target.market, MARKET_ABI, "liquidityRemovalOpen"),
    read(target.stateView, STATE_ABI, "getSlot0", [poolId]), read(target.oracle, ORACLE_ABI, "observationCount"),
  ]);
  if (decimals !== rentDecimals || ![6,18].includes(decimals)) throw new Error("Unsupported token decimals");
  const start = count > 32n ? count - 32n : 0n;
  const prints = await Promise.all(Array.from({length:Number(count - start)}, async (_, i) => {
    const [t, cents, emailId] = await read(target.oracle, ORACLE_ABI, "observations", [start + BigInt(i)]);
    return { t:Number(t), cents, emailId, verified:true };
  }));
  if (trackedPositions === null) {
    if (target.deploymentBlock === undefined) throw new Error("Verified deploymentBlock required for position discovery");
    const logs = await publicClient.getLogs({ address:target.router, fromBlock:BigInt(target.deploymentBlock), toBlock:blockNumber,
      event:parseAbiItem("event LiquidityModified(address indexed owner,address indexed market,bytes32 indexed positionId,int24 tickLower,int24 tickUpper,int128 liquidityDelta,int128 amount0,int128 amount1)"),
      args:{owner:target.wallet,market:target.market}, strict:true });
    if (logs.length > 1000) throw new Error("Position history exceeds bounded pilot scan");
    const positions = new Map();
    for (const {args:p} of logs) {
      const id=`${p.tickLower}:${p.tickUpper}`, old=positions.get(id);
      positions.set(id,{tickLower:p.tickLower,tickUpper:p.tickUpper,liquidity:(old?.liquidity??0n)+p.liquidityDelta});
    }
    trackedPositions=[...positions.values()].filter(p=>p.liquidity>0n);
  }
  if (trackedPositions.length > 2) throw new Error("More than two open positions; manage them explicitly before quoting");
  const positions = await Promise.all(trackedPositions.map(async p => ({tickLower:p.tickLower, tickUpper:p.tickUpper,
    liquidity: await read(target.router, ROUTER_ABI, "liquidityOf", [target.wallet, target.market, p.tickLower, p.tickUpper])})));
  return { ...target, blockNumber, timestamp:Number(block.timestamp), poolKey, decimals, currencyBalance, rentBalance,
    residualShares, strikeLowCents, strikeHighCents, saleEnd, obsStart, obsEnd, tradingOpen, removalOpen,
    sqrtPriceX96:slot[0], tick:slot[1], prints, positions };
}
