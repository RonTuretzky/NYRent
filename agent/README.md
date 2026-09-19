# agent/ — fixed-pool legacy agent and live v4 market maker

> **Current v4 POC (2026-09-19): live on Arbitrum.** `v4/run-bankr.mjs`
> gathers the existing research signals, obtains a Bankr Max Mode risk review,
> then uses the separately gated Bankr custody adapter to maintain bounded
> Uniswap v4 bid/ask ranges. `v4/settle-bankr.mjs` is a settlement-only raw-email
> inbox scan. See [v4/README.md](v4/README.md) and the website's Bankr docs page.

A daily agent that runs a **hold-to-settlement book** on the permissionless
[CoverPool](../src/CoverPool.sol) (no roles: anyone escrows capacity with
`createSeries`, anyone buys). It watches the settlement metric (CRE Daily ·
*Manhattan Office Rent · Avg Effective $/SF*) plus correlated public markets,
values every open series with one Bachelier model, and acts on **both sides**
through a **deterministic, clamped policy**. Dry-run by default; execution is a
separate operator opt-in.

- **SELL** — underwrite its own standard series: escrow capital + `createSeries`,
  priced at model fair value × 1.25 loading.
- **BUY** — arbitrage: `buyProtection` on ANY open series quoted below the
  model's fair value minus an edge threshold. This is the profit engine and the
  market-balancing function in one. Never on a series created by ANY
  operator-controlled wallet (`operatorWallets` — self-dealing prevention),
  and never past the per-series cap cumulatively (holdings count).
- **REDEEM** — realize the buy side: every settled holding with a positive
  payout ratio is redeemed before its `redeemEnd` (`redeem(seriesId, units)`
  collects units × settled ratio from the series escrow). Without this leg the
  buy side could never collect — cover is soulbound and holder-redeem-only.
