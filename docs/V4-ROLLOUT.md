# RENT / Uniswap v4 rollout evidence and constraints

Reviewed 2026-09-19. This document separates observed chain state, local/fork verification, and remaining launch work. The target is the single **Manhattan Rent Cover, Sep 2026 → Sep 2027** market from the supplied product specification, using the existing CRE Daily DKIM oracle. Bankr remains on hold.

## Venue and canonical contracts

Arbitrum One and Polygon PoS are supported v4 deployment targets for this build. The original Arbitrum review follows; see the Polygon section below for its separate addresses and readiness. The [official Uniswap deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments) lists the following addresses. On 2026-09-19 at Arbitrum block **506883069**, read-only `eth_getCode` independently found nonempty code at all five addresses shown below.

| Contract | Arbitrum One address | Observed code bytes |
| --- | --- | ---: |
| PoolManager | `0x360e68faccca8ca495c1b759fd9eee466db9fb32` | 24,009 |
| PositionManager | `0xd88f38f930b7952f2db2432cb002e7abbf3dd869` | 23,877 |
| Quoter | `0x3972c00f7ed4885e145823eb7c655375d275a1c5` | 5,820 |
| StateView | `0x76fd297e2d437cd7f76d50f01afe6160f86e9990` | 3,531 |
| Universal Router | `0xa51afafe0263b40edaef0df8781ea9aa03e381a3` | 19,499 |

The same registry also lists Universal Router 2.1.1 at `0x8b844f885672f333bc0042cb669255f93a4c1e6b` and Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Those two addresses were source-checked, but not included in this run's bytecode checks. Do not silently substitute router versions without matching their command encoding and testing the resulting route.

No Gnosis deployment appears in the official v4 registry checked for this report. Existing Gnosis v3 contracts and the Gnosis RentSafe deployment do not establish a canonical Gnosis v4 venue. A separately deployed local PoolManager is a useful test fixture; it is not a canonical production deployment.

Anvil successfully started with `--fork-url https://arb1.arbitrum.io/rpc --fork-block-number 506883069`, returned chain ID 42161 and that block, and read the canonical PoolManager's 24,009-byte runtime code. This proves current public-RPC fork availability. It does not prove any new hook, pool, liquidity, or swap has been deployed on mainnet.

Native Arbitrum USDC is `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (six decimals). Normalize RENT and USDC units explicitly in mint, payout, price, approval, quote, and liquidity code. Sort `currency0`/`currency1` by address; derive `sqrtPriceX96` from that ordering and both decimal counts. The reciprocal price is required when RENT is currency1. Read pool state by PoolId through StateView; v4 has a singleton, not one pool contract per market.

## Read-only funding snapshot

The existing deployer is `0x6636A1CCBdf54485067304C1a590DE016DeaD9F0`. No secrets were read and no funds were moved to produce this snapshot.

| Network / block | Native gas balance | Collateral balance | Current oracle observations |
| --- | ---: | ---: | ---: |
| Arbitrum One / 506883069 | 0.000392174698987836 ETH | 0.013480 USDC | 0 |
| Gnosis / 48335778 | 0.001016760043720806 xDAI | 0.318246300000000000 WXDAI | 1 |

These were read at approximately **20:11 UTC on 2026-09-19**, using the public chain RPCs. Arbitrum's observed gas price was **20,016,000 wei**. The Arbitrum oracle checked was `0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3`; the Gnosis oracle was `0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43`. Refresh balances, gas estimates, allowance state, and pending nonces immediately before an authorized broadcast.

The available Arbitrum collateral permits only a tiny smoke position. Gas estimates must cover all deployments, authentic observation ingestion, approvals, collateral mint, pool initialization, liquidity, buy/sell, and verification transactions as a complete batch. Existing Bankr balances are outside this rollout's funding rail.

Read-only Arbitrum `eth_estimateGas` checks against the initial compiled implementation produced this partial budget. The helper, immutable prefix, and factory view used state overrides for the last three checks; these simulated undeployed contracts and left the existing production oracle's code and storage intact. The oracle verified the real fixture during the hybrid-submit simulation.

| Operation | Estimated gas |
| --- | ---: |
| Factory deployment, including correctly salted hook | 3,683,651 |
| Chunk submitter deployment | 591,219 |
| Store one 24,000-byte prefix | 5,380,404 |
| Hybrid submission to existing authentic oracle | 3,771,861 |
| Router deployment | 1,580,044 |
| **Partial subtotal** | **15,007,179** |

At the snapshot gas price that subtotal is about **0.000300384 ETH**, leaving roughly **0.000091791 ETH** before market creation, approvals, collateral mint, liquidity, and smoke swaps. There is no deployment safety buffer in those numbers. A complete fixed-fork transaction rehearsal and fresh estimates are required before deciding whether the available gas balance covers the launch. The hybrid observation call's measured calldata is **80,228 bytes**. Compilation artifacts, nonce, constructor arguments, and fee conditions can change these estimates.

## Authentic observation submission on Arbitrum

The existing fixture has 1,378 signed-header bytes, a 102,197-byte canonical body, and a 256-byte signature. ABI-encoded `submitObservation(bytes,bytes,bytes)` is **104,068 bytes**. Both `https://arb1.arbitrum.io/rpc` and `https://arbitrum-one-rpc.publicnode.com` returned gas estimate **0x3c2760 = 3,942,240** for this exact call against the existing Arbitrum oracle during this review. No transaction was submitted by the reviewer.

