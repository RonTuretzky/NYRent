import { fairValue } from "../policy/valuation.mjs";
import { amountsForLiquidity, liquidityForAmounts, quoteTicks, rentPrice, sqrtRatioAtTick } from "./math.mjs";

export const V4_POLICY = Object.freeze({
  edgeBps: 100, widthBps: 500, maxLeanBps: 500, maxSignalAgeSec: 45 * 86400,
  planLifetimeSec: 180, cutoffBufferSec: 900, slippageBps: 100,
  // Same 0.5-currency-unit pilot scale as the existing fixed-rate agent.
  maxMintMilliunits: 500, maxBidCurrencyMilliunits: 500, maxBidRentMilliunits: 500,
  maxAskRentMilliunits: 500, maxOutstandingCollateralMilliunits: 2000,
});
const min = (a, b) => a < b ? a : b;
const units = (milli, decimals) => BigInt(milli) * 10n ** BigInt(decimals) / 1000n;
const amount = (n) => { const a = BigInt(n); if (a < 0n) throw new Error("Negative balance"); return a; };

/** Pure Bachelier -> two concentrated LP quotes. state must come from readV4State at one block.
 * The policy only uses signed oracle observations; external text cannot become a trading signal here.
 * Existing positions are explicitly unwound before replacement, with integer minimum receipts. */
