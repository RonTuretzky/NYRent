/**
 * Pay-with-any-token HOOKS, scoped to the ACTIVE deployment (registry
 * context) — Uniswap v3 QuoterV2 exact-output quotes, per-token balances and
 * the router allowance. The pure per-chain tables, path encoding, slippage
 * math and friendly swap-revert copy live in chain/swapCore.ts (re-exported
 * here); the transaction builders live in chain/router.ts.
 *
 * The old frontend-orchestrated multi-step swap stepper and its EIP-5792
 * batch path are gone: the on-chain SwapAndBuyRouter made them obsolete
 * (one transaction wraps/pulls, swaps exact-output to the premium, buys and
 * refunds the dust — see src/SwapAndBuyRouter.sol).
 */
import { useCallback, useEffect, useMemo } from "react";
import { parseAbi, type Address, type Hex } from "viem";
import {
  useBalance,
  useBlockNumber,
  useReadContract,
  useReadContracts,
} from "wagmi";
import { erc20Abi } from "./contracts";
import { isNetworkError } from "./errors";
import { useActiveDeployment } from "./registry";
import {
  QUOTERS,
  effectiveSlippageBps,
  paymentTokensFor,
  withSlippage,
  type PaymentToken,
} from "./swapCore";

export * from "./swapCore";

/**
 * QuoterV2's quote functions are state-mutating on-chain (they revert to
 * return data) and are meant for eth_call. Declaring them `view` makes
 * wagmi's read hooks issue exactly that eth_call.
 */
