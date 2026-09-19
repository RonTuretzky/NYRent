/**
 * Pay-with-any-token CORE: pure per-chain payment-token tables, Uniswap v3
 * exact-output path encoding, slippage math and friendly swap-revert copy.
 *
 * No react, no wagmi, no JSON imports — everything here is unit-testable
 * under `node --test` (src/lib/swap.test.ts). The hooks that consume these
 * tables live in chain/swap.ts; the transaction builders in chain/router.ts.
 *
 * ROUTING MODEL (single contract version): the app never talks to Uniswap's
 * SwapRouter02 directly anymore. Every non-currency payment goes through our
 * own SwapAndBuyRouter (`deployment.router`) in ONE transaction:
 * pull/wrap tokenIn → exact-output swap to the quoted premium → buy → refund
 * dust. The only thing quoted client-side is the expected input amount
 * (QuoterV2), used to compute the `amountInMaximum` slippage cap.
 */
import { encodePacked, type Address, type Hex } from "viem";
import type { DecodedTxError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Chain ids + canonical addresses (checksummed, verified against explorers)
// ---------------------------------------------------------------------------

export const GNOSIS = 100;
export const ARBITRUM = 42161;
export const POLYGON = 137;

/** Uniswap QuoterV2 per chain — used for exact-output quotes only. */
export const QUOTERS: Record<number, Address> = {
  [GNOSIS]: "0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4",
  [ARBITRUM]: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
};

// Gnosis (pool currency: WXDAI, 18 dec)
export const WXDAI: Address = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
export const USDCE_GNOSIS: Address =
  "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0";
export const GNO: Address = "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb";
/** Old bridged USDC — QuoterV2 reverts on it; listed only to explain itself. */
export const OLD_USDC_GNOSIS: Address =
  "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83";

// Arbitrum One (pool currency: native USDC, 6 dec)
export const USDC_ARBITRUM: Address =
  "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const WETH_ARBITRUM: Address =
  "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
export const USDT_ARBITRUM: Address =
  "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
export const USDCE_ARBITRUM: Address =
  "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
export const ARB_ARBITRUM: Address =
  "0x912CE59144191C1204E64559FE8253a0e49E6548";

// Verified live fee tiers
export const FEE_WXDAI_USDCE = 100; // 0.01% — Gnosis WXDAI/USDC.e
export const FEE_GNO_USDCE = 3000; // 0.30% — Gnosis GNO/USDC.e
export const FEE_USDC_WETH = 500; // 0.05% — Arbitrum WETH/USDC
export const FEE_USDC_USDT = 100; // 0.01% — Arbitrum USDT/USDC
export const FEE_USDC_USDCE = 100; // 0.01% — Arbitrum USDC.e/USDC
export const FEE_WETH_ARB = 500; // 0.05% — Arbitrum ARB/WETH (primary)
export const FEE_WETH_ARB_FALLBACK = 3000; // 0.30% — ARB/WETH fallback

/** Default swap slippage in bps: stable↔stable pairs vs volatile pairs. */
export const SLIPPAGE_STABLE_BPS = 50;
export const SLIPPAGE_VOLATILE_BPS = 100;

// ---------------------------------------------------------------------------
// Payment-token tables (per chainId)
// ---------------------------------------------------------------------------

export type PaymentRoute =
  /** The pool currency itself: approve + buyProtection, no swap. */
  | { kind: "direct" }
  /** Native coin that IS the wrapped pool currency (xDAI on Gnosis, the
   * anvil local currency): wrap 1:1, then the direct flow takes over. */
  | { kind: "wrap" }
  /** Any other token: one SwapAndBuyRouter transaction. `path` is the
   * exact-OUTPUT path (pool currency FIRST, tokenIn LAST — reversed). */
  | {
      kind: "router";
      /** The token the router pulls (or WETH9 when paying native). */
      tokenIn: Address;
      /** Pay with the chain's native coin via msg.value (wrapped on entry;
       * dust refunds come back as the wrapped token). */
      native?: boolean;
      path: Hex;
      /** Alternate fee tier tried when the primary pool has no quote. */
      fallbackPath?: Hex;
      /** Shallow liquidity: show a mild depth warning, nothing scarier. */
      thin?: boolean;
    }
  /** Held token we can't route — visible, disabled, with the reason. */
  | { kind: "unroutable"; reason: string };

export interface PaymentToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  /** undefined for the native coin */
  address?: Address;
  route: PaymentRoute;
  /** default swap slippage in bps (0 when no swap happens) */
  defaultSlippageBps: number;
  routeLabel: string;
  /** extra plain-language note shown when the token is selected */
  note?: string;
}

/**
 * Exact-output paths are encoded in REVERSE order (output token first):
 * currency ++ fee ++ mid ++ fee ++ tokenIn. The same path feeds
 * QuoterV2.quoteExactOutput and SwapAndBuyRouter.swapAndBuy.
 */
