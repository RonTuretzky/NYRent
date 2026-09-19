/**
 * Pay-with-any-token support: Uniswap v3 on Gnosis (SwapRouter02 + QuoterV2)
 * plus the native-xDAI → WXDAI wrap path. Everything here is exact-OUTPUT:
 * the premium in WXDAI is deterministic (rate × maxClaim), so we swap for
 * exactly that amount and cap the input with a slippage allowance.
 *
 * Addresses were cast-verified against rpc.gnosischain.com (chainId 100);
 * SwapRouter02.WETH9() == WXDAI, so the router's wrapped-native is our pool
 * currency.
 */
import { useCallback, useEffect, useState } from "react";
import {
  encodeFunctionData,
  encodePacked,
  parseAbi,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
} from "viem";
import {
  useBalance,
  useBlockNumber,
  useConfig,
  useReadContract,
  useReadContracts,
} from "wagmi";
import {
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { deployment } from "./deployment";
import { erc20Abi, poolAbi } from "./contracts";
import { decodeTxError, isNetworkError, type DecodedTxError } from "./errors";
import { pushTxToast, updateTxToast } from "./txToasts";
import type { TxRequest, TxState } from "./useTx";

// ---------------------------------------------------------------------------
// Addresses (Gnosis, chainId 100)
// ---------------------------------------------------------------------------

export const SWAP_ROUTER_02 =
  "0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be" as Address;
export const QUOTER_V2 =
  "0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4" as Address;
export const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0" as Address;
export const GNO = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb" as Address;
/** Old bridged USDC — QuoterV2 reverts on it; excluded from routing. */
export const OLD_USDC =
  "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83" as Address;
/** The pool currency IS WXDAI on Gnosis (WETH9-style, payable deposit()). */
export const WXDAI = deployment.currency;

/** Uniswap fee tiers used by the verified live pools. */
export const FEE_WXDAI_USDCE = 100; // 0.01% — pool 0xf5E4…AA2E (~$103k)
export const FEE_GNO_USDCE = 3000; // 0.30% — pool 0x777d…E679 (~$1.08M)

export const SWAP_DEADLINE_SECONDS = 600n;

/** Swap routes only exist on Gnosis mainnet; on e2e/anvil chains the token
 * menu collapses to native-wrap + direct currency. */
export const swapsAvailable = deployment.chainId === 100;

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

export const swapRouter02Abi = parseAbi([
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum) params) payable returns (uint256 amountIn)",
  // MulticallExtended variant: SwapRouter02's exactOutput* structs carry no
  // deadline field — the deadline is enforced by this wrapper.
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

/**
 * QuoterV2's quote functions are state-mutating on-chain (they revert to
 * return data) and are meant to be used via eth_call/callStatic. Declaring
 * them `view` here makes wagmi's read hooks issue exactly that eth_call.
 */
export const quoterV2Abi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutput(bytes path, uint256 amountOut) view returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export const wxdaiAbi = parseAbi(["function deposit() payable"]);

/** ERC20 allowance/approve/balanceOf/decimals/symbol (re-export: the
 * generated module already carries the exact minimal set). */
export { erc20Abi };

// ---------------------------------------------------------------------------
// Payment-token table
// ---------------------------------------------------------------------------

export type PaymentTokenId = "xdai" | "wxdai" | "usdce" | "gno";

export type PaymentRoute =
  | { kind: "direct" }
  | { kind: "wrap" }
  | { kind: "single"; tokenIn: Address; fee: number }
  | { kind: "multi"; tokenIn: Address };

export interface PaymentToken {
  id: PaymentTokenId;
  symbol: string;
  name: string;
  decimals: number;
  /** undefined for the native coin */
  address?: Address;
  route: PaymentRoute;
  /** default swap slippage in bps (50 stable single-hop, 100 GNO multihop) */
  defaultSlippageBps: number;
  routeLabel: string;
}

export const PAYMENT_TOKENS: Record<PaymentTokenId, PaymentToken> = {
  wxdai: {
    id: "wxdai",
    symbol: "WXDAI",
    name: "Wrapped xDAI",
    decimals: 18,
    address: WXDAI,
    route: { kind: "direct" },
    defaultSlippageBps: 0,
    routeLabel: "pool currency — no swap",
  },
  xdai: {
    id: "xdai",
    symbol: "xDAI",
    name: "xDAI (native)",
    decimals: 18,
    route: { kind: "wrap" },
    defaultSlippageBps: 0,
    routeLabel: "wrap only, 1:1 — no swap fee",
  },
  usdce: {
    id: "usdce",
    symbol: "USDC.e",
    name: "USD Coin (Circle-bridged)",
    decimals: 6,
    address: USDCE,
    route: { kind: "single", tokenIn: USDCE, fee: FEE_WXDAI_USDCE },
    defaultSlippageBps: 50,
    routeLabel: "via Uniswap v3 · 0.01% pool",
  },
  gno: {
    id: "gno",
    symbol: "GNO",
    name: "Gnosis",
    decimals: 18,
    address: GNO,
    route: { kind: "multi", tokenIn: GNO },
    defaultSlippageBps: 100,
    routeLabel: "via Uniswap v3 · GNO → USDC.e 0.30% → WXDAI 0.01%",
  },
};

export const PAYMENT_TOKEN_ORDER: PaymentTokenId[] = [
  "wxdai",
  "xdai",
  "usdce",
  "gno",
];

/**
 * Exact-output paths are encoded in REVERSE order (output token first):
 * WXDAI ++ fee(WXDAI/USDC.e) ++ USDC.e ++ fee(GNO/USDC.e) ++ GNO.
 * The same reversed path feeds both QuoterV2.quoteExactOutput and
 * SwapRouter02.exactOutput.
 */
export const GNO_EXACT_OUTPUT_PATH: Hex = encodePacked(
  ["address", "uint24", "address", "uint24", "address"],
  [WXDAI, FEE_WXDAI_USDCE, USDCE, FEE_GNO_USDCE, GNO],
);

// ---------------------------------------------------------------------------
// Call plans
// ---------------------------------------------------------------------------

/** A raw call, ready for EIP-5792 wallet_sendCalls batching. */
export interface PlannedCall {
  to: Address;
  data: Hex;
  value?: bigint;
}

export function swapDeadline(nowSec?: bigint): bigint {
  return (nowSec ?? BigInt(Math.floor(Date.now() / 1000))) + SWAP_DEADLINE_SECONDS;
}

/** Wrap plan: WXDAI.deposit{value: premium} — mints premium WXDAI to sender. */
export function buildWrapCall(premiumWei: bigint): PlannedCall {
  return {
    to: WXDAI,
    data: encodeFunctionData({ abi: wxdaiAbi, functionName: "deposit" }),
    value: premiumWei,
  };
}

/** approve(SwapRouter02, amountInMaximum) on the input token. */
export function buildSwapApproveCall(
  tokenId: PaymentTokenId,
  amountInMaximum: bigint,
): PlannedCall {
  const token = PAYMENT_TOKENS[tokenId];
  if (!token.address) throw new Error(`${tokenId} has no ERC20 address`);
  return {
    to: token.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_02, amountInMaximum],
    }),
  };
}