export const quoterV2Abi = parseAbi([
  "function quoteExactOutput(bytes path, uint256 amountOut) view returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** Refetch a wagmi read on every new block of the active chain. */
function useRefetchOnBlock(
  chainId: number,
  refetch: () => void,
  enabled: boolean,
) {
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    chainId,
    query: { enabled },
  });
  useEffect(() => {
    if (enabled && blockNumber !== undefined) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);
}

/** The payment-token menu for the active deployment. */
export function usePaymentTokens(): PaymentToken[] {
  const { deployment } = useActiveDeployment();
  return useMemo(() => paymentTokensFor(deployment), [deployment]);
}

// ---------------------------------------------------------------------------
// Quote hook (QuoterV2 exact-output, refreshed every block)
// ---------------------------------------------------------------------------

export interface SwapQuote {
  /** exact input the quoter reports for the requested exact output */
  amountIn?: bigint;
  /** amountIn plus the slippage allowance — the swap's hard input cap */
  amountInMaximum?: bigint;
  /** slippage actually applied, in bps */
  slippageBps: number;
  /** the executable path behind the numbers (primary or fallback fee tier) */
  path?: Hex;
  /** true when the primary pool had no quote and the fallback tier answered */
  usedFallback: boolean;
  isLoading: boolean;
  /** transport/network failure only — never set for empty data or reverts */
  rpcError: boolean;
  /** the quoter reverted on every tier (no route / no liquidity) */
  quoteFailed: boolean;
  refetch: () => void;
}

/**
 * Exact-output quote: what does `premiumWei` of the pool currency cost in
 * the selected token? Slippage defaults to 50 bps for stable pairs / 100 bps
 * for volatile ones (chain/swapCore.ts), overridable from the advanced
 * disclosure. Tokens with a `fallbackPath` (thin primary pool) quietly retry
 * the alternate fee tier when the primary has no quote.
 */
export function useSwapQuote(
  token: PaymentToken | undefined,
  premiumWei: bigint | undefined,
  slippageBpsOverride?: number,
): SwapQuote {
  const { deployment } = useActiveDeployment();
  const chainId = deployment.chainId;
  const quoter = QUOTERS[chainId];
  const route = token && token.route.kind === "router" ? token.route : undefined;
  const slippageBps = effectiveSlippageBps(
    token ?? { defaultSlippageBps: 0 },
    slippageBpsOverride,
  );
  const wantQuote =
    !!route &&
    !!quoter &&
    !!deployment.router &&
    premiumWei !== undefined &&
    premiumWei > 0n;

  const primary = useReadContract({
    abi: quoterV2Abi,
    address: quoter,
    chainId,
    functionName: "quoteExactOutput",
    args: [route?.path ?? "0x", premiumWei ?? 0n],
    query: { enabled: wantQuote },
  });
  const primaryQuoteFailed =
    wantQuote && primary.isError && !isNetworkError(primary.error);
  const wantFallback =
    wantQuote && primaryQuoteFailed && route?.fallbackPath !== undefined;
  const fallback = useReadContract({
    abi: quoterV2Abi,
    address: quoter,
    chainId,
    functionName: "quoteExactOutput",
    args: [route?.fallbackPath ?? "0x", premiumWei ?? 0n],
    query: { enabled: wantFallback },
  });

  const refetch = useCallback(() => {
    primary.refetch();
    if (wantFallback) fallback.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary.refetch, fallback.refetch, wantFallback]);
  useRefetchOnBlock(chainId, refetch, wantQuote);

  if (!wantQuote || !route) {
    return {
      slippageBps,
      usedFallback: false,
      isLoading: false,
      rpcError: false,
      quoteFailed: false,
      refetch,
    };
  }

  const usedFallback = primaryQuoteFailed && fallback.data !== undefined;
  const read = usedFallback ? fallback : primary;
  const amountIn =
    read.data !== undefined ? (read.data[0] as bigint) : undefined;
  const amountInMaximum =
    amountIn !== undefined ? withSlippage(amountIn, slippageBps) : undefined;
  const rpcError =
    (primary.isError && isNetworkError(primary.error)) ||
    (wantFallback && fallback.isError && isNetworkError(fallback.error));
  const quoteFailed =
    primaryQuoteFailed &&
    (route.fallbackPath === undefined ||
      (fallback.isError && !isNetworkError(fallback.error)));
  return {
    amountIn,
    amountInMaximum,
    slippageBps,
    path: usedFallback ? route.fallbackPath : route.path,
    usedFallback,
    isLoading: primary.isLoading || (wantFallback && fallback.isLoading),
    rpcError,
    quoteFailed,
    refetch,
  };
}

// ---------------------------------------------------------------------------
// Balances + router allowance for the token menu
// ---------------------------------------------------------------------------

export interface PaymentBalances {
  /** balance per PaymentToken id (native tokens read the native balance) */
  byId: Record<string, bigint | undefined>;
  isLoading: boolean;
  refetch: () => void;
}

/** Wallet balances for every token in the active chain's payment menu. */
export function usePaymentBalances(
  tokens: PaymentToken[],
  address: Address | undefined,
): PaymentBalances {
  const { deployment } = useActiveDeployment();
  const chainId = deployment.chainId;
  const erc20Tokens = useMemo(
    () => tokens.filter((t): t is PaymentToken & { address: Address } => !!t.address),
    [tokens],
  );
  const hasNative = tokens.some((t) => !t.address);

  const nativeRead = useBalance({
    address,
    chainId,
    query: { enabled: !!address && hasNative },
  });
  const owner = address ?? deployment.currency.address;
  const erc20Read = useReadContracts({
    allowFailure: true,
    contracts: erc20Tokens.map((t) => ({
      abi: erc20Abi,
      address: t.address,
      chainId,
      functionName: "balanceOf",
      args: [owner],
    })),
    query: { enabled: !!address && erc20Tokens.length > 0 },
  });

  const refetch = useCallback(() => {
    if (hasNative) nativeRead.refetch();
    if (erc20Tokens.length > 0) erc20Read.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeRead.refetch, erc20Read.refetch, hasNative, erc20Tokens.length]);
  useRefetchOnBlock(chainId, refetch, !!address);

  const byId = useMemo(() => {
    const out: Record<string, bigint | undefined> = {};
    tokens.forEach((t) => {
      if (!t.address) {
        out[t.id] = nativeRead.data?.value;
        return;
      }
      const i = erc20Tokens.findIndex((e) => e.id === t.id);
      const r = i >= 0 ? erc20Read.data?.[i] : undefined;
      out[t.id] =
        r?.status === "success" ? (r.result as unknown as bigint) : undefined;
    });
    return out;
  }, [tokens, erc20Tokens, nativeRead.data, erc20Read.data]);

  return {
    byId,
    isLoading: nativeRead.isLoading || erc20Read.isLoading,
    refetch,
  };
}

/** The selected token's allowance for our SwapAndBuyRouter (ERC-20 router
 * routes only — native payments need no approval). */
export function useRouterAllowance(
  token: PaymentToken | undefined,
  address: Address | undefined,
): { allowance?: bigint; refetch: () => void } {
  const { deployment } = useActiveDeployment();
  const chainId = deployment.chainId;
  const enabled =
    !!address &&
    !!deployment.router &&
    !!token &&
    !!token.address &&
    token.route.kind === "router" &&
    !token.route.native;
  const read = useReadContract({
    abi: erc20Abi,
    address: token?.address ?? deployment.currency.address,
    chainId,
    functionName: "allowance",
    args: [
      address ?? deployment.currency.address,
      deployment.router ?? deployment.currency.address,
    ],
    query: { enabled },
  });
  useRefetchOnBlock(chainId, read.refetch, enabled);
  return {
    allowance: enabled ? (read.data as bigint | undefined) : undefined,
    refetch: read.refetch,
  };
}