export function exactOutputPath(
  tokens: readonly Address[],
  fees: readonly number[],
): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error("path needs n tokens and n-1 fees");
  }
  const types: ("address" | "uint24")[] = ["address"];
  const values: (Address | number)[] = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    types.push("uint24", "address");
    values.push(fees[i - 1], tokens[i]);
  }
  return encodePacked(types, values);
}

const GNOSIS_TOKENS: PaymentToken[] = [
  {
    id: "wxdai",
    symbol: "WXDAI",
    name: "Wrapped xDAI",
    decimals: 18,
    address: WXDAI,
    route: { kind: "direct" },
    defaultSlippageBps: 0,
    routeLabel: "the pool's own money — no swap",
  },
  {
    id: "xdai",
    symbol: "xDAI",
    name: "xDAI (native)",
    decimals: 18,
    route: { kind: "wrap" },
    defaultSlippageBps: 0,
    routeLabel: "wraps 1:1 into WXDAI — no swap fee",
    note: "xDAI and WXDAI are the same money. We wrap exactly your price first (an extra quick confirmation); keep a little xDAI unwrapped for gas.",
  },
  {
    id: "usdce",
    symbol: "USDC.e",
    name: "USD Coin (Circle-bridged)",
    decimals: 6,
    address: USDCE_GNOSIS,
    route: {
      kind: "router",
      tokenIn: USDCE_GNOSIS,
      path: exactOutputPath([WXDAI, USDCE_GNOSIS], [FEE_WXDAI_USDCE]),
    },
    defaultSlippageBps: SLIPPAGE_STABLE_BPS,
    routeLabel: "swapped automatically via Uniswap · 0.01% pool",
  },
  {
    id: "gno",
    symbol: "GNO",
    name: "Gnosis",
    decimals: 18,
    address: GNO,
    route: {
      kind: "router",
      tokenIn: GNO,
      path: exactOutputPath(
        [WXDAI, USDCE_GNOSIS, GNO],
        [FEE_WXDAI_USDCE, FEE_GNO_USDCE],
      ),
    },
    defaultSlippageBps: SLIPPAGE_VOLATILE_BPS,
    routeLabel: "swapped automatically via Uniswap · GNO → USDC.e → WXDAI",
  },
  {
    id: "old-usdc",
    symbol: "USDC (old)",
    name: "Legacy bridged USDC",
    decimals: 6,
    address: OLD_USDC_GNOSIS,
    route: {
      kind: "unroutable",
      reason: "No Uniswap route — migrate to USDC.e",
    },
    defaultSlippageBps: 0,
    routeLabel: "",
  },
];

const ARB_PATH = exactOutputPath(
  [USDC_ARBITRUM, WETH_ARBITRUM, ARB_ARBITRUM],
  [FEE_USDC_WETH, FEE_WETH_ARB],
);
const ARB_PATH_FALLBACK = exactOutputPath(
  [USDC_ARBITRUM, WETH_ARBITRUM, ARB_ARBITRUM],
  [FEE_USDC_WETH, FEE_WETH_ARB_FALLBACK],
);
const WETH_PATH = exactOutputPath(
  [USDC_ARBITRUM, WETH_ARBITRUM],
  [FEE_USDC_WETH],
);

const ARBITRUM_TOKENS: PaymentToken[] = [
  {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    address: USDC_ARBITRUM,
    route: { kind: "direct" },
    defaultSlippageBps: 0,
    routeLabel: "the pool's own money — no swap",
  },
  {
    id: "eth",
    symbol: "ETH",
    name: "Ether (native)",
    decimals: 18,
    route: {
      kind: "router",
      tokenIn: WETH_ARBITRUM,
      native: true,
      path: WETH_PATH,
    },
    defaultSlippageBps: SLIPPAGE_VOLATILE_BPS,
    routeLabel: "swapped automatically via Uniswap · 0.05% pool — one confirmation",
    note: "Anything not needed for the swap is returned to you as WETH (usually a tiny amount).",
  },
  {
    id: "weth",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    address: WETH_ARBITRUM,
    route: { kind: "router", tokenIn: WETH_ARBITRUM, path: WETH_PATH },
    defaultSlippageBps: SLIPPAGE_VOLATILE_BPS,
    routeLabel: "swapped automatically via Uniswap · 0.05% pool",
  },
  {
    id: "usdt",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    address: USDT_ARBITRUM,
    route: {
      kind: "router",
      tokenIn: USDT_ARBITRUM,
      path: exactOutputPath([USDC_ARBITRUM, USDT_ARBITRUM], [FEE_USDC_USDT]),
    },
    defaultSlippageBps: SLIPPAGE_STABLE_BPS,
    routeLabel: "swapped automatically via Uniswap · 0.01% pool",
  },
  {
    id: "usdce",
    symbol: "USDC.e",
    name: "USD Coin (bridged)",
    decimals: 6,
    address: USDCE_ARBITRUM,
    route: {
      kind: "router",
      tokenIn: USDCE_ARBITRUM,
      path: exactOutputPath([USDC_ARBITRUM, USDCE_ARBITRUM], [FEE_USDC_USDCE]),
    },
    defaultSlippageBps: SLIPPAGE_STABLE_BPS,
    routeLabel: "swapped automatically via Uniswap · 0.01% pool",
  },
  {
    id: "arb",
    symbol: "ARB",
    name: "Arbitrum",
    decimals: 18,
    address: ARB_ARBITRUM,
    route: {
      kind: "router",
      tokenIn: ARB_ARBITRUM,
      path: ARB_PATH,
      fallbackPath: ARB_PATH_FALLBACK,
      thin: true,
    },
    defaultSlippageBps: SLIPPAGE_VOLATILE_BPS,
    routeLabel: "swapped automatically via Uniswap · ARB → WETH → USDC",
    note: "The ARB market here is on the thin side — larger purchases may get a slightly worse rate.",
  },
];