function encodeExactOutput(
  tokenId: PaymentTokenId,
  premiumWei: bigint,
  amountInMaximum: bigint,
  recipient: Address,
): Hex {
  const route = PAYMENT_TOKENS[tokenId].route;
  if (route.kind === "single") {
    return encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn: route.tokenIn,
          tokenOut: WXDAI,
          fee: route.fee,
          recipient,
          amountOut: premiumWei,
          amountInMaximum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }
  if (route.kind === "multi") {
    return encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactOutput",
      args: [
        {
          path: GNO_EXACT_OUTPUT_PATH,
          recipient,
          amountOut: premiumWei,
          amountInMaximum,
        },
      ],
    });
  }
  throw new Error(`token ${tokenId} has no swap route`);
}

/**
 * Swap plan: SwapRouter02.multicall(deadline, [exactOutput(Single)]) with
 * recipient = the USER (WXDAI lands in their wallet; the buy then pulls it).
 */
export function buildSwapCall(
  tokenId: PaymentTokenId,
  premiumWei: bigint,
  amountInMaximum: bigint,
  recipient: Address,
  deadline?: bigint,
): PlannedCall {
  const inner = encodeExactOutput(tokenId, premiumWei, amountInMaximum, recipient);
  return {
    to: SWAP_ROUTER_02,
    data: encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [deadline ?? swapDeadline(), [inner]],
    }),
  };
}