export function planV4Quotes(state, policyOverrides = {}) {
  const cfg = { ...V4_POLICY, ...policyOverrides };
  if (![6, 18].includes(state.decimals) || state.poolKey.tickSpacing !== 60) throw new Error("Unsupported market units");
  for (const [k, v] of Object.entries(cfg)) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid policy ${k}`);
  if (cfg.slippageBps > 500 || cfg.edgeBps < 60 || cfg.widthBps < 60 || cfg.widthBps > 5000
    || cfg.maxLeanBps > 2500 || cfg.planLifetimeSec > 300) throw new Error("Unsafe quote policy");
  const now = Number(state.timestamp), sqrt = amount(state.sqrtPriceX96);
  const rentIs0 = state.poolKey.currency0.toLowerCase() === state.market.toLowerCase();
  const target = Object.fromEntries(["chainId", "wallet", "market", "factory", "router", "poolManager", "currency", "oracle", "stateView", "hook"].map(k => [k, state[k]]));
  const plan = {
    version: 1, target, decidedAtBlock: BigInt(state.blockNumber), decidedAt: now,
    validUntil: now + cfg.planLifetimeSec, sqrtPriceX96: sqrt, poolKey: state.poolKey,
    collateralBefore: amount(state.residualShares), mintAmount: 0n, removals: [], quotes: [],
    refused: false, rationale: [], valuation: null, inventoryLeanBps: 0,
  };
  if (!Number.isSafeInteger(now) || now <= 0 || sqrt === 0n) throw new Error("Invalid chain snapshot");
  if ((state.positions ?? []).length > 2) throw new Error("At most two tracked quote positions");
  let currencyAvailable = amount(state.currencyBalance), rentAvailable = amount(state.rentBalance);
  for (const position of state.positions ?? []) {
    const liquidity = amount(position.liquidity);
    if (liquidity === 0n) continue;
    if (position.tickLower % 60 || position.tickUpper % 60) throw new Error("Invalid tracked position ticks");
    const [a0, a1] = amountsForLiquidity(sqrt, position.tickLower, position.tickUpper, liquidity);
    const min0 = a0 * BigInt(10000 - cfg.slippageBps) / 10000n;
    const min1 = a1 * BigInt(10000 - cfg.slippageBps) / 10000n;
    plan.removals.push({ ...position, liquidity, amount0Minimum: min0, amount1Minimum: min1 });
    rentAvailable += rentIs0 ? min0 : min1;
    currencyAvailable += rentIs0 ? min1 : min0;
  }
  if (!state.removalOpen) { plan.removals = []; plan.refused = true; plan.rationale.push("Observation lock: no LP action."); return plan; }
  if (!state.tradingOpen || now + cfg.cutoffBufferSec >= Number(state.saleEnd)) {
    plan.rationale.push("Trading is closed or near cutoff; only unwind tracked positions."); return plan;
  }
  // Old authentic prints still estimate volatility. Freshness gates the latest signal, not the history.
  const history = (state.prints ?? []).filter(p => p.verified === true && p.t <= now && p.t > 0
    && Number.isFinite(p.cents) && p.cents > 0);
  const prints = history.some(p=>now-p.t<=cfg.maxSignalAgeSec) ? history : [];
  const valuation = fairValue({ strikeLowCents: Number(state.strikeLowCents), strikeHighCents: Number(state.strikeHighCents),
    obsStart: Number(state.obsStart), obsEnd: Number(state.obsEnd) }, { prints }, now);
  if (!valuation) { plan.rationale.push("No fresh signed oracle signal; unwind only."); return plan; }
  plan.valuation = valuation;
  const askCap = units(cfg.maxAskRentMilliunits, state.decimals);
  const mintCap = units(cfg.maxMintMilliunits, state.decimals);
  const outstandingCap = units(cfg.maxOutstandingCollateralMilliunits, state.decimals);
  const bidCashCap = units(cfg.maxBidCurrencyMilliunits, state.decimals);
  const bidRentCap = units(cfg.maxBidRentMilliunits, state.decimals);
  const targetInventory = askCap / 2n;
  const imbalance = targetInventory === 0n ? 0 : Number((rentAvailable - targetInventory) * 10000n / targetInventory);
  plan.inventoryLeanBps = Math.round(Math.max(-1, Math.min(1, imbalance / 10000)) * cfg.maxLeanBps);
  const lean = 1 - plan.inventoryLeanBps / 10000;
  const fair = valuation.ratioBps / 10000 * lean;
  const askFair = valuation.premiumBps / 10000 * lean;
  const spot = rentPrice(sqrt, rentIs0), edge = cfg.edgeBps / 10000, width = cfg.widthBps / 10000;
  const bidHigh = Math.min(fair * (1 - edge), spot * (1 - edge), 0.999);
  const askLow = Math.max(askFair * (1 + edge), spot * (1 + edge), 0.0001);
  const bidRange = bidHigh > 0.0001 ? quoteTicks(Math.max(0.0001, bidHigh * (1 - width)), bidHigh, "bid", rentIs0, state.tick, 60) : null;
  const askRange = askLow < 0.999 ? quoteTicks(askLow, Math.min(0.9999, askLow * (1 + width)), "ask", rentIs0, state.tick, 60) : null;
  const shortage = askCap > rentAvailable ? askCap - rentAvailable : 0n;
  const collateralRoom = outstandingCap > plan.collateralBefore ? outstandingCap - plan.collateralBefore : 0n;
  if (askRange) plan.mintAmount = min(shortage, min(mintCap, min(collateralRoom, currencyAvailable)));
  currencyAvailable -= plan.mintAmount;
  rentAvailable += plan.mintAmount;
  for (const [side, range] of [["bid", bidRange], ["ask", askRange]]) {
    if (!range) continue;
    const budget = side === "bid" ? min(currencyAvailable, bidCashCap) : min(rentAvailable, askCap);
    if (budget <= 2n) continue;
    const token0Funded = (side === "ask") === rentIs0;
    let liquidity = liquidityForAmounts(sqrt, range.tickLower, range.tickUpper,
      token0Funded ? budget - 1n : 0n, token0Funded ? 0n : budget - 1n);
    if (side === "bid") {
      // Cap maximum acquired RENT at the far edge, independently of its discounted cash price.
      const endSqrt = sqrtRatioAtTick(rentIs0 ? range.tickLower : range.tickUpper);
      const capLiquidity = liquidityForAmounts(endSqrt, range.tickLower, range.tickUpper,
        rentIs0 ? bidRentCap : 0n, rentIs0 ? 0n : bidRentCap);
      liquidity = min(liquidity, capLiquidity);
    }
    liquidity = liquidity * 99n / 100n;
    if (liquidity <= 0n) continue;
    const [max0, max1] = amountsForLiquidity(sqrt, range.tickLower, range.tickUpper, liquidity, true);
    plan.quotes.push({ side, ...range, liquidity, amount0Maximum: max0, amount1Maximum: max1 });
  }
  plan.rationale.push(`Bachelier fair ${valuation.ratioBps} bps; sell loading ${valuation.premiumBps} bps; inventory lean ${plan.inventoryLeanBps} bps.`,
    "Capital stays escrowed; LP swap fees are separate from the valuation loading. Quotes may fill and lose money.");
  return plan;
}
