# Uniswap integration — pay with any token

How a buyer holding ETH, WETH, ARB, USDT, GNO or any other routable token buys cover priced in
the pool currency, in one transaction, without the protocol ever holding a swap position. The
protocol itself has no Uniswap dependency: `CoverPool` only ever sees its own currency. All
swap logic lives in one immutable periphery contract, [`src/SwapAndBuyRouter.sol`](../src/SwapAndBuyRouter.sol),
plus client-side quoting.

## Architecture: exact-output to the premium

The premium for `maxClaim` units is deterministic on-chain: `maxClaim × premiumRateBps / 1e4`
in the pool currency (`CoverPool.quote`). That makes the swap an **exact-output** problem — we
know precisely how much currency we need, so we swap for exactly that amount and bound the
input instead of guessing an output:

```
buyer's tokenIn ──exactOutput──▶ exactly `premium` pool currency ──buyProtectionFor──▶ cover minted to buyer
        └───────────── everything unspent refunded to the buyer in the same tx ─────────────┘
```

`SwapAndBuyRouter.swapAndBuy(tokenIn, amountInMaximum, path, seriesId, maxClaim)`:

1. **Pull or wrap.** Pulls `amountInMaximum` of `tokenIn` from the caller, or — when
   `msg.value` is sent — requires `tokenIn == WETH9`, `msg.value == amountInMaximum`, and wraps
   the native coin once on entry. From then on everything is ERC-20, so the dust refund is paid
   in WETH (never a raw ETH send that a contract caller without a payable fallback could not
   receive).
2. **Re-quote on-chain.** Reads `pool.quote(seriesId, maxClaim)` in the same transaction. The
   client's earlier quote can never diverge from what the pool will charge: `maxPremium` is set
   to this same-transaction premium, so the pool pulls the approval exactly in full. This is
   also why the router needs no swap deadline — there is no stale quote to protect.
3. **Exact-output swap.** `SwapRouter02.exactOutput` along `path` for exactly `premium`,
   spending at most `amountInMaximum` (the slippage bound; the swap reverts with
   `Too much requested` beyond it). The approval to the swap router is `forceApprove`d and
   reset to zero afterwards. A zero premium (zero-rate series) skips the swap entirely.
4. **Buy for the caller.** `pool.buyProtectionFor(seriesId, maxClaim, premium, msg.sender)` —
   the cover is minted DIRECTLY to the buyer, never to the router. Because {CoverToken} is
   soulbound, minting to the router would strand the position forever; `buyProtectionFor`'s
   payer/recipient split exists exactly for this.
5. **Sweep.** Every leftover wei of `tokenIn` AND of the pool currency goes back to the caller
   (including stray balances donated to the router). The router holds zero funds between
   transactions, by construction and by test.

**Atomicity.** Any failing leg — pull, wrap, swap, buy — reverts the whole call: the buyer can
never spend `tokenIn` without receiving cover, and never receives cover without the series
bucket receiving the premium.

**No funds at rest, no admin.** The router is immutable and ownerless: no setters, no rescue
functions beyond the refund-to-caller sweep, nothing for a privileged party to do. Its only
wiring is read at deployment: `pool.currency()` for the currency (a currency mismatch is
impossible by construction) and `swapRouter.WETH9()` for the wrapped-native token.

**Path encoding.** Uniswap v3 exact-output paths are encoded in REVERSE: the path must START
with the pool currency (the output) and END with `tokenIn`. The router validates the length
(20 + n×23 bytes), the first token (== pool currency) and the last token (== `tokenIn`) before
swapping.

## Why cover tokens themselves are never pooled

Cover is a soulbound ERC-1155 (`CoverToken` reverts every transfer): a position cannot be
LP'd, lent, or sold on. This is deliberate — the payout is binary-ish, dated, and identity-tied
to redemption rights, so a secondary market in claim units would recreate exactly the informed
trading the `saleEnd ≤ obsStart` rule shuts out (holders racing to dump cover once the
newsletter's number leaks). Liquidity lives strictly on the PAYMENT side: any token swaps into
the premium via Uniswap, while the risk position itself stays with the buyer from mint to burn.
Secondary price discovery belongs to competing series (underwriters quoting different rates),
not to resale of existing cover.

## QuoterV2 quoting flow (what the app does before the transaction)

`QuoterV2`'s quote functions are state-mutating on-chain (they revert internally to return
data) and are meant to be called via `eth_call`. The app declares them `view` in its ABI so
wagmi issues exactly that call:

1. `pool.quote(seriesId, maxClaim)` → `premium` in the pool currency (also re-run on-chain at
   buy time, step 2 above).
2. `QuoterV2.quoteExactOutputSingle({tokenIn, tokenOut: currency, amount: premium, fee, sqrtPriceLimitX96: 0})`
   for single-hop routes, or `QuoterV2.quoteExactOutput(reversedPath, premium)` for multi-hop —
   the SAME reversed path bytes later passed to `exactOutput`.
3. `amountInMaximum = quotedIn × (1 + slippageBps/1e4)` — the app defaults to 50 bps on
   stable single-hop routes and 100 bps on multi-hop routes.