/** Same swap as buildSwapCall, shaped for the sequential useTx flow. */
export function buildSwapTxRequest(
  tokenId: PaymentTokenId,
  premiumWei: bigint,
  amountInMaximum: bigint,
  recipient: Address,
  deadline?: bigint,
): TxRequest {
  const inner = encodeExactOutput(tokenId, premiumWei, amountInMaximum, recipient);
  return {
    abi: swapRouter02Abi,
    address: SWAP_ROUTER_02,
    functionName: "multicall",
    args: [deadline ?? swapDeadline(), [inner]],
    account: recipient,
  };
}

/** approve(pool, maxPremium) on WXDAI. */
export function buildPoolApproveCall(maxPremium: bigint): PlannedCall {
  return {
    to: WXDAI,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [deployment.pool, maxPremium],
    }),
  };
}

/** buyProtection(seriesId, maxClaim, maxPremium) on the pool. */
export function buildBuyCall(
  seriesId: bigint,
  maxClaim: bigint,
  maxPremium: bigint,
): PlannedCall {
  return {
    to: deployment.pool,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName: "buyProtection",
      args: [seriesId, maxClaim, maxPremium],
    }),
  };
}

export interface BuyBatchOptions {
  tokenId: PaymentTokenId;
  premiumWei: bigint;
  maxPremium: bigint;
  /** required when tokenId routes through Uniswap */
  amountInMaximum?: bigint;
  recipient: Address;
  seriesId: bigint;
  maxClaim: bigint;
  needsPoolApproval: boolean;
  needsSwapApproval: boolean;
  deadline?: bigint;
}

/**
 * Full one-confirmation call list for EIP-5792 wallets:
 * [swap-approve?, swap?] | [wrap?] then [wxdai-approve?, buy].
 */
export function buildBuyBatch(opts: BuyBatchOptions): PlannedCall[] {
  const route = PAYMENT_TOKENS[opts.tokenId].route;
  const calls: PlannedCall[] = [];
  if (route.kind === "wrap") {
    calls.push(buildWrapCall(opts.premiumWei));
  } else if (route.kind === "single" || route.kind === "multi") {
    if (opts.amountInMaximum === undefined) {
      throw new Error("amountInMaximum required for swap routes");
    }
    if (opts.needsSwapApproval) {
      calls.push(buildSwapApproveCall(opts.tokenId, opts.amountInMaximum));
    }
    calls.push(
      buildSwapCall(
        opts.tokenId,
        opts.premiumWei,
        opts.amountInMaximum,
        opts.recipient,
        opts.deadline,
      ),
    );
  }
  if (opts.needsPoolApproval) {
    calls.push(buildPoolApproveCall(opts.maxPremium));
  }
  calls.push(buildBuyCall(opts.seriesId, opts.maxClaim, opts.maxPremium));
  return calls;
}

// ---------------------------------------------------------------------------
// Quote hook (QuoterV2, refreshed every block)
// ---------------------------------------------------------------------------

function useRefetchOnBlockLocal(refetch: () => void, enabled: boolean) {
  const { data: blockNumber } = useBlockNumber({
    watch: true,
    query: { enabled },
  });
  useEffect(() => {
    if (enabled && blockNumber !== undefined) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber]);
}