- **INVENTORY** — net exposure = own-book SOLD exposure × E[ratio] minus
  PURCHASED cover held × E[ratio]; unsold capacity is uncommitted
  (cancellable), not short, and outsider-gifted cover never moves the lean;
  managed by *leaning the next cycle* (cover is soulbound — there is no
  unwind, only the next run's prices and edges).

> The fixed CoverPool rail below is retained for compatibility. Its
> `BANKR_EXECUTE=1` gate is independent of the live v4 rail's
> `BANKR_V4_EXECUTE=1` gate.

```
collectors/  (real endpoints)             chain state (viem, read-only)
  credaily.mjs  -> prints [{t,cents}]       market scan: ALL series + own holdings
  kalshi.mjs    -> vacancy prob             oracle observations, agent wallet balance
       \                                   /
        v                                 v
   policy/valuation.mjs   fairRatioBps / fairPremiumBps  (pure math)
   policy/decide.mjs      decide(signals, chainState, config) -> Plan
                PURE: no I/O, no clock, no randomness
                             |
             +---------------+------------------+
             v                                  v
      run.mjs report                    --execute only: executors/
      agent/runs/<date>.json              direct.mjs -> txs on BOTH chains (agent key)
      (uploaded by CI)                    bankr.mjs  -> Arbitrum via Bankr Wallet API
                                                        (fork-proven, DORMANT/on hold;
                                                         explicit BANKR_EXECUTE=1 only)
```

Nothing is mocked: collectors hit `credaily.com` and
`api.elections.kalshi.com`, chain state comes from public RPCs, and the
executors (when enabled) sign real transactions. Recorded fixtures under
`fixtures/` are real captured responses used only for parser unit tests.

## Targets

All clamp/capital math is in **base units of the per-target currency** —
`config.decimals` parameterizes every constant, so "0.5 currency units" means
5e17 on Gnosis and 5e5 on Arbitrum.

| | Gnosis (100) | Arbitrum One (42161) |
|---|---|---|
| CoverPool | `0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3` | `0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c` |
| CredailyRentOracle | `0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43` | `0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3` |
| CoverToken | `0x821d100Aa36Beec16D830C7E2B8D5249AF62C857` | `0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E` |
| SwapAndBuyRouter | `0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b` | `0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F` |
| Currency | WXDAI `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` (18 dec) | native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (6 dec) |
| Execution surface | direct (viem + agent key) | direct (default; Bankr Wallet API custody rail dormant behind `BANKR_EXECUTE=1`) |

## The Plan

`decide()` returns exactly this shape — the executor may narrow it, never widen it:

```js
{
  refused: boolean,               // true => nothing on-chain, exit 3
  newSeries: null | {             // SELL side — at most ONE per run
    strikeLowCents, strikeHighCents,      // uint32 (cents of $/SF), 800c band
    premiumRateBps,                       // uint16, always in [500, 5000]
    saleEnd, obsStart, obsEnd, redeemEnd, // unix sec, saleEnd == obsStart
    capacityUnits                         // bigint — escrowed from the agent wallet
  },
  buys: [{                        // BUY side — arbitrage on other creators' series
    seriesId, maxClaimUnits, maxPremiumUnits,   // bigints (currency base units)
    edgeBps, fairRatioBps, quotedPremiumBps     // audit trail per buy
  }],
  redeems: [{ seriesId, units }], // REDEEM side — settled holdings with ratio > 0,
                                  // before redeemEnd (units × ratio collected)
  pauses: [{ seriesId, paused }], // OWN series only (per-series; no global pause exists)
  withdrawResiduals: [seriesId],  // own series past redeemEnd (one-shot residual)
  cancels: [seriesId],            // own UNSOLD series with a stale shape (full refund)
  inventory: { netExposureUnits, lean, edgeMinBps, premiumLeanBps },
  target: { chainId, pool, decidedAtBlock, wallet } | null,
                                  // the plan STAMP: executors REFUSE a plan whose
                                  // stamp mismatches their live chain, pool or
                                  // executing wallet (no cross-target replay, no
                                  // executing a plan sized for another wallet)
  rationale: string[]             // every decision, human-readable
}
```

## Valuation (`policy/valuation.mjs`)

One pure model prices **both sides of the book** for arbitrary strikes and
windows (the generalization of the machinery behind the live series):

```
fairRatioBps({strikeLowCents, strikeHighCents, obsStart, obsEnd}, signals, now)
  = E[clamp((X − L)/(H − L), 0, 1)]        X ~ N(print, σ_h²)   (in bps)
  = (C(L) − C(H)) / (H − L)                (Bachelier call-spread identity)
C(a) = σ_h·φ((µ−a)/σ_h) + (µ−a)·Φ((µ−a)/σ_h)          µ = latest print
σ_h  = σ_monthly · sqrt(months from now to the OBS-WINDOW MIDPOINT)
fairPremiumBps = fairRatioBps × 1.25       (sell-side loading only)
```

Every constant is documented in the module header: `σ_monthly` is the sample
std of month-normalized print-to-print moves (≥ 4 prints required, else the
documented **$1.50/SF** fallback); the horizon runs to the observation-window
**midpoint** because settlement can land on any qualifying observation inside
the window and CRE Daily prints roughly monthly — past the midpoint the value
degenerates to the deterministic clamp of the current print. The 1.25× loading
matches the economic model behind the live series (xlsx Option 2). The BUY side
compares quoted premiums against the **unloaded** `fairRatioBps`.

*Worked example (regression-tested):* µ = L = 9288¢, band 800¢, σ_h = 181.7¢ →
fair ratio **906 bps** → sell quote ×1.25 = **1133 bps** (the live series-1 rate).

## Policy math (`policy/decide.mjs`)

**Anchoring.** The authoritative print is the newest of (a) on-chain oracle
observations (DKIM-verified emails — strongest) and (b) CRE Daily web-archive
prints. **Plausibility gate:** when at least one oracle observation exists, a
scraped web print may anchor only if it is within ±15%
(`WEB_PRINT_MAX_DIVERGENCE_BPS`) of the latest oracle observation — implausible
web prints are rejected and never count toward freshness. Unknown-age web
prints (`t: null`) corroborate only. Own-series strikes anchor to the accepted
print: `strikeLow = round(print)`, `strikeHigh = strikeLow + 800` cents.

**Sell side.** `premiumRateBps = clamp(fairPremiumBps + lean, 500, 5000)`.
Capacity (the `createSeries` escrow, pulled from the agent wallet) =
`min(80% × wallet × health, 0.5 currency units)`; `health` starts at 100%, is
**halved** when data is stale (no print within 45d — which also blocks the
series outright) and **halved again** under Kalshi vacancy stress (KXMANOFFVAC
yes-price < 0.35). Sale `[now, now+14d]`, observation `[saleEnd, saleEnd+30d]`,
redemption `[obsEnd, obsEnd+30d]` — `saleEnd == obsStart` (informed-trading
rule, also a contract invariant) and `redeemEnd ≥ obsEnd + 7d` (contract
`MIN_REDEEM_WINDOW`). At most one own live sale and one own observation window
at a time.

**Buy side.** From the market scan (every series on the pool), buy where
`quotedPremiumBps ≤ fairRatioBps − edgeMin` (default **300 bps**), best edge
first. Sizing, caps in binding order: 25% of the series' remaining capacity
**net of units already held** (the cap is cumulative across runs — a series
held at/above its cap is skipped, so re-runs and daily runs never stack
unbounded exposure onto one counterparty) → per-run total notional clamp
(**0.5 currency units**, separate from the sell clamp) → wallet premium budget
left after the sell escrow. Skips paused, sale-closed, settled and cancelled
series and any buy whose premium would truncate to zero. **Never buys the
agent's own series NOR any series created by an operator-controlled wallet**
(`config.operatorWallets` = the deployer and Bankr custody wallets — one
economic operator; buying across own wallets is self-dealing and the rationale
names each exclusion), and the **whole buy leg is refused when fair-value
inputs are stale** — a fair value computed off an old print is exactly the
mispricing an adversary would sell us.

**Redeem side.** Every settled holding with `payoutRatioWad > 0` is redeemed
while `now ≤ redeemEnd` — this is the only way buy-side P&L is ever realized
(cover is soulbound, holder-redeem-only, and expires worthless at `redeemEnd`;
the counterparty's `withdrawResidual` then keeps the payout). Staleness never
blocks redemption: collecting a fixed settled payout has no valuation
dependence. Settled holdings that DID expire unredeemed are surfaced as a
realized loss (`redemptionsForgone` in the P&L block).

**Inventory lean.** `netExposureUnits = Σ own-book SOLD × fairRatio − Σ
PURCHASED held cover × fairRatio-of-that-series` (settled series at their
actual settlement ratio; settled own series at `sold × ratio − paidOut`,
extinguished past `redeemEnd`). Unsold capacity is **uncommitted** — it can be
cancelled — so it is not short exposure (counting it made the book "shorter"
the less it sold, which the short lean then priced UP: counterproductive).
Held cover is valued **0** past `redeemEnd` and 0 for unsettled series whose
obs window closed with no qualifying oracle observation. Only cover the agent
actually **bought** counts (the cumulative `ProtectionBought(buyer=agent)`
ledger in `runs/state-<chainId>.json`); outsider-minted soulbound gifts are
reported in the rationale and excluded — an attacker must not steer the lean.
Beyond a ±0.1-unit band: net **short** → raise the next series' premium one
step (+100 bps) and relax the buy edge one step (min 100 bps); net **long** →
tighten the buy edge one step and cheapen the next series one step.
Deterministic; the transitions are unit-tested.

**Own-series levers.** `setSeriesPaused(id, true)` on data blackout (no print
within 60d) for own open series only; the policy **never auto-unpauses**
(`allowUnpause` opt-in, default false). `withdrawResidual(id)` on own series
past `redeemEnd`. `cancelSeries(id)` on own **unsold** series whose shape went
stale: sale ended unsold (dead escrow) or a fresh print drifted ≥ 800¢ from
`strikeLow` (no drift judgment on stale data).

### Constants (`DEFAULT_CONFIG` in `policy/decide.mjs`)

| Constant | Value | Meaning |
|---|---|---|
| `decimals` | 18 | currency decimals (Gnosis WXDAI; Arbitrum USDC target uses 6) |
| `BAND_CENTS` | 800 | own-series strike band, $8.00/SF |
| `LOADING_BPS` | 12500 | 1.25× sell loading on fair ratio (never applied to buys) |
| `PREMIUM_MIN_BPS` / `PREMIUM_MAX_BPS` | 500 / 5000 | hard own-premium clamps |
| `SIGMA_FALLBACK_CENTS` | 150 | $1.50/SF monthly σ when history is short/degenerate |
| `MIN_PRINTS_FOR_SIGMA` | 4 | prints required to trust historical σ |
| `DEPLOY_FRACTION_BPS` | 8000 | escrow up to 80% of the agent wallet |
| `MAX_SELL_ESCROW_MILLIUNITS` | 500 | 0.5 currency units — per-run createSeries escrow cap |
| `EDGE_MIN_BPS` | 300 | minimum buy edge: quoted ≤ fair − 300 bps |
| `EDGE_FLOOR_BPS` | 100 | a lean-relaxed edge threshold never drops below this |
| `BUY_SERIES_CAP_BPS` | 2500 | per-series buy cap: 25% of remaining capacity |
| `MAX_BUY_NOTIONAL_MILLIUNITS` | 500 | 0.5 currency units — per-run total buy notional |
| `LEAN_BAND_MILLIUNITS` | 100 | |netExposure| ≤ 0.1 units ⇒ balanced |
| `LEAN_PREMIUM_STEP_BPS` / `LEAN_EDGE_STEP_BPS` | 100 / 100 | one lean step |
| `STALE_AFTER_DAYS` | 45 | no print within 45d ⇒ stale (halves capital, kills buys) |
| `STALE_HEALTH_BPS` | 5000 | stale halves the deployable sell capital |
| `KALSHI_STRESS_MAX_PROB` | 0.35 | KXMANOFFVAC yes-price below this ⇒ vacancy stress |
| `KALSHI_STRESS_HEALTH_BPS` | 5000 | stress halves the deployable sell capital |
| `BLACKOUT_AFTER_DAYS` | 60 | no print within 60d ⇒ pause own sales |
| `allowUnpause` | false | never auto-unpause unless explicitly enabled |
| `CANCEL_STRIKE_DRIFT_CENTS` | 800 | cancel own unsold series a full band off the print |
| `WEB_PRINT_MAX_DIVERGENCE_BPS` | 1500 | web print anchors only within ±15% of the oracle |
| `operatorWallets` | deployer + BANKR_WALLET | every operator-controlled wallet, all targets: never bought from, guarded as one book |
| `SALE/OBS/REDEEM_DURATION_DAYS` | 14 / 30 / 30 | own-series windows |
| `MIN_REDEEM_WINDOW_DAYS` | 7 | contract `MIN_REDEEM_WINDOW`, validated locally too |
| `MAX_FUTURE_PRINT_SKEW_SEC` | 1 day | prints further in the future are discarded |

### Safety clamps (non-negotiable, unit-tested)

- per-run **sell escrow ≤ 0.5 currency units** (successor of the sponsor-era
  0.5-unit capital-move cap) — capacity is escrowed from the agent wallet, so
  this bounds capital at risk per run
- per-run **buy notional ≤ 0.5 currency units** — a separate clamp; plus 25%
  per-series cap and the wallet premium budget after the sell escrow
- **never buy own series or ANY operator wallet's series** (`operatorWallets`
  set, enforced in the policy AND re-checked against live state in the
  executor); skip paused / sale-closed / settled / cancelled series; **refuse
  the whole buy leg on stale fair-value inputs**
- per-series buy cap is **cumulative**: live holdings count against it in the
  policy and again at execution (re-running a plan never doubles a buy)
- the plan **stamp** `{chainId, pool, decidedAtBlock, wallet}` is refused by
  the executors on any mismatch with the live chain / configured pool /
  executing wallet (no cross-target replay; a plan sized for one wallet never
  executes from another); `createSeries` is dropped at execution when an
  operator-book OPEN series with the same strikes + obs window already exists
  live (partial-re-run protection)
- `--execute` takes an exclusive **run lock** (`runs/.lock`, pid + timestamp,
  stale after 30 min) — concurrent execute runs are refused (exit 3)
- a scraped web print diverging > ±15% from the latest DKIM oracle observation
  can never anchor strikes or feed valuation (plausibility gate)
- own premium always in **[500, 5000] bps**
- at most **one** new series per run (structurally: a single object or `null`)
- never an obs window overlapping any of the agent's **own unsettled** series;
  one own live sale at a time
- **`saleEnd == obsStart` always** (informed-trading rule; contract invariant)
  and `redeemEnd ≥ obsEnd + 7d` (contract `MIN_REDEEM_WINDOW`)
- all series timestamps strictly future and ordered (`validateSeriesParams`)
- `pauses` / `cancels` / `withdrawResiduals` only ever name own series (the
  contract enforces `NotCreator` anyway — the policy never even asks)
- **refuse everything** if the chain read failed or the agent identity /
  wallet balance is missing (`plan.refused`, exit 3)

## Interfaces (for collectors/executors)

`decide()` consumes:

```js
signals = {
  prints: [{ t: unixSec | null, cents: int, source: "credaily-web" }, ...],
  kalshi: { probVacancyBelow: 0..1 } | null,   // active nearest-expiry KXMANOFFVAC w/ OI
}
chainState = {   // per target; ok:false => refusal
  ok: true, nowSec,
  agent: { address, currencyUnits },   // the underwriting wallet + currency balance
  series: [{ id, creator, strikeLowCents, strikeHighCents, premiumRateBps,
             saleEnd, obsStart, obsEnd, redeemEnd, escrowUnits, soldUnits,
             settled, cancelled, paused, residualWithdrawn, payoutRatioWad }],
             // = the MARKET SCAN: every series on the pool (chainState.marketScan
             // is accepted as an alias)
  holdings: [{ seriesId, units }],     // agent's CoverToken balances (soulbound)
  oracle: { observations: [{ t, cents }] },
}
```

Executor mapping (one on-chain call per Plan item): `newSeries` →
`currency.approve(pool, capacity)` + `createSeries(...)`; `buys[i]` →
`currency.approve(pool, maxPremium)` + `buyProtection(seriesId, maxClaim,
maxPremium)` (or `buyProtectionFor` with the agent as recipient — cover is
soulbound, mint destination is forever); `redeems[i]` → `redeem(seriesId,
units)` (narrowed to live CoverToken holdings, dropped when unsettled /
window-closed / ratio 0); `pauses[i]` → `setSeriesPaused`; `cancels[i]` →
`cancelSeries`; `withdrawResiduals[i]` → `withdrawResidual`.
Safety ordering: pauses first, then cancels/withdrawals/redeems (they only
free or collect capital), then the sell, then buys — an aborted batch must
never leave premium spent on a book that the sell leg was meant to balance.

## Running

```sh
cd agent && npm install

node run.mjs                     # dry run (default): both targets, real signals ONCE +
                                 # real chain reads per target, no txs
node run.mjs --target gnosis     # only the named target(s) (comma list works)
node run.mjs --skip-collectors   # chain-only signals (offline-ish)
node run.mjs --execute           # ACT on-chain on ALL selected targets
node run.mjs --execute gnosis    # ACT only on gnosis; other targets stay dry
                                 # (--execute is per target — needs that target's
                                 #  signer / Bankr gates)

npm run test:policy              # policy + valuation unit tests (node --test)
npm run test:runner              # targets registry + run.mjs unit tests
npm test                         # policy + collectors + executors + runner tests
npm run test:fork                # Direct pipeline vs a real anvil fork (Gnosis, 18 dec)
npm run test:fork:arbitrum       # Direct pipeline vs a real anvil fork (Arbitrum, 6 dec)
npm run test:fork:cycle          # POLICY-DRIVEN sell→buy→settle→REDEEM→residual cycle
                                 # (Gnosis fork; proves buy-side realization: the
                                 # redeem collects exactly units × settled ratio,
                                 # and a verbatim re-run is a no-op)
npm run test:fork:cycle:arbitrum # the same full cycle on the Arbitrum fork (6 dec)
npm run test:fork:bankr          # Bankr custody pipeline vs a real anvil fork (Arbitrum)
```

Every run writes `runs/<YYYY-MM-DD>.json` — one report with a per-target block
(chain state incl. the full market scan, the two-sided plan, the P&L block,
execution result; last run of the day wins; every RPC URL is **redacted to
host only** — keyed URLs and API keys never reach the report or stdout).

**P&L block** (per target, cumulative, in that target's currency units):
premiums earned on own series (Σ `premiumsAccrued`, chain state) · premiums
paid on buys (Σ `ProtectionBought.premium` where buyer = agent, events) ·
redemptions received (Σ `Redeemed.payout` where holder = agent, events) ·
redemptions FORGONE (settled cover held past `redeemEnd`, valued units ×
ratio — the buy book's realized loss) · claims paid (Σ `paidOut` on own
series — the sell book's realized loss) · residuals withdrawn (Σ `withdrawn`
on own series), **decomposed** into escrow returned (capital back, = withdrawn
− premiumsAccrued = escrow − paidOut) + premium income (income realized at
withdrawal — never double-counted against premiums earned). The event cursor,
totals AND the per-series **purchased-cover ledger** (which units the agent
actually bought — feeds the gift-proof inventory) persist in
`runs/state-<chainId>.json` (gitignored) and only ever advance — a failed
chunk holds the cursor and the next run retries.

Exit codes (**worst-of across targets**, severity 1 > 4 > 3 > 2 > 0):
**0** ok / dry-run, **2** acted on-chain, **3** refused (nothing sent),
**4** PARTIAL (some txs landed, then the batch aborted — check the listed tx
hashes), 1 unexpected error. One target's failure never stops the others
(per-target isolation); it only shows up in the worst-of code.

Env (repo-root `.env` is auto-loaded, real env wins; **never commit keys** —
`.env` is gitignored and CI greps for leaks):

- `GNOSIS_RPC_URL` — defaults to `https://rpc.gnosischain.com`
- `ARBITRUM_RPC_URL` — defaults to `https://arb1.arbitrum.io/rpc`
- `DEPLOYER_PRIVATE_KEY` — the Gnosis agent wallet key, only for `--execute`
- `AGENT_ADDRESS` / `AGENT_ADDRESS_<TARGET>` — identity WITHOUT a key (keyless
  dry runs, e.g. CI): the policy refuses without an identity, so give it one
  (bankr targets prefer `BANKR_WALLET`; direct targets prefer the key-derived
  address)
- `AGENT_PNL_LOOKBACK_BLOCKS` / `AGENT_PNL_CHUNK_BLOCKS` — first-run event-scan
  window (default 120000) and getLogs chunk size (default 20000)
- `BANKR_API_KEY` — Bankr API key (Wallet API + read-only wallet state)
- `BANKR_LLM_KEY` — Bankr LLM gateway key (advisory second opinion)
- `BANKR_WALLET` — the EXPECTED Bankr-custodied EVM address; the executor
  refuses to act unless a live `GET /wallet/me` returns exactly this address
- `BANKR_EXECUTE` — set to `1` to opt in to live Bankr custody execution
  (default off — the custody rail is DORMANT and Direct is the active rail on
  both chains). The opt-in also flips the Arbitrum plan identity to
  `BANKR_WALLET`, and a failed custody gate then REFUSES the target (exit 3)
  instead of silently downgrading to the Direct key — a plan decided for the
  custody wallet never executes from another wallet

## Executors: two rails, one tx list (`executors/`)

Both rails send the **same tx list**: `executors/index.mjs` wires Bankr's
executor to the Direct executor's own pure `computeTxDiff` and to a `readState`
bound to the Bankr wallet (viem impersonation — balances/allowances are read
*as* that wallet), so the rails cannot diverge from the policy by construction.

| Target | Rail | Condition |
|---|---|---|
| gnosis | **direct** (viem + `DEPLOYER_PRIVATE_KEY`) | always — Bankr has no Gnosis support ([supported chains](https://docs.bankr.bot/getting-started/supported-chains)) |
| arbitrum | **direct** (viem + `DEPLOYER_PRIVATE_KEY`) | **default** — the Bankr custody rail is dormant/on hold |
| arbitrum | **bankr** (custodied wallet, Wallet API) | only with explicit `BANKR_EXECUTE=1` AND the triple gate passing |
| arbitrum | — **refused** (exit 3) | `BANKR_EXECUTE=1` but the gate fails: the run refuses that target LOUDLY; it never downgrades to the Direct key (the plan was decided for the custody identity — plan-stamp law) |

A non-gated Bankr failure (including PARTIAL) is final and is **never** re-run
on the Direct rail. PARTIAL semantics are rail-independent: some txs landed,
the batch aborted, landed hashes listed, **exit 4** upstream. In custody mode
(`BANKR_EXECUTE=1`) `DEPLOYER_PRIVATE_KEY` is **not required** — the direct
executor's missing-key error is caught and only surfaces if the direct rail is
actually asked to run.

### The Bankr custody model (`executors/bankr.mjs`)

Bankr custodies the key; the agent never sees it. Execution is **triple-gated**
— all of:

1. `BANKR_API_KEY` set (no key → the executor is disabled entirely);
2. `BANKR_EXECUTE=1` (explicit custody opt-in, never defaulted on);
3. a live `GET /wallet/me` returns exactly `BANKR_WALLET`
   ([wallet-info](https://docs.bankr.bot/wallet-api/wallet-info)) — a rotated
   or wrong key can never spend from an unexpected wallet;

plus the wallet must **hold the currency the plan needs** (on-chain `balanceOf`
≥ the plan's escrow + premium pulls, in target currency units).

Per transaction: simulate with a local viem client **as** the Bankr wallet
(from-override, immediately before submission so approve→createSeries
sequencing holds) → `POST /wallet/submit` with the raw `{to, chainId, value,
data}` (Bankr signs custodially and broadcasts —
[submit](https://docs.bankr.bot/wallet-api/submit); the
[sign](https://docs.bankr.bot/wallet-api/sign) endpoint exists for
sign-without-broadcast flows but the pool txs must land, so submit is the
surface) → poll the chain to the receipt → abort the batch on the first
failure. Account-side rail rejections come back with an `errorCode`
(`PER_TX_LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED`, …) and abort the batch the
same way.

The **advisory** path is separate from custody: one Agent-API prompt per run
summarizes the two-sided plan for a second opinion
([prompt](https://docs.bankr.bot/agent-api/prompt-endpoint)). Club accounts can
use the normal Agent API. A non-Club account with LLM credits must set
`BANKR_MAX_MODE_MODEL` (for example `gemini-3.1-pro`) so each request explicitly
opts into credit-backed Max Mode. Without Club or that explicit opt-in, HTTP
403 `subscription_required` degrades to one honest line; the executor never
fakes a verdict or blocks execution. A parsed `veto` is recorded, not enforced
(opt-in `BANKR_ADVISORY_BLOCKING=1`).

### Account-side rails (configure at bankr.bot → Security)

Server-enforced at Bankr's broadcast chokepoint, so they hold even if this
machine is compromised ([security](https://docs.bankr.bot/security/bankr-terminal)):

| Control | Recommended | Why |
|---|---|---|
| Daily spending limit | keep the **$500/24h default** | bounds worst-case daily outflow; the per-run caps (0.5 + 0.5 USDC) sit far below it |
| Per-transaction limit | keep the **$500 default** | a single runaway tx cannot exceed it |
| Enable arbitrary contract calls | **on** (required) | raw `/wallet/submit` is blocked without it; use the timer feature to grant it in windows if you want it off at rest |
| Permitted recipients (wallet-level) | **pool + currency + router only** | our pool txs carry `value: 0`, and the wallet-level list is enforced on `to` only when `value > 0` — so the allowlist never blocks the agent but stops any value-bearing send elsewhere |
| Allowed recipients (API-key-level) | **off** | the key-level list blocks **all** raw submissions outright ([submit — access control](https://docs.bankr.bot/wallet-api/submit)) |
| IP allowlist (API key) | the runner's egress IP | a leaked key is useless elsewhere |
| Passkey MFA | on | rail changes then need a passkey; an API key can never loosen them |

### Operator checklist — Bankr custody (Arbitrum)

1. **Fund the current Bankr POC wallet** on **Arbitrum One**:
   `0x6d06bf32f9002b5777e1ae6ab242fb6cdf31888a`. For the POC, send **2 native
   USDC** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) plus **0.0005 ETH** for
   gas. The deterministic policy caps a single run at 0.5 USDC of sell escrow
   and 0.5 USDC of buy notional, so this leaves ample demonstration headroom.
2. **Verify identity**: `npm run test:executors` — the LIVE test asserts
   `GET /wallet/me` returns `BANKR_WALLET` (read-only, free-tier-safe).
3. **Set the rails** at bankr.bot → Security per the table above.
4. **Run the local POC review**: set `BANKR_WALLET`, `BANKR_API_KEY`, and
   `BANKR_MAX_MODE_MODEL=gemini-3.1-pro`, then run
   `node run.mjs --target arbitrum --bankr-review`. It collects live settlement,
   prediction-market, industry-report, macro, and news signals; creates the
   deterministic plan; and asks Bankr to review it without executing.
   On this Mac the key is stored in Keychain under service
   `nyrent-bankr-api-key`, account `nyrent-bankr-poc`; load it for one process
   with `BANKR_API_KEY="$(security find-generic-password -w -a nyrent-bankr-poc -s nyrent-bankr-api-key)"`.
5. **Legacy fixed-pool opt in**: `BANKR_EXECUTE=1` applies only to the fixed
   CoverPool. For actual v4 positions, use `BANKR_V4_EXECUTE=1` with
   `v4/run-bankr.mjs --bankr-review --execute`. The first live v4 run completed
   on 2026-09-19 and placed one bid and one ask; unattended scheduling remains off.
6. Optional: Bankr Club ($20/mo) or Max-Mode LLM credits turn the advisory
   degrade line back into a real second opinion
   ([access tiers](https://docs.bankr.bot/agent/access)).

### Test status of the custody paths

Unit tests cover the builders, the paywall degrade (pinned to the live-captured
403), the triple gate and the full pipeline against recorded shapes;
`npm run test:fork:bankr` proves the production `execute()` end-to-end against
a **real Arbitrum fork** (real CoverPool/USDC code + the real wallet's inherited
balances) with `/wallet/submit` served by broadcasting the identical tx from the
impersonated wallet; `GET /wallet/me` is verified **live** on every test run
with the real key. Separately, the v4 POC completed six live Bankr submissions
on 2026-09-19: exact approvals, a 0.5 USDC collateral deposit, one bid range and
one ask range. Automated tests still never submit production transactions.

## Enabling execution in CI

`.github/workflows/agent-daily.yml` runs a **dry run every day at 13:00 UTC**
(after CRE Daily's morning send) and uploads the run report artifact. It never
executes on a schedule. To execute from CI (operator opt-in, deliberate every
time): add the key secrets, then Actions → *agent-daily* → *Run workflow* →
**execute = true**. The execute step fails fast on missing secrets, maps exit 2
("acted") to success, surfaces exit 4 ("PARTIAL") as a distinct error, and
never echoes secret material.
