/**
 * targets.mjs — THE per-chain deployment registry for the market-maker agent
 * runner (run.mjs). One entry per live deployment of the PERMISSIONLESS
 * CoverPool stack (src/CoverPool.sol — NO roles: anyone escrows capacity via
 * createSeries; only per-series creator levers exist).
 *
 * Frozen from the 2026-09-19 deployments and re-verified by RPC the same day
 * (seriesCount() == 0 on both pools; currency() matches on both):
 *
 *   - gnosis   (chainId 100):   WXDAI (18 decimals), executor "direct"
 *                               (the agent wallet signs with DEPLOYER_PRIVATE_KEY)
 *   - arbitrum (chainId 42161): native USDC (6 decimals), executor "bankr"
 *                               (Bankr-custodied wallet; Bankr supports Arbitrum,
 *                               NOT Gnosis — docs.bankr.bot/getting-started/
 *                               supported-chains. LIVE Bankr-custodied execution
 *                               is out of scope for this workflow: dry runs build
 *                               the tx list, fork-proofs prove it, and the
 *                               operator runs the first live Bankr action
 *                               separately after review.)
 *
 * ALL capital math is in the target currency's own base units (1e-18 WXDAI,
 * 1e-6 USDC). The per-run caps are the POLICY's constants — see
 * policy/decide.mjs (MAX_SELL_ESCROW_MILLIUNITS / MAX_BUY_NOTIONAL_MILLIUNITS /
 * dustUnits), parameterized by each target's currency.decimals; nothing in
 * this file (or anywhere else) may assume 18 decimals.
 *
 * NOTE executors/targets.mjs is the executor layer's view of the SAME frozen
 * deployments (keyed by name, addresses nested under .addresses, used by
 * executors/index.mjs routing). targets.test.mjs cross-checks the two
 * registries address-for-address so they can never drift apart.
 */
import { parseAbi } from "viem";
import { gnosis, arbitrum } from "viem/chains";

// ---------------------------------------------------------------------------
// ABIs used by the runner (views + the P&L events; the executor layer keeps
// its own POOL_ABI with the write entry points in executors/targets.mjs)
// ---------------------------------------------------------------------------

export const POOL_ABI = parseAbi([
  "struct Series { address creator; uint32 strikeLowCents; uint32 strikeHighCents; uint16 premiumRateBps; bool settled; bool cancelled; uint64 saleEnd; uint64 obsStart; uint64 obsEnd; uint64 redeemEnd; uint128 escrow; uint128 sold; uint128 premiumsAccrued; uint128 paidOut; uint256 withdrawn; bool residualWithdrawn; uint64 payoutRatioWad; uint64 observationT; bytes32 emailId; }",
  "function seriesCount() view returns (uint256)",
  "function series(uint256 seriesId) view returns (Series)",
  "function seriesPaused(uint256 seriesId) view returns (bool)",
  "function quote(uint256 seriesId, uint256 maxClaim) view returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)",
  "function currency() view returns (address)",
  // events — the cumulative P&L accounting in run.mjs filters on the indexed
  // buyer/holder/creator topics, so one cheap getLogs per event type suffices
  "event SeriesCreated(uint256 indexed seriesId, address indexed creator, uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity)",
  "event ProtectionBought(uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 maxClaim, uint256 premium)",
  "event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 amount, uint256 payout)",
  "event ResidualWithdrawn(uint256 indexed seriesId, address indexed creator, uint256 amount)",
  "event SeriesCancelled(uint256 indexed seriesId, address indexed creator, uint256 refund)",
  "event SeriesSettled(uint256 indexed seriesId, uint256 obsIndex, uint64 payoutRatioWad, uint32 cents, uint64 observationT, bytes32 emailId)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** CoverToken (ERC-1155, SOULBOUND): id = seriesId, amount = max-claim units. */
export const COVER_TOKEN_ABI = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

export const ORACLE_ABI = parseAbi([
  "function observationCount() view returns (uint256)",
  "function observations(uint256 i) view returns (uint64 t, uint32 cents, bytes32 emailId)",
]);

// ---------------------------------------------------------------------------
// The registry (frozen 2026-09-19 deployments)
// ---------------------------------------------------------------------------

export const TARGETS = [
  {
    name: "gnosis",
    chainId: 100,
    chain: gnosis, // viem chain object
    rpcEnv: "GNOSIS_RPC_URL", // env override, tried first when set
    rpcs: ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com"],
    pool: "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3",
    token: "0x821d100Aa36Beec16D830C7E2B8D5249AF62C857",
    oracle: "0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43",
    router: "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b",
    currency: {
      address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
      symbol: "WXDAI",
      decimals: 18,
    },
    executor: "direct",
    explorerTx: (hash) => `https://gnosis.blockscout.com/tx/${hash}`,
  },
  {
    name: "arbitrum",
    chainId: 42161,
    chain: arbitrum,
    rpcEnv: "ARBITRUM_RPC_URL",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    pool: "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c",
    token: "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E",
    oracle: "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3",
    router: "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F",
    currency: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native (Circle) USDC
      symbol: "USDC",
      decimals: 6,
    },
    executor: "bankr",
    explorerTx: (hash) => `https://arbitrum.blockscout.com/tx/${hash}`,
  },
];

/** Look a target up by name or chainId; throws on unknown (fail loud, not quiet). */
export function getTarget(nameOrChainId) {
  const t = TARGETS.find(
    (x) => x.name === String(nameOrChainId) || String(x.chainId) === String(nameOrChainId),
  );
  if (!t) {
    throw new Error(
      `unknown target "${nameOrChainId}" — known: ${TARGETS.map((x) => x.name).join(", ")}`,
    );
  }
  return t;
}

/** The RPC url list for a target: env override (if set) first, then the registry list. */
export function rpcUrlsFor(target, env = process.env) {
  const override = env[target.rpcEnv];
  return override ? [override, ...target.rpcs] : [...target.rpcs];
}

/** Format a currency base-unit amount for humans: "0.5 WXDAI" / "0.5 USDC". */
export function fmtUnits(units, currency) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const unit = 10n ** BigInt(currency.decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(currency.decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""} ${currency.symbol}`;
}