That estimate proves execution can be simulated; it does not establish sequencer admission. [Nitro's sequencer source](https://github.com/OffchainLabs/nitro/blob/master/execution/gethexec/sequencer.go) defaults `MaxTxDataSize` to 95,000 bytes and rejects oversized queued transactions. This is a transport limit independent of the oracle's verification logic. A Foundry test that calls the oracle inside a test transaction also does not exercise that admission check.

The additive `ChunkedObservationSubmitter` helper reconstructs the exact canonical body from immutable STOP-prefixed data contracts, checks its expected SHA-256, and calls the unchanged oracle. The oracle still checks the signed headers, body hash, pinned RSA signature, timestamp, and strict rent extraction. Stored chunks are public and reusable; their existence does not establish authenticity. Only a successful observation in the configured oracle does.

The initial all-body approach needs five chunks for this fixture. Storing 102,202 runtime bytes costs at least **20,440,400 code-deposit gas**, about **0.000409135 ETH** at the snapshot gas price, before creation overhead, helper deployment, final verification, or v4 work. That lower bound alone exceeded the deployer's snapshot ETH balance. The implemented hybrid mode instead stores one 24,000-byte prefix and passes the remaining 78,197-byte tail inline in the final call. The helper checks the complete reconstructed hash. Its local test asserts final calldata remains below 90,000 bytes, leaving admission headroom; the operator must also check actual serialized transaction length. This retains exact DKIM bytes and avoids four data-contract writes. Independently reviewed code bounds each stored chunk, checks the STOP prefix, reconstructs stored prefixes plus the inline tail, and leaves all authentication to the original oracle.

Preserve the production oracle bytecode and key. Never truncate the signed body, replace the fixture signature, inject an observation into production storage, or describe a mock oracle as an authentic print. Fixture timestamps may be replayed on a local fork to test lifecycle boundaries; that is simulated time, not September 2027 evidence.

## Product mathematics that must remain honest

- **Payout:** `r = clamp((g - 0.03) / 0.05, 0, 1)`, where `g = settle / base - 1`. One RENT redeems for `r` USDC. Contract strikes represented as integer cents require explicit rounding; at the $92.88 demo base the exact 3% and 8% strikes are $95.6664 and $100.3104. Use the deployed strike values when displaying actual contract payouts.
- **Price signal:** `g* = 0.03 + 0.05 × p` is a **price-equivalent growth**, not expected rent growth. In general `E[clamp(g)]` cannot be inverted into `E[g]`. A payout price also reflects discounting, fees, liquidity, risk preferences, and supply. For example, equal probability of −10% and +20% growth gives expected payout 0.5 and inverse value 5.5%, while expected growth is 5%. A single expected payout does not identify a distribution or its mean.
- **Renter example:** annual rent 60,000 USDC, price 0.285, and 5% band width imply 3,000 RENT, cost 855 USDC, maximum payout 3,000 USDC, and scenario break-even 4.425% growth (4.4% rounded). This offsets the specified index band, not all of a person's rent increases. The office index can diverge from their residential lease.
- **Insurer example:** with `C=100,000`, `p=.285`, `u=.10`, and assumed annual `y=.04`, premium is 2,850, modeled yield is 4,000, and worst-case scenario P&L is −3,150. For `u>0`, break-even payout ratio is `p + y/u`, if within [0,1], so break-even growth is 6.425%. The difference from renter break-even is the modeled yield divided by sold fraction; the supplied formulas do not contain a separate loading parameter. At `u=0` no claims are sold; do not divide by zero. If `p+y/u>=1`, no scenario in the capped band loses money under these assumptions.
- **Yield:** the current escrow has no sDAI investment strategy. A 4% yield is a scenario input, not live income. Actual no-yield worst-case insurer P&L for those inputs is −7,150 USDC. A future strategy adds asset, redemption, and liquidity risks and needs separate implementation and tests.
- **Capital:** 1 RENT is minted only after one USDC enters escrow. USDC deposited into the AMM is additional capital, not the same dollar that backs a token in escrow. Full-range seeding 100,000 RENT at 0.285 can require about 28,500 USDC in quote liquidity in addition to the 100,000 USDC escrow (exact amounts depend on ranges/rounding). Single-sided RENT liquidity reduces initial quote requirements but cannot guarantee immediate sell-side depth.
- **Inventory:** all minted RENT remains a claim liability, including unsold insurer inventory and RENT in an LP. The simple `claims = r × u × C` and insurer P&L formulas assume the insurer retains and ultimately redeems unsold inventory and accounts for its residual escrow. Total supply, pool balance, transfer volume, and net tokens outside one wallet are not interchangeable with “RENT sold.” In a two-way AMM, purchases, resales, fee inventory, multiple LPs, and withdrawals must be accounted for explicitly.
- **Premiums:** AMM sale proceeds can remain in LP inventory. They are not necessarily already realized in the insurer's wallet. Swapping and withdrawing liquidity do not unlock collateral escrow. Display modeled P&L separately from realized balances and settled claims.

## Time, settlement, and transfer guarantees

The existing `CoverPool.settle(observationIndex)` and the new market's corresponding method select a qualifying observation supplied by the caller. “First wins” means **the first successful settlement call**, not provably the chronologically earliest qualifying email. The append-only oracle cannot prove that no earlier newsletter was withheld. Do not advertise chronological-first selection unless a new mechanism actually enforces that rule and its source-completeness assumptions.

`RentV4Market` now binds `baseObservationIndex` to the configured oracle, checks its cents match the configured base and that its timestamp is not in the future, and stores its timestamp and email ID immutably. The generic factory does not restrict that base to September 2026 or enforce the official 3%–8% dates/band: the selected production market's exact terms and provenance still require manifest verification. A September 2027 payout cannot be honestly demonstrated as real before that observation exists. Use the authentic $92.88 fixture for oracle verification and clearly separated local/mocked future outcomes for payoff tests.

Canonical swaps and new issuance close at their programmed cutoff; ordinary RENT transfers lock for the programmed observation interval. The oracle accepts a signed timestamp up to one day ahead of block time. Rejecting future timestamps at settlement prevents early settlement, but does not prove traders could not see a qualifying future-dated email before the trading cutoff. A conservative deployment can place the cutoff at least a day before `obsStart`; all economic trade paths must follow the intended cutoff if making a stronger information-arrival claim. Publisher signing-time honesty, private information, and market news are separate assumptions.

A RENT ERC-20 transfer lock does **not** freeze every economic claim on RENT. [Uniswap v4 ERC-6909 balances](https://developers.uniswap.org/docs/protocols/v4/concepts/erc-6909) can represent tokens already held by PoolManager without a fresh underlying transfer. Third-party pools can exchange existing internal claims, and custodians can trade IOUs; LP position ownership can also change without withdrawing liquidity. The enforceable claim is that this hook gates its registered pool and RENT gates its own ERC-20 transfers. “Cannot be traded anywhere” is too broad.

LP principal belongs in the AMM while backing belongs in escrow. Pausing liquidity removal cannot replace full collateralization, and allowing liquidity removal before the cutoff must not release backing. Once settled, LP removal must work so holders can withdraw RENT and redeem it before `redeemEnd`. If no qualifying observation arrives, there must be a documented expiry path for liquidity and residual funds. Unredeemed RENT after the claim deadline must not be shown as redeemable money.

The deck's “thin liquidity never blocks exit” statement is also too strong. A swap needs executable liquidity and a price acceptable to the seller; zero/out-of-range depth or slippage bounds can prevent execution even during the trade window. Aggregator support for a new hooked pool must be observed, not inferred from ERC-20 or v4 compatibility.

## Review and deployment gates

1. Pin v4 core/periphery commits and compiler/EVM settings. Validate the deployed hook address's permission bits against exactly the callbacks implemented, using the same CREATE2 deployer and constructor bytes that will be broadcast.
2. Restrict hook initialization to the intended factory and bind currency pair, market, fee flag, tick spacing, and pool ID. A callback caller must be the configured canonical PoolManager. Wrong-pool and direct-callback attempts must revert.
3. Test exact 1:1 deposits, both token orderings, six-decimal amounts, pool initialization, liquidity, buys and sells, quote/slippage/deadline failures, cutoff boundaries, transfer lock, LP lock/unwind, authentic oracle ingestion, settlement/replay, zero and full payout, residual ownership, claim deadline, and no-observation expiry. Test that leaving LP inventory does not free backing. Tests using mock future observations must say so.
4. Run the complete integration against canonical Arbitrum PoolManager on a fixed live fork. Record the upstream block and differentiate copied real contracts from contracts newly deployed on the fork. Exercise the actual frontend transaction encoding; compilation and component tests do not establish wallet flow correctness.
5. Estimate the complete proposed broadcast sequence and compare it with fresh funding. Record actual signed transaction sizes for observation transport. Use a restart-safe checkpoint containing public transaction hashes and deployed addresses, without copying secrets.
6. If authorized and sufficiently funded, broadcast the new stack beside existing immutable deployments. Record receipts, source verification, hook permission flags, PoolKey, PoolId, initial price, actual liquidity, and authentic base observation evidence before activating the market in the frontend registry.
7. Verify the live website reads the new deployment, shows current liquidity and executable quotes, labels planned yield/demo values, and enables settlement/redemption only from actual chain state. Publishing a UI with an inactive/demo configuration is website publication, not v4 mainnet launch.

This read-only review does not itself establish a completed hook audit, new mainnet market, funded pool, or production swap. Append transaction evidence and final test results when those steps actually complete.

## Initial implementation review

A first manual review of `RentV4Market`, `RentV4Factory`, `RentV4Hook`, `RentV4Router`, and the hybrid chunk helper found no concrete exploitable backing or callback-authorization defect. This is a limited code review, not an audit or test result. Factory registration binds the full PoolId and initialization is atomic. BaseHook authenticates PoolManager callbacks. The router binds each callback to an entrypoint's caller and encoded request, consumes that authorization before token calls, checks input/output limits, and keys LP ownership by payer, market, and ticks.

Residual shares remain with the collateral depositor independently of RENT transfers. After `redeemEnd`, `(totalDeposited - paidOut)` is fixed and distributed by original deposit fractions, with one withdrawal per depositor. Unredeemed claims therefore increase the residual available to all original depositors proportionally; they are not returned specifically to the insurer who originally sold a particular fungible token. Rounding dust and unsolicited collateral donations remain locked under this version's accounting. Verify this policy in the insurer copy and multi-depositor tests.

## Completed operator rehearsal

`scripts/v4-prepare.mjs` now prepares a public-data plan without loading credentials. It imports the exact base, strike, and immutable date constants from `web/src/lib/market.ts`; `v4-launch.mjs` also rejects plans that differ from those current shared terms. The default desired launch is **1 USDC escrow plus 0.285 USDC of LP cash**. The optional roundtrip smoke reserves another 0.0001 USDC. Against the funding snapshot, that full pilot needs **1.27162 additional USDC**, including the smoke reserve.

`scripts/v4-launch.mjs` defaults to an isolated Anvil fork at port 8599. The completed run under `broadcast/v4/readiness-final-proof/` contains the final formatted artifact hashes, plan, fourteen successful local receipts, checkpoint, report, and a frontend-shaped manifest. It deployed the chunk helper, uploaded the authentic baseline through the unchanged production oracle code, mined the hook salt for the deployer's actual nonce, deployed the factory/router/market, escrowed 0.01 real forked USDC, added full-range liquidity, and bought then sold RENT through the canonical v4 PoolManager. The smoke used the canonical Quoter and a 1% minimum-output bound.

The fork inherited the real USDC balance. Only the local native ETH balance was increased to let the complete gas measurement finish. No USDC balances, oracle observations, oracle code, or future payout values were mocked. These are local receipts, not mainnet transactions.

The final run used **17,384,037 gas**; summed estimates were **17,581,709 gas**. At that report's live gas price, a 30% buffer requires **0.0004581301077548 ETH**, a **0.000065955408766964 ETH** shortfall against the then-current native balance. Actual capital consumed by the tiny pilot and roundtrip was **0.012822 USDC**. A fresh plan at block **506886859** still found **0.000392174698987836 ETH** and **0.01348 USDC** in the real deployer. Anvil's EVM gas receipts do not reproduce Nitro's L1 data fees; the live-estimation checks and explicit budget buffer remain necessary. Refresh the proof and budget after funding or artifact changes.

Reproduce a tiny rehearsal:

```sh
node scripts/v4-launch.mjs --smoke --collateral 0.01 --out broadcast/v4/new-rehearsal
```

Prepare the desired pilot after funding, then rehearse that exact plan:

```sh
node scripts/v4-prepare.mjs --smoke --out broadcast/v4/pilot-plan.json
node scripts/v4-launch.mjs --plan broadcast/v4/pilot-plan.json --out broadcast/v4/pilot-proof
```

Production execution is a separate path requiring `--execute`, the exact plan and completed matching fork report, explicit gas/capital caps, fresh balances, and a secure deployer key loaded through the existing environment loader. It does not run during preparation/rehearsal. A global deployer lock and active-journal pointer prevent concurrent or alternate-checkpoint launches; signed transaction hashes are persisted before network submission and resumed with the same nonce/request. A missing active checkpoint fails closed. Keep checkpoints across restarts. Actions use a one-hour deadline; expired unconfirmed actions need operator review, not blind resubmission.

The observation helper is always provisioned even when the baseline is already recorded. `--observation-submitter ADDRESS` can reuse an existing helper only if its runtime matches the reviewed artifact. Every successful manifest includes it for future large signed-email submissions. Manifests remain in the operation's output directory; the scripts never activate fork addresses in the production frontend.


## Polygon PoS target — 2026-09-19

Polygon is now configured in the wallet, RPC fallbacks, network selector, explorer links,
USDC payment table, deployment preparation, restart-safe launcher and `DeployV4.s.sol`.
The canonical target registry is `web/src/chain/v4-targets.json`. Gnosis retains its existing
fixed-price deployment; Arbitrum and Polygon are independent v4 targets, not a bridge.

| Contract | Polygon PoS address (137) |
| --- | --- |
| PoolManager | `0x67366782805870060151383f4bbff9dab53e5cd6` |
| StateView | `0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a` |
| Quoter | `0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9` |
| Native USDC, 6 decimals | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |

Sources: [Uniswap's v4 deployment registry](https://developers.uniswap.org/docs/protocols/v4/deployments#polygon-137)
and [Circle's native USDC registry](https://developers.circle.com/stablecoins/usdc-contract-addresses).
The preparation command independently verified nonempty on-chain code for these contracts.
Polygon starts with a fresh oracle pinned to the same authentic CRE Daily key; no oracle
or RentSafe market is represented as deployed on Polygon in the production app.

Validation:

- Canonical Polygon and Arbitrum PoolManager fork lifecycles both passed, including actual
  buy/sell, observation freeze, settlement, LP removal, redemption and residual accounting.
  These lifecycle tests use synthetic currency and future observations only inside the fork.
- The full Polygon launcher integration passed **15 transactions**, using real native USDC,
  PoolManager, StateView and Quoter bytecode. It deployed a new oracle, verified the authentic
  September 2026 DKIM fixture, minted fully backed RENT, seeded liquidity and bought/sold RENT.
- That integration used synthetic local POL and a **local-only USDC transfer** from the
  canonical PoolManager into the operator account on an outer fork. Nothing was sent on
  Polygon mainnet. The launcher rejects its explicitly marked integration-only plan for
  execution. Production activation must use a fresh plan after real operator funding.
- 20,038,193 receipt gas and 20,235,863 estimated gas were measured for the complete launch.
  The nested fork's own gas price is not a production fee quote.
- At live Polygon block **94097230**, gas was 30,005,125,240 wei. Applying a 30% buffer to
  the measured gas gives **0.789334 POL**. The actual deployer held **0.103244 POL and 0 USDC**,
  leaving approximately **0.686090 POL plus 1.2851 native USDC** to fund the one-dollar
  pilot and smoke trade. Fees and nonce must be refreshed before preparing a live proof.

`v4-deployments.json` remains empty. Polygon's frontend entry contains zero RentSafe
addresses and shows an explicit not-live notice; checkout cannot submit a transaction.
Arbitrum's old version-1 plans must also be regenerated under the multichain version-2 format.
