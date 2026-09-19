import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { parseAbi, type Address, type Hex } from "viem";
import raw from "./v4-deployments.json";
import { useActiveDeployment } from "./registry";
import { rentPoolId, rentSpotPrice, type RentPoolKey } from "./v4Math";

export interface V4Deployment {
  chainId: number;
  market: Address;
  factory: Address;
  hook: Address;
  router: Address;
  poolManager: Address;
  stateView: Address;
  quoter: Address;
  observationSubmitter?: Address;
  oracle: Address;
  currency: Address;
  decimals: number;
  symbol: string;
  deploymentBlock: string;
  /** Verified oracle observation used to choose the immutable base. */
  baseObservationIndex: number;
  poolKey: RentPoolKey;
}

export const V4_DEPLOYMENTS = raw as Record<string, V4Deployment>;
export const v4MarketReadAbi = parseAbi([
  "function baseRentCents() view returns (uint32)",
  "function strikeLowCents() view returns (uint32)",
  "function strikeHighCents() view returns (uint32)",
  "function saleEnd() view returns (uint64)",
  "function obsStart() view returns (uint64)",
  "function obsEnd() view returns (uint64)",
  "function redeemEnd() view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function escrowAccounted() view returns (uint256)",
  "function settled() view returns (bool)",
  "function payoutRatioWad() view returns (uint64)",
  "function tradingOpen() view returns (bool)",
  "function liquidityRemovalOpen() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function residualShares(address) view returns (uint256)",
  "function residualOf(address) view returns (uint256)",
  "function depositAndMint(uint256 amount,address recipient)",
  "function redeem(uint256 amount,address recipient) returns (uint256)",
  "function withdrawResidual(address recipient) returns (uint256)",
  "function settle(uint256 observationIndex)",
]);
export const v4StateAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut,uint256 gasEstimate)",
  "function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn,uint256 gasEstimate)",
]);

export function useV4Market() {
  const { chainId } = useActiveDeployment();
  const deployment = V4_DEPLOYMENTS[String(chainId)];
  const client = usePublicClient({ chainId });
  const query = useQuery({
    queryKey: ["v4-market", chainId, deployment?.market],
    enabled: !!deployment && !!client,
    refetchInterval: 15000,
    queryFn: async () => {
      if (!deployment || !client) throw new Error("Trading market is not deployed here");
      const read = <N extends "baseRentCents" | "strikeLowCents" | "strikeHighCents" | "saleEnd" | "obsStart" | "obsEnd" | "redeemEnd" | "totalSupply" | "totalDeposited" | "escrowAccounted" | "settled" | "payoutRatioWad" | "tradingOpen" | "liquidityRemovalOpen">(functionName: N) =>
        client.readContract({ address: deployment.market, abi: v4MarketReadAbi, functionName });
      const poolId = rentPoolId(deployment.poolKey);
      const [baseCents, strikeLowCents, strikeHighCents, saleEnd, obsStart, obsEnd, redeemEnd,
        supply, deposited, escrow, settled, payoutRatioWad, tradingOpen, removalOpen, slot, liquidity, base] = await Promise.all([
        read("baseRentCents"), read("strikeLowCents"), read("strikeHighCents"), read("saleEnd"), read("obsStart"), read("obsEnd"), read("redeemEnd"),
        read("totalSupply"), read("totalDeposited"), read("escrowAccounted"), read("settled"), read("payoutRatioWad"), read("tradingOpen"), read("liquidityRemovalOpen"),
        client.readContract({ address: deployment.stateView, abi: v4StateAbi, functionName: "getSlot0", args: [poolId] }),
        client.readContract({ address: deployment.stateView, abi: v4StateAbi, functionName: "getLiquidity", args: [poolId] }),
        client.readContract({ address: deployment.oracle, abi: parseAbi(["function observations(uint256) view returns (uint64 t,uint32 cents,bytes32 emailId)"]), functionName: "observations", args: [BigInt(deployment.baseObservationIndex)] }),
      ]);
      return { baseCents, strikeLowCents, strikeHighCents, saleEnd, obsStart, obsEnd, redeemEnd, supply, deposited, escrow,
        settled, payoutRatioWad, tradingOpen, removalOpen, liquidity, sqrtPriceX96: slot[0], tick: slot[1], poolId,
        baseVerified: base[1] === baseCents && base[0] >= 1788220800n && base[0] < 1790812800n,
        p: rentSpotPrice(slot[0], deployment.poolKey, deployment.market),
      };
    },
  });
  return { deployment, ...query };
}

export type V4PoolId = Hex;