export const PAYMENT_TOKENS: Record<number, PaymentToken[]> = {
  [GNOSIS]: GNOSIS_TOKENS,
  [ARBITRUM]: ARBITRUM_TOKENS,
};

/** The slice of AppDeployment the payment tables need (structural, so this
 * module never imports the registry). */
export interface DeploymentLike {
  chainId: number;
  router?: Address;
  currency: { address: Address; symbol: string; decimals: number };
}

/**
 * Payment tokens for a deployment. Production chains use the verified tables
 * above; anything else (the anvil e2e chain) collapses to currency-direct
 * plus the 1:1 native wrap (the local test currency is WETH9-style, exactly
 * like WXDAI). Router routes are dropped when the deployment has no router.
 */
export function paymentTokensFor(d: DeploymentLike): PaymentToken[] {
  // Polygon v4 uses native USDC directly; POL is for gas, never a 1:1 wrap.
  if (d.chainId === POLYGON) return [{
    id: "usdc", symbol: "USDC", name: "USD Coin", decimals: 6,
    address: d.currency.address, route: { kind: "direct" },
    defaultSlippageBps: 0, routeLabel: "the pool's own money — no swap",
  }];
  const table = PAYMENT_TOKENS[d.chainId];
  if (table) {
    return d.router ? table : table.filter((t) => t.route.kind !== "router");
  }
  return [
    {
      id: "currency",
      symbol: d.currency.symbol,
      name: d.currency.symbol,
      decimals: d.currency.decimals,
      address: d.currency.address,
      route: { kind: "direct" },
      defaultSlippageBps: 0,
      routeLabel: "the pool's own money — no swap",
    },
    {
      id: "native",
      symbol: "xDAI",
      name: "xDAI (native)",
      decimals: 18,
      route: { kind: "wrap" },
      defaultSlippageBps: 0,
      routeLabel: `wraps 1:1 into ${d.currency.symbol} — no swap fee`,
      note: `The native coin and ${d.currency.symbol} are the same money. We wrap exactly your price first; keep a little unwrapped for gas.`,
    },
  ];
}

/** amountIn plus the slippage allowance — the swap's hard input cap. */
export function withSlippage(amountIn: bigint, slippageBps: number): bigint {
  return amountIn + (amountIn * BigInt(slippageBps)) / 10_000n;
}

/** The slippage actually applied: a finite non-negative override (bps,
 * ≤ 1000) wins, else the token's default. */
export function effectiveSlippageBps(
  token: Pick<PaymentToken, "defaultSlippageBps">,
  overrideBps?: number,
): number {
  return overrideBps !== undefined &&
    Number.isFinite(overrideBps) &&
    overrideBps >= 0
    ? Math.floor(overrideBps)
    : token.defaultSlippageBps;
}

// ---------------------------------------------------------------------------
// Friendly swap-revert copy (Uniswap string reverts + our router's errors)
// ---------------------------------------------------------------------------

const SWAP_REVERT_COPY: [RegExp, string][] = [
  [
    /\bSTF\b/,
    "The router could not pull your tokens — the allowance or your balance is short. Approve again, then retry.",
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
    "The swap deadline passed before the transaction confirmed. Try again.",
  ],
  [
    /\bSPL\b/,
    "The pool price crossed its safety limit mid-swap. Try again in a moment.",
  ],
  [
    /InvalidPath/,
    "The swap route looked wrong to the contract — refresh the page and try again.",
  ],
  [
    /NativeValueMismatch/,
    "The native amount sent didn't match the swap cap — refresh the quote and try again.",
  ],
  [
    /NativeInputNotWeth/,
    "Native-coin payments must route through the wrapped native token — refresh the page and try again.",
  ],
];

/** Overlay friendly copy for swap-leg reverts on top of the standard decode
 * path (pool errors like PremiumTooHigh keep their own copy). */
export function friendlySwapError(error: DecodedTxError): DecodedTxError {
  const haystack = [error.name, error.message, error.detail ?? ""].join("\n");
  for (const [pattern, copy] of SWAP_REVERT_COPY) {
    if (pattern.test(haystack)) {
      return { ...error, name: "SwapFailed", message: copy };
    }
  }
  return error;
}