export interface SwapQuote {
  /** exact input the quoter reports for the requested exact output */
  amountIn?: bigint;
  /** amountIn plus the slippage allowance — the swap's hard input cap */
  amountInMaximum?: bigint;
  /** slippage actually applied, in bps */
  slippageBps: number;
  isLoading: boolean;
  /** transport/network failure only — never set for empty data or reverts */
  rpcError: boolean;
  /** the quoter itself reverted (no route / no liquidity) */
  quoteFailed: boolean;
  refetch: () => void;
}

/**
 * Exact-output quote for premiumWei of WXDAI paid in the selected token.
 * Slippage: 50 bps stable single-hop / 100 bps GNO multihop by default,
 * overridable from the advanced disclosure.
 */
export function useSwapQuote(
  tokenId: PaymentTokenId,
  premiumWei: bigint | undefined,
  slippageBpsOverride?: number,
): SwapQuote {
  const token = PAYMENT_TOKENS[tokenId];
  const route = token.route;
  const slippageBps =
    slippageBpsOverride !== undefined &&
    Number.isFinite(slippageBpsOverride) &&
    slippageBpsOverride >= 0
      ? Math.floor(slippageBpsOverride)
      : token.defaultSlippageBps;
  const wantQuote =
    swapsAvailable &&
    (route.kind === "single" || route.kind === "multi") &&
    premiumWei !== undefined &&
    premiumWei > 0n;

  const singleRead = useReadContract({
    abi: quoterV2Abi,
    address: QUOTER_V2,
    functionName: "quoteExactOutputSingle",
    args: [
      {
        tokenIn: route.kind === "single" ? route.tokenIn : USDCE,
        tokenOut: WXDAI,
        amount: premiumWei ?? 0n,
        fee: route.kind === "single" ? route.fee : FEE_WXDAI_USDCE,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: wantQuote && route.kind === "single" },
  });
  const multiRead = useReadContract({
    abi: quoterV2Abi,
    address: QUOTER_V2,
    functionName: "quoteExactOutput",
    args: [GNO_EXACT_OUTPUT_PATH, premiumWei ?? 0n],
    query: { enabled: wantQuote && route.kind === "multi" },
  });

  const read = route.kind === "multi" ? multiRead : singleRead;
  useRefetchOnBlockLocal(read.refetch, wantQuote);

  if (!wantQuote) {
    return {
      slippageBps,
      isLoading: false,
      rpcError: false,
      quoteFailed: false,
      refetch: read.refetch,
    };
  }
  const amountIn =
    read.data !== undefined ? (read.data[0] as bigint) : undefined;
  const amountInMaximum =
    amountIn !== undefined
      ? amountIn + (amountIn * BigInt(slippageBps)) / 10_000n
      : undefined;
  const rpcError = read.isError && isNetworkError(read.error);
  return {
    amountIn,
    amountInMaximum,
    slippageBps,
    isLoading: read.isLoading,
    rpcError,
    quoteFailed: read.isError && !rpcError,
    refetch: read.refetch,
  };
}

// ---------------------------------------------------------------------------
// Balance + allowance hooks for the token menu
// ---------------------------------------------------------------------------

export interface PaymentBalances {
  native?: bigint;
  wxdai?: bigint;
  usdce?: bigint;
  gno?: bigint;
  oldUsdc?: bigint;
  isLoading: boolean;
  refetch: () => void;
}

export function usePaymentBalances(address: Address | undefined): PaymentBalances {
  const nativeRead = useBalance({
    address,
    query: { enabled: !!address },
  });
  const owner = address ?? deployment.pool;
  const erc20Read = useReadContracts({
    allowFailure: true,
    contracts: [
      { abi: erc20Abi, address: WXDAI, functionName: "balanceOf", args: [owner] },
      { abi: erc20Abi, address: USDCE, functionName: "balanceOf", args: [owner] },
      { abi: erc20Abi, address: GNO, functionName: "balanceOf", args: [owner] },
      {
        abi: erc20Abi,
        address: OLD_USDC,
        functionName: "balanceOf",
        args: [owner],
      },
    ],
    query: { enabled: !!address && swapsAvailable },
  });
  const wxdaiOnlyRead = useReadContract({
    abi: erc20Abi,
    address: WXDAI,
    functionName: "balanceOf",
    args: [owner],
    query: { enabled: !!address && !swapsAvailable },
  });
  const refetch = useCallback(() => {
    nativeRead.refetch();
    if (swapsAvailable) erc20Read.refetch();
    else wxdaiOnlyRead.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeRead.refetch, erc20Read.refetch, wxdaiOnlyRead.refetch]);
  useRefetchOnBlockLocal(refetch, !!address);

  const [wx, usd, gno, old] = erc20Read.data ?? [];
  const pick = (r?: { status: string; result?: unknown }) =>
    r?.status === "success" ? (r.result as bigint) : undefined;
  return {
    native: nativeRead.data?.value,
    wxdai: swapsAvailable
      ? pick(wx)
      : (wxdaiOnlyRead.data as bigint | undefined),
    usdce: pick(usd),
    gno: pick(gno),
    oldUsdc: pick(old),
    isLoading:
      nativeRead.isLoading || erc20Read.isLoading || wxdaiOnlyRead.isLoading,
    refetch,
  };
}

export function useRouterAllowance(
  tokenId: PaymentTokenId,
  address: Address | undefined,
): { allowance?: bigint; refetch: () => void } {
  const token = PAYMENT_TOKENS[tokenId];
  const enabled =
    swapsAvailable &&
    !!address &&
    !!token.address &&
    (token.route.kind === "single" || token.route.kind === "multi");
  const read = useReadContract({
    abi: erc20Abi,
    address: token.address ?? WXDAI,
    functionName: "allowance",
    args: [address ?? deployment.pool, SWAP_ROUTER_02],
    query: { enabled },
  });
  useRefetchOnBlockLocal(read.refetch, enabled);
  return {
    allowance: enabled ? (read.data as bigint | undefined) : undefined,
    refetch: read.refetch,
  };
}

// ---------------------------------------------------------------------------
// Wrap runner (useTx cannot attach msg.value; this mirrors its lifecycle)
// ---------------------------------------------------------------------------

export function useWrapTx(): {
  state: TxState;
  reset: () => void;
  wrap: (valueWei: bigint, account?: Address) => Promise<TxState>;
} {
  const config = useConfig();
  const [state, setState] = useState<TxState>({ status: "idle" });
  const reset = useCallback(() => setState({ status: "idle" }), []);

  const wrap = useCallback(
    async (valueWei: bigint, account?: Address): Promise<TxState> => {
      const label = "Wrap xDAI";
      let final: TxState;
      let hash: Hex | undefined;
      let toastId: string | undefined;
      let cancelled = false;
      try {
        setState({ status: "simulating" });
        const sim = await simulateContract(config, {
          abi: wxdaiAbi,
          address: WXDAI,
          functionName: "deposit",
          value: valueWei,
          account,
        });
        setState({ status: "wallet" });
        hash = await writeContract(config, sim.request);
        setState({ status: "pending", hash });
        toastId = pushTxToast({ hash, label, status: "pending" });
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          timeout: 120_000,
          onReplaced: (replacement) => {
            cancelled = replacement.reason === "cancelled";
            hash = replacement.transaction.hash;
            setState({ status: "pending", hash: replacement.transaction.hash });
            if (toastId) {
              updateTxToast(toastId, {
                hash: replacement.transaction.hash,
                status: "replaced",
              });
            }
          },
        });
        const minedHash = receipt.transactionHash;
        if (cancelled) {
          const error: DecodedTxError = {
            name: "Cancelled",
            kind: "rejected",
            message:
              "You cancelled the wrap in your wallet before it was mined — nothing was executed.",
          };
          final = { status: "reverted", hash: minedHash, error };
          if (toastId) {
            updateTxToast(toastId, {
              hash: minedHash,
              status: "failed",
              error: error.message,
            });
          }
        } else if (receipt.status === "reverted") {
          const error: DecodedTxError = {
            name: "Reverted",
            kind: "revert",
            message: "The wrap transaction was mined but reverted on-chain.",
          };
          final = { status: "reverted", hash: minedHash, error };
          if (toastId) {
            updateTxToast(toastId, {
              hash: minedHash,
              status: "failed",
              error: error.message,
            });
          }
        } else {
          final = {
            status: "confirmed",
            hash: minedHash,
            receipt: {
              blockNumber: receipt.blockNumber,
              logs: receipt.logs.map((l) => ({
                address: l.address,
                data: l.data,
                topics: l.topics,
              })),
            },
          };
          if (toastId) {
            updateTxToast(toastId, { hash: minedHash, status: "confirmed" });
          }
        }
      } catch (error) {
        const decoded = decodeTxError(error);
        const timedOut =
          error instanceof WaitForTransactionReceiptTimeoutError;
        if (hash && (timedOut || decoded.kind === "network")) {
          const stillPending: DecodedTxError = {
            name: "StillPending",
            kind: "network",
            message: timedOut
              ? "Not confirmed after 120 seconds — the wrap may still go through. Track it on the explorer before re-submitting."
              : "Lost contact with the RPC while waiting — the wrap may still confirm. Track it on the explorer before re-submitting.",
            detail: decoded.detail ?? decoded.message,
          };
          final = { status: "stillPending", hash, error: stillPending };
          if (toastId) {
            updateTxToast(toastId, {
              status: "pending",
              error: stillPending.message,
            });
          }
        } else {
          final = { status: "reverted", hash, error: decoded };
          if (toastId && hash) {
            updateTxToast(toastId, {
              status: "failed",
              error: decoded.message,
            });
          }
        }
      }
      setState(final);
      return final;
    },
    [config],
  );

  return { state, reset, wrap };
}

