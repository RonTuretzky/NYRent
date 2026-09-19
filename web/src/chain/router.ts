/**
 * SwapAndBuyRouter + permissionless-pool transaction builders (NEW, single
 * contract version). Every builder returns a `TxRequest` for `useTx`, so the
 * whole buy surface shares one simulate → wallet → pending → confirmed
 * lifecycle, decoded errors and toasts.
 *
 * The uniform buy UX (see pages/Buy.tsx):
 *  - pool currency:   [approve premium] → buyProtection            (≤ 2 txs)
 *  - native == currency (Gnosis xDAI): wrap 1:1 → the direct flow  (≤ 3 txs)
 *  - anything else:   [approve tokenIn to router] → swapAndBuy     (≤ 2 txs;
 *                     exactly 1 for the chain's native coin, sent as value)
 *
 * `swapAndBuy` is atomic on-chain: pull/wrap → exact-output swap to the
 * premium → buyProtectionFor(msg.sender) → refund every unspent wei (native
 * refunds come back as the wrapped token — see src/SwapAndBuyRouter.sol).
 * The premium is re-quoted inside the same transaction, so the swap output
 * and the pool's price can never diverge.
 */
import type { Address, Hex } from "viem";
import { erc20Abi, poolAbi, routerAbi } from "./contracts.ts";
import type { TxRequest } from "./useTx.ts";
import type { DeploymentLike, PaymentToken } from "./swapCore.ts";

// ---------------------------------------------------------------------------
// Pool math (mirrors CoverPool exactly — same bigint truncation)
// ---------------------------------------------------------------------------

/** The one-time price: maxClaim × rateBps / 1e4, truncated like the pool. */
export function premiumFor(maxClaim: bigint, premiumRateBps: number): bigint {
  return (maxClaim * BigInt(premiumRateBps)) / 10_000n;
}

/** True when the pool would revert PremiumRoundsToZero: a nonzero rate whose
 * premium truncates to zero wei — the amount is too small to price. */
export function premiumRoundsToZero(
  maxClaim: bigint,
  premiumRateBps: number,
): boolean {
  return (
    maxClaim > 0n &&
    premiumRateBps > 0 &&
    premiumFor(maxClaim, premiumRateBps) === 0n
  );
}

// ---------------------------------------------------------------------------
// Direct (pool-currency) leg
// ---------------------------------------------------------------------------

/** approve(pool, amount) on the pool currency. */
export function approveCurrencyRequest(
  d: DeploymentLike & { pool: Address },
  amount: bigint,
  account?: Address,
): TxRequest {
  return {
    abi: erc20Abi,
    address: d.currency.address,
    chainId: d.chainId,
    functionName: "approve",
    args: [d.pool, amount],
    account,
  };
}

/** buyProtection(seriesId, maxClaim, maxPremium) — cover mints to the buyer. */
export function buyProtectionRequest(
  d: { pool: Address; chainId: number },
  seriesId: bigint,
  maxClaim: bigint,
  maxPremium: bigint,
  account?: Address,
): TxRequest {
  return {
    abi: poolAbi,
    address: d.pool,
    chainId: d.chainId,
    functionName: "buyProtection",
    args: [seriesId, maxClaim, maxPremium],
    account,
  };
}

/** Wrap the chain's native coin 1:1 into the WETH9-style pool currency
 * (Gnosis xDAI → WXDAI, anvil local currency). Mints to the sender. */
export function wrapNativeRequest(
  d: DeploymentLike,
  amount: bigint,
  account?: Address,
): TxRequest {
  return {
    abi: erc20Abi,
    address: d.currency.address,
    chainId: d.chainId,
    functionName: "deposit",
    args: [],
    account,
    value: amount,
  };
}

// ---------------------------------------------------------------------------
// Router (pay-with-any-token) leg
// ---------------------------------------------------------------------------

function routerAddress(d: DeploymentLike): Address {
  if (!d.router) {
    throw new Error("this deployment has no SwapAndBuyRouter");
  }
  return d.router;
}

/** approve(router, amountInMaximum) on the payment token (ERC-20 path only —
 * native payments need no approval). */
export function approveRouterRequest(
  d: DeploymentLike,
  token: PaymentToken,
  amountInMaximum: bigint,
  account?: Address,
): TxRequest {
  if (!token.address) {
    throw new Error(`${token.id} is native — no approval needed`);
  }
  return {
    abi: erc20Abi,
    address: token.address,
    chainId: d.chainId,
    functionName: "approve",
    args: [routerAddress(d), amountInMaximum],
    account,
  };
}

/**
 * swapAndBuy(tokenIn, amountInMaximum, path, seriesId, maxClaim) on our
 * router. Native payments attach `value === amountInMaximum` (the contract
 * enforces equality and wraps on entry); ERC-20 payments attach no value and
 * pull `amountInMaximum` via the prior approval. Either way every unspent
 * wei comes straight back in the same transaction.
 */
export function swapAndBuyRequest(
  d: DeploymentLike,
  route: { tokenIn: Address; native?: boolean; path: Hex },
  amountInMaximum: bigint,
  seriesId: bigint,
  maxClaim: bigint,
  account?: Address,
  pathOverride?: Hex,
): TxRequest {
  return {
    abi: routerAbi,
    address: routerAddress(d),
    chainId: d.chainId,
    functionName: "swapAndBuy",
    args: [
      route.tokenIn,
      amountInMaximum,
      pathOverride ?? route.path,
      seriesId,
      maxClaim,
    ],
    account,
    ...(route.native ? { value: amountInMaximum } : {}),
  };
}
