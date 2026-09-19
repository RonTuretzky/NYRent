/**
 * executors/targets.mjs — per-target (per-chain) configuration for the agent
 * EXECUTOR layer: full write ABIs (entry points + custom errors for revert
 * decoding) plus the target registry in the executors' shape.
 *
 * The runner-facing registry (../targets.mjs) carries the same addresses with
 * read-only ABIs (views + P&L events); THIS module is the executors' single
 * import (see the note in ../targets.mjs). The two registries are pinned to
 * the same frozen 2026-09-19 deployments — address-for-address — and
 * verified live the same day (code present at every address; the Arbitrum
 * pool's currency() == the native USDC address below).
 *
 * The permissionless CoverPool is deployed on TWO chains and the agent runs
 * the same two-sided market-maker policy against each, with ALL clamp/capital
 * math in that target's currency units (Gnosis WXDAI = 18 decimals, Arbitrum
 * native USDC = 6 decimals — "0.5 units" means 5e17 on Gnosis and 5e5 on
 * Arbitrum; nothing in the executor layer may assume 18 decimals).
 *
 * Executor routing (executors/index.mjs):
 *   - gnosis   -> Direct only. Bankr has NO Gnosis support
 *                 (https://docs.bankr.bot/getting-started/supported-chains).
 *   - arbitrum -> Bankr custody preferred when the triple gate passes
 *                 (see executors/bankr.mjs), else Direct.
 */
import { gnosis, arbitrum } from "viem/chains";
import { parseAbi } from "viem";

/** CoverPool (permissionless, src/CoverPool.sol) — views, creator levers, buys, errors. */
export const POOL_ABI = parseAbi([
  "struct Series { address creator; uint32 strikeLowCents; uint32 strikeHighCents; uint16 premiumRateBps; bool settled; bool cancelled; uint64 saleEnd; uint64 obsStart; uint64 obsEnd; uint64 redeemEnd; uint128 escrow; uint128 sold; uint128 premiumsAccrued; uint128 paidOut; uint256 withdrawn; bool residualWithdrawn; uint64 payoutRatioWad; uint64 observationT; bytes32 emailId; }",
  "function seriesCount() view returns (uint256)",
  "function series(uint256 seriesId) view returns (Series)",
  "function seriesPaused(uint256 seriesId) view returns (bool)",
  "function quote(uint256 seriesId, uint256 maxClaim) view returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)",
  "function currency() view returns (address)",
  "function MIN_REDEEM_WINDOW() view returns (uint64)",
  // permissionless underwriting + buys
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256 seriesId)",
  "function addCapacity(uint256 seriesId, uint128 amount)",
  "function setSeriesPaused(uint256 seriesId, bool paused)",
  "function cancelSeries(uint256 seriesId)",
  "function withdrawResidual(uint256 seriesId)",
  "function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium)",
  "function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient)",
  "function settle(uint256 seriesId, uint256 obsIndex)",
  "function redeem(uint256 seriesId, uint256 amount)",
  // errors (for revert decoding)
  "error NotCreator()",
  "error ZeroAddress()",
  "error InvalidSeries()",
  "error InvalidParams(string what)",
  "error SaleClosed()",
  "error SalesArePaused()",
  "error SeriesClosed()",
  "error ZeroAmount()",
  "error CapacityExceeded()",
  "error PremiumTooHigh(uint256 premium, uint256 maxPremium)",
  "error PremiumRoundsToZero()",
  "error AlreadySettled()",
  "error NotSettled()",
  "error ObservationOutOfWindow(uint64 t)",
  "error RedeemWindowClosed()",
  "error RedeemWindowOpen()",
  "error AlreadySold()",
  "error ResidualAlreadyWithdrawn()",
]);

/** Minimal ERC-20 (both pool currencies are standard: WXDAI 18d, native USDC 6d). */
export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

/** CoverToken (ERC-1155, SOULBOUND): id = seriesId, amount = max-claim units. */
export const COVER_TOKEN_ABI = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

/** One target entry: flat addresses + the executors' {addresses} map (same data). */
function makeTarget(t) {
  return {
    ...t,
    addresses: { pool: t.pool, oracle: t.oracle, token: t.token, router: t.router, currency: t.currency.address },
  };
}

export const TARGETS = {
  gnosis: makeTarget({
    name: "gnosis",
    chainId: 100,
    chain: gnosis,
    rpcEnv: "GNOSIS_RPC_URL",
    defaultRpcUrl: "https://rpc.gnosischain.com",
    explorerTx: (hash) => `https://gnosis.blockscout.com/tx/${hash}`,
    pool: "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3",
    token: "0x821d100Aa36Beec16D830C7E2B8D5249AF62C857",
    oracle: "0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43",
    router: "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b",
    currency: { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18 },
    // Bankr supports Base/Ethereum/Polygon/Unichain/World Chain/Arbitrum/BNB/
    // Robinhood/Arc/Solana/Hyperliquid — NOT Gnosis:
    // https://docs.bankr.bot/getting-started/supported-chains
    executor: "direct",
    bankrSupported: false,
  }),
  arbitrum: makeTarget({
    name: "arbitrum",
    chainId: 42161,
    chain: arbitrum,
    rpcEnv: "ARBITRUM_RPC_URL",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerTx: (hash) => `https://arbitrum.blockscout.com/tx/${hash}`,
    pool: "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c",
    token: "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E",
    oracle: "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3",
    router: "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F",
    currency: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
    executor: "bankr",
    bankrSupported: true,
  }),
};

/**
 * Resolve a target: accepts a name ("gnosis" | "arbitrum"), a chainId, or an
 * already-resolved target object (pass-through, for tests/forks).
 */
export function getTarget(nameOrTarget) {
  if (nameOrTarget && typeof nameOrTarget === "object") return nameOrTarget;
  const t =
    TARGETS[nameOrTarget] ??
    Object.values(TARGETS).find((x) => String(x.chainId) === String(nameOrTarget));
  if (!t) throw new Error(`unknown target "${nameOrTarget}" (known: ${Object.keys(TARGETS).join(", ")})`);
  return t;
}

/** RPC URL for a target: env override (target.rpcEnv) wins, else the default. */
export function targetRpcUrl(target) {
  return process.env[target.rpcEnv] || target.defaultRpcUrl;
}