// ---------------------------------------------------------------------------
// Swap-specific revert copy + EIP-5792 capability probe
// ---------------------------------------------------------------------------

const SWAP_REVERT_COPY: [RegExp, string][] = [
  [
    /\bSTF\b/,
    "The router could not pull your tokens — the swap allowance or your balance is short. Approve the router again, then retry.",
  ],
  [
    /Too much requested/i,
    "The swap would cost more than your slippage cap — the price moved. Refresh the quote or raise the swap slippage.",
  ],
  [
    /Too little received/i,
    "The swap returned less than the minimum — the price moved. Refresh the quote or raise the swap slippage.",
  ],
  [
    /Transaction too old/i,
    "The 10-minute swap deadline passed before the transaction confirmed. Start the swap step again.",
  ],
  [
    /\bSPL\b/,
    "The pool price crossed its safety limit mid-swap. Try again in a moment.",
  ],
];

/** Overlay friendly copy for SwapRouter02's string reverts on top of the
 * standard decode path. */
export function friendlySwapError(error: DecodedTxError): DecodedTxError {
  const haystack = [error.name, error.message, error.detail ?? ""].join("\n");
  for (const [pattern, copy] of SWAP_REVERT_COPY) {
    if (pattern.test(haystack)) {
      return { ...error, name: "SwapFailed", message: copy };
    }
  }
  return error;
}

/**
 * EIP-5792 atomic-batch detection across capability shapes: per-chain maps
 * keyed by number or hex, `atomic.status` (current spec) or the older
 * `atomicBatch.supported`.
 */
export function supportsAtomicBatch(
  capabilities: unknown,
  chainId: number,
): boolean {
  if (!capabilities || typeof capabilities !== "object") return false;
  const record = capabilities as Record<string | number, unknown>;
  const forChain =
    record[chainId] ?? record[`0x${chainId.toString(16)}`] ?? capabilities;
  if (!forChain || typeof forChain !== "object") return false;
  const caps = forChain as {
    atomic?: { status?: string };
    atomicBatch?: { supported?: boolean };
  };
  return (
    caps.atomic?.status === "supported" ||
    caps.atomic?.status === "ready" ||
    caps.atomicBatch?.supported === true
  );
}
