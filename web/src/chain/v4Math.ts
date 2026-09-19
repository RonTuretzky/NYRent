import { encodeAbiParameters, keccak256, type Address } from "viem";

export interface RentPoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function rentPoolId(key: RentPoolKey) {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

/** Display only. RENT mirrors collateral decimals, so the decimal ratio is 1. */
export function rentSpotPrice(sqrtPriceX96: bigint, key: RentPoolKey, rent: Address): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const token1PerToken0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return key.currency0.toLowerCase() === rent.toLowerCase() ? token1PerToken0 : 1 / token1PerToken0;
}

export const MAX_TRADE_PRICE_IMPACT_BPS = 1000n;

/** Reference conversion at the pre-trade pool price; both tokens have the same decimals. */
export function spotOutput(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  if (amountIn <= 0n || sqrtPriceX96 <= 0n) return 0n;
  const ratio = sqrtPriceX96 * sqrtPriceX96;
  const q192 = 1n << 192n;
  return zeroForOne ? amountIn * ratio / q192 : amountIn * q192 / ratio;
}

/** Output shortfall from spot, including pool fees. Round up for the UI's trade limit. */
export function quotePriceImpact(amountIn: bigint, amountOut: bigint, sqrtPriceX96: bigint, zeroForOne: boolean) {
  const atSpot = spotOutput(amountIn, sqrtPriceX96, zeroForOne);
  const shortfall = atSpot > amountOut ? atSpot - amountOut : 0n;
  const bps = atSpot > 0n ? (shortfall * 10000n + atSpot - 1n) / atSpot : null;
  return { atSpot, bps, blocked: bps === null || bps > MAX_TRADE_PRICE_IMPACT_BPS || amountOut <= 1n };
}

/** Integer bound used for signing; never converts token amounts to floating point. */
export function minimumOutput(quoted: bigint, slippageBps = 100): bigint {
  if (quoted <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new Error("Invalid quote or slippage");
  }
  const minimum = quoted * BigInt(10000 - slippageBps) / 10000n;
  if (minimum === 0n) throw new Error("Amount is too small to protect against slippage");
  return minimum;
}

// TickMath.getSqrtPriceAtTick(±887220), the full range for tickSpacing 60.
export const FULL_RANGE_LOWER = -887220;
export const FULL_RANGE_UPPER = 887220;
const SQRT_LOWER = 4306310044n;
const SQRT_UPPER = 1457652066949847389969617340386294118487833376468n;
const Q96 = 2n ** 96n;

export function fullRangeLiquidity(sqrt: bigint, maximum0: bigint, maximum1: bigint): bigint {
  if (sqrt <= SQRT_LOWER || sqrt >= SQRT_UPPER || maximum0 <= 1n || maximum1 <= 1n) return 0n;
  const l0 = (maximum0 - 1n) * sqrt * SQRT_UPPER / (Q96 * (SQRT_UPPER - sqrt));
  const l1 = (maximum1 - 1n) * Q96 / (sqrt - SQRT_LOWER);
  return (l0 < l1 ? l0 : l1) * 99n / 100n;
}

export function fullRangeAmounts(sqrt: bigint, liquidity: bigint): readonly [bigint, bigint] {
  const p = sqrt < SQRT_LOWER ? SQRT_LOWER : sqrt > SQRT_UPPER ? SQRT_UPPER : sqrt;
  return [liquidity * (SQRT_UPPER - p) * Q96 / (p * SQRT_UPPER), liquidity * (p - SQRT_LOWER) / Q96];
}
