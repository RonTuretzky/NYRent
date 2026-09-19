/** Exact integer price/amount math. sqrtRatioAtTick follows Uniswap v4-core TickMath
 * (MIT), pinned at 59d3ecf53afa9264a16bba0e38f4c5d2231f80bc. Token units never use floats. */
export const Q96 = 1n << 96n;
const MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n, 0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n, 0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n, 0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n, 0x48a170391f7dc42444e8fa2n,
];
export function sqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new Error("Invalid tick");
  const abs = Math.abs(tick);
  let ratio = 1n << 128n;
  for (let i = 0; i < MULTIPLIERS.length; i++) if (abs & (1 << i)) ratio = ratio * MULTIPLIERS[i] >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) ? 1n : 0n);
}
const div = (a, b, up) => (a + (up ? b - 1n : 0n)) / b;
export function amountsForLiquidity(sqrt, lowerTick, upperTick, liquidity, roundUp = false) {
  const a = sqrtRatioAtTick(lowerTick), b = sqrtRatioAtTick(upperTick);
  if (a >= b || liquidity < 0n) throw new Error("Invalid position");
  const p = sqrt < a ? a : sqrt > b ? b : sqrt;
  return [div(liquidity * (b - p) * Q96, p * b, roundUp), div(liquidity * (p - a), Q96, roundUp)];
}
export function liquidityForAmounts(sqrt, lowerTick, upperTick, amount0, amount1) {
  const a = sqrtRatioAtTick(lowerTick), b = sqrtRatioAtTick(upperTick);
  if (a >= b || amount0 < 0n || amount1 < 0n) throw new Error("Invalid position amounts");
  if (sqrt <= a) return amount0 * a * b / (Q96 * (b - a));
  if (sqrt >= b) return amount1 * Q96 / (b - a);
  const l0 = amount0 * sqrt * b / (Q96 * (b - sqrt));
  const l1 = amount1 * Q96 / (sqrt - a);
  return l0 < l1 ? l0 : l1;
}
export function rentPrice(sqrt, rentIs0) {
  const raw = (Number(sqrt) / 2 ** 96) ** 2;
  return rentIs0 ? raw : 1 / raw;
}
/** Align a desired RENT price band to tickSpacing, while keeping it strictly one-sided at the snapshot. */
export function quoteTicks(lowPrice, highPrice, side, rentIs0, spotTick, spacing) {
  if (!(lowPrice > 0 && highPrice > lowPrice) || !["bid", "ask"].includes(side)) throw new Error("Invalid price band");
  const rawLow = rentIs0 ? lowPrice : 1 / highPrice;
  const rawHigh = rentIs0 ? highPrice : 1 / lowPrice;
  let lower = Math.floor(Math.log(rawLow) / Math.log(1.0001) / spacing) * spacing;
  let upper = Math.ceil(Math.log(rawHigh) / Math.log(1.0001) / spacing) * spacing;
  const above = (side === "ask") === rentIs0;
  if (above) lower = Math.max(lower, (Math.ceil(spotTick / spacing) + 1) * spacing);
  else upper = Math.min(upper, (Math.floor(spotTick / spacing) - 1) * spacing);
  if (lower >= upper || lower < -887220 || upper > 887220) return null;
  return { tickLower: lower, tickUpper: upper };
}