4. `swapAndBuy(tokenIn, amountInMaximum, path, seriesId, maxClaim)` (approve `tokenIn` first,
   or send `msg.value` for native coin).

The app path routes through SwapRouter02's `multicall(deadline, …)` wrapper for its own UX
deadline; the router contract itself needs none (step 2 above).

## Verified addresses and routes — Arbitrum One (chainId 42161, current)

Pool currency: **native (Circle-issued) USDC, 6 decimals**. Core wiring, re-verified by RPC in
`script/Deploy.s.sol`'s preflight/postflight on every deploy:

| Contract | Address | Verification |
|---|---|---|
| Native USDC (pool currency) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `symbol()` → "USDC", `decimals()` → 6 (2026-09-19, arb1.arbitrum.io/rpc) |
| SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `factory()` → `0x1F98…F984`, `WETH9()` → `0x82aF…Bab1` |
| WETH9 | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | read from `SwapRouter02.WETH9()` at router deployment |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `factory()` → `0x1F98…F984`, `WETH9()` → `0x82aF…Bab1` (2026-09-19) |

Routes (pool addresses read back from the v3 factory `getPool`, 2026-09-19; depth = in-range
liquidity at check time — re-check before sizing a large buy):

| Route (exact-output, reversed) | Pool(s) | Notes |
|---|---|---|
| WETH → USDC, fee 500 (0.05%) | `0xC6962004f452bE9203591991D15f6b388e09E8D0` | The deep default route; also the native-ETH path (wrapped on entry). Proven on a live fork in `test/RouterFork.t.sol` (ERC-20 WETH and native ETH). |
| USDT → USDC, fee 100 (0.01%) | `0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6` | Stablecoin single hop. |
| USDT → USDC.e, fee 100 (0.01%) | `0x8c9D230D45d6CfeE39a6680Fb7CB7E8DE7Ea8E71` | Only if paying INTO USDC.e legs; the pool currency is native USDC, not USDC.e. |
| USDC.e → USDC, fee 100 (0.01%) | `0x8e295789c9465487074a65b1ae9Ce0351172393f` | Bridge-era balances into the native-USDC premium. |
| ARB → WETH → USDC, fees 500/500 | `0xC6F780497A95e246EB9449f5e4770916DCd6396A` + `0xC6962004…E8D0` | **ARB caveat:** the direct ARB/USDC 0.05% pool (`0xb0f6cA40411360c03d41C5fFc5F179b8403CdcF8`) is far shallower than ARB/WETH — route ARB through WETH as a 2-hop. Proven on a live fork in `test/RouterFork.t.sol` (`test_fork_swapAndBuyWithArbMultihop`). |

## Verified addresses and routes — Gnosis (chainId 100, legacy v1 pool)

Pool currency: **WXDAI, 18 decimals**. These addresses were cast-verified against
`rpc.gnosischain.com` for the v1 deployment and remain correct for any future Gnosis
deployment of the current contracts:

| Contract | Address | Verification |
|---|---|---|
| WXDAI (pool currency) | `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` | `symbol()` → "WXDAI", `decimals()` → 18 (2026-09-18) |
| SwapRouter02 | `0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be` | `WETH9()` → WXDAI (the wrapped-native IS the pool currency) |
| QuoterV2 | `0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4` | used by the live app's quoting flow |
| USDC.e (Circle-bridged) | `0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0` | routed payment token |
| GNO | `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb` | routed payment token |

| Route (exact-output, reversed) | Pool(s) | Notes |
|---|---|---|
| xDAI (native) | — | wrap-only via `WXDAI.deposit()`, 1:1, no swap fee |
| USDC.e → WXDAI, fee 100 (0.01%) | `0xf5E40cC12f69121B0329c256A99F4ab3ebDfAA2E` | ~$103k depth at verification; the single-hop stable route, proven on Gnosis mainnet (see the recorded lifecycle in README.md) |
| GNO → USDC.e → WXDAI, fees 3000/100 | GNO/USDC.e 0.30% (~$1.08M) + `0xf5E4…AA2E` | 2-hop: no usable direct GNO/WXDAI pool — GNO routes through USDC.e |
| old bridged USDC `0xDDAf…7A83` | — | **excluded**: QuoterV2 reverts on it; do not route |

## Operational rules

- **Depth over convenience.** Quote through QuoterV2 against the live pool before wiring any
  new route; in-range liquidity moves. The tables above record what was verified and when.
- **The pool currency is chain-specific.** Paths must end (in exact-output encoding: start)
  at `pool.currency()` — native USDC on Arbitrum, WXDAI on Gnosis. The router enforces this;
  clients should too, before asking for a signature.
- **Slippage bounds are the only tunable.** 50 bps stable single-hop / 100 bps multi-hop
  defaults; everything above the consumed input is refunded regardless.
- Premiums land in the SERIES bucket of the permissionless pool ([PROTOCOL.md](PROTOCOL.md));
  nothing about the router changes with Option B — it only ever calls `quote` +
  `buyProtectionFor`, both unchanged.
