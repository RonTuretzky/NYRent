# agent/ — daily rent-scout for NY Rent Cover

A daily agent that watches the settlement metric (CRE Daily · *Manhattan Office
Rent · Avg Effective $/SF*) plus correlated public markets, and manages the
[CoverPool](../src/CoverPool.sol) sponsor levers on Gnosis (chainId 100) through
a **deterministic, clamped policy**. Dry-run by default; execution is a separate
operator opt-in.

```
collectors/  (real endpoints)          chain state (viem, read-only)
  credaily.mjs  -> prints [{t,cents}]    CoverPool 0x7B22…f0f3
  kalshi.mjs    -> vacancy prob          CredailyRentOracle 0xdd45…0561
       \                                 WXDAI + sponsor balances
        \                               /
         v                             v
        policy/decide.mjs  — decide(signals, chainState, config) -> Plan
                PURE: no I/O, no clock, no randomness
                             |
             +---------------+----------------+
             v                                v
      run.mjs report                  --execute only:
      agent/runs/<date>.json          executors/index.mjs
      (uploaded by CI)                  direct.mjs  -> Gnosis txs (sponsor key)
                                        bankr.mjs   -> advisory/notify (optional)
```

Nothing is mocked: collectors hit `credaily.com` and
`api.elections.kalshi.com`, chain state comes from `rpc.gnosischain.com`, and
the executor (when enabled) sends real transactions. Recorded fixtures under
`fixtures/` are real captured responses used only for parser unit tests.

## Layout

| Path | What |
|---|---|
| `policy/decide.mjs` | pure policy core: `decide(signals, chainState, config) -> Plan` |
| `policy/decide.test.mjs` | `node --test` suite: every clamp, determinism, refusals |
| `run.mjs` | orchestrator: signals → chain state → decide → report; `--execute` opt-in |
| `collectors/` | real-endpoint signal collectors (CRE Daily archive, Kalshi) |
| `executors/` | Direct (viem/Gnosis) + Bankr (advisory) executors |
| `runs/` | one JSON report per run day (gitignored; CI uploads as artifact) |
| `../.github/workflows/agent-daily.yml` | daily 13:00 UTC dry-run + opt-in execute |

## The Plan

`decide()` returns exactly this shape — the executor may narrow it, never widen it:

```js
{
  refused: boolean,               // true => nothing on-chain, exit 3
  targetFreeCapitalWei: bigint,   // desired CoverPool.freeCapital()
  capitalDeltaWei: bigint,        // target - current free (>0 fund, <0 withdraw), post-clamp
  newSeries: null | {             // at most ONE per run
    strikeLowCents, strikeHighCents,   // uint32 (cents of $/SF)
    premiumRateBps,                    // uint16, always in [500, 5000]
    saleEnd, obsStart, obsEnd, redeemEnd,  // unix sec, saleEnd <= obsStart
    capacityWei                        // bigint (uint128)
  },
  pause: boolean | null,          // setSalesPaused target; null = leave alone
  rationale: string[]             // every decision, human-readable
}
```

## Policy math

**Anchoring.** The authoritative print is the newest of (a) on-chain oracle
observations (DKIM-verified emails — strongest) and (b) CRE Daily web-archive
prints from the collector. **Plausibility gate:** when at least one oracle
observation exists, a scraped web print may anchor only if it is within
±15% (`WEB_PRINT_MAX_DIVERGENCE_BPS`) of the latest oracle observation —
implausible web prints are rejected (recorded in rationale, and they do not
count toward freshness either) and the policy falls back to the oracle prints.
Web prints with no publish timestamp (`t: null`) are treated as stale:
corroboration only, never anchoring, never freshness. Strikes anchor to the
accepted print: `strikeLow = round(print)`, `strikeHigh = strikeLow + 800` cents.
Payout at the current print is 0 and ramps linearly to 100% if rents rise
$8.00/SF by settlement (`clamp((cents − low)/(high − low), 0, 1)`, the
contract's formula).

**Premium.** `premiumRateBps = clamp(round(expectedClaimBps × 1.25), 500, 5000)`.
`expectedClaimBps` is a normal-approximation of the clamped-spread payout
(Bachelier call-spread identity): with `X ~ N(print, σ_h²)`, `L = strikeLow`,
`B = 800`,

```
E[clamp((X−L)/B, 0, 1)] = (C(L) − C(L+B)) / B
C(a) = σ_h·φ((µ−a)/σ_h) + (µ−a)·Φ((µ−a)/σ_h)          µ = print
σ_h  = σ_monthly · sqrt(monthsToObsEnd)
```

`σ_monthly` is the sample std of month-normalized print-to-print moves
`(cᵢ − cᵢ₋₁)/sqrt(Δt/30d)`; with fewer than 4 usable prints (or a degenerate
estimate) it falls back to the documented **$1.50/SF** (150 cents). The 1.25×
loading matches the economic model behind the live series (xlsx Option 2:
premium = expected claim × (1 + 25%)).

*Worked example (live state 2026-09-18):* print 9288¢, 4 prints but constant →
fallback σ=150¢, horizon 44d = 1.47mo → σ_h = 181.7¢ → expected claim 906 bps →
×1.25 = **1133 bps**, strikes **9288/10088**.

**Capital.** `targetFreeCapital = 80% × (poolFreeCapital + sponsorWXDAI) × health`.
`health` starts at 100%, is **halved** when data is stale (no print within 45d)
and **halved again** under Kalshi vacancy stress (yes-price of the
`KXMANOFFVAC` "Manhattan office vacancy below X%" market < 0.35, i.e. the
market implies a distressed, volatile office market). The executor moves
capital toward the target with `fundPool` (needs a WXDAI approve first — live
sponsor→pool allowance is 0) or `withdrawExcess`.

**Pause.** `setSalesPaused(true)` **only** on data blackout (no print within
60d). The policy **never auto-unpauses**: `pause: false` is only ever emitted
when `config.allowUnpause === true` (default `false`) — otherwise an existing
pause (possibly a deliberate manual sponsor pause, e.g. incident response) is
respected, `pause` stays `null`, and the rationale says so. The executor also
orders `setSalesPaused(true)` FIRST in a batch (safety before capital moves —
an earlier failing tx can never starve the pause) and an unpause LAST.

**Series scheduling.** Sale `[now, now+14d]`, observation
`[saleEnd, saleEnd+30d]`, redemption `[obsEnd, obsEnd+30d]` —
`saleEnd = obsStart`, so buyers can never trade on an existing qualifying
observation (the production rule the live demo series violated). Capacity =
the targeted free capital (every wei of advertised capacity is backed). A new
series is proposed only when: data fresh, sales unpaused, no unsettled series
still selling, and no obs-window overlap (below).

### Constants (`DEFAULT_CONFIG` in `policy/decide.mjs`)

| Constant | Value | Meaning |
|---|---|---|
| `BAND_CENTS` | 800 | strike band, $8.00/SF (live demo band 8800/9600) |
| `LOADING_BPS` | 12500 | 1.25× loading on expected claim |
| `PREMIUM_MIN_BPS` / `PREMIUM_MAX_BPS` | 500 / 5000 | hard premium clamps |
| `SIGMA_FALLBACK_CENTS` | 150 | $1.50/SF monthly σ when history is short/degenerate |
| `MIN_PRINTS_FOR_SIGMA` | 4 | prints required to trust historical σ |
| `DEPLOY_FRACTION_BPS` | 8000 | deploy up to 80% of sponsor WXDAI + pool free capital |
| `STALE_AFTER_DAYS` | 45 | no print within 45d ⇒ stale |
| `STALE_HEALTH_BPS` | 5000 | stale halves the deploy target |
| `KALSHI_STRESS_MAX_PROB` | 0.35 | KXMANOFFVAC yes-price below this ⇒ vacancy stress |
| `KALSHI_STRESS_HEALTH_BPS` | 5000 | stress halves the deploy target |
| `MAX_CAPITAL_DELTA_WEI` | 0.5 WXDAI | hard per-run capital move cap |
| `MIN_ACTION_DELTA_WEI` | 1e13 wei | dust threshold — smaller deltas do nothing |
| `BLACKOUT_AFTER_DAYS` | 60 | no print within 60d ⇒ pause sales |
| `allowUnpause` | false | never auto-unpause unless explicitly enabled |
| `WEB_PRINT_MAX_DIVERGENCE_BPS` | 1500 | web print may anchor only within ±15% of the latest oracle observation |
| `SALE_DURATION_DAYS` | 14 | sale window length |
| `OBS_DURATION_DAYS` | 30 | observation window length |
| `REDEEM_DURATION_DAYS` | 30 | claim window length |
| `MAX_FUTURE_PRINT_SKEW_SEC` | 1 day | prints further in the future are discarded |

### Safety clamps (non-negotiable, unit-tested)

- per-run capital delta ≤ **0.5 WXDAI** in either direction — **re-enforced at
  execution time**: `direct.mjs` re-derives the delta from live chain state,
  refuses the batch when the live delta exceeds the hard cap, and narrows it
  to the plan's `capitalDeltaWei` when live drift would widen the move
- a scraped web print diverging > ±15% from the latest DKIM oracle observation
  can never anchor strikes (plausibility gate)
- premium always in **[500, 5000] bps**
- at most **one** new series per run (structurally: a single object or `null`)
- never an obs window overlapping **any unsettled** series' obs window
- **`saleEnd ≤ obsStart` always** (production rule)
- all series timestamps strictly future and ordered (`validateSeriesParams`)
- **refuse everything** if the chain-state read failed (`plan.refused`, exit 3)

## Interfaces (for collectors/executors)

`decide()` consumes:

```js
signals = {
  prints: [{ t: unixSec | null, cents: int, source: "credaily-web" }, ...],  // may be empty;
                    // t null = unknown-age (treated as stale: corroborate, never anchor)
  kalshi: { probVacancyBelow: 0..1 } | null,  // active nearest-expiry KXMANOFFVAC w/ open interest
}
chainState = {   // produced by run.mjs readChainState(); ok:false => refusal
  ok: true, nowSec, salesPaused, freeCapitalWei, sponsorWxdaiWei, /* bigints */
  series: [{ settled, saleEnd, obsStart, obsEnd, redeemEnd, ... }],
  oracle: { observations: [{ t, cents }] },
}
```

`run.mjs --execute` calls `executors/index.mjs` `execute(plan, { dryRun:false })`
and treats `result.direct.ok && result.direct.executed.length > 0` as "acted"
(exit 2). `!direct.ok` with `executed.length > 0` is **PARTIAL** (exit 4):
txs landed, then the batch aborted — the report gets `execution.partial: true`
and the landed tx hashes are listed.

## Running

```sh
cd agent && npm install

node run.mjs                    # dry run (default): real signals + real chain reads, no txs
node run.mjs --skip-collectors  # chain-only signals (offline-ish)
node run.mjs --execute          # ACT on-chain — needs DEPLOYER_PRIVATE_KEY (see below)

npm run test:policy             # policy unit tests (node --test)
npm test                        # policy + collectors + executors tests
```

Every run writes `runs/<YYYY-MM-DD>.json` (signals, chain state, plan,
execution result; last run of the day wins; the RPC URL is redacted to host
only — keyed URLs never reach the report or stdout). Exit codes: **0** ok /
dry-run, **2** acted on-chain, **3** refused (nothing sent), **4** PARTIAL
(some txs landed, then the batch aborted — check the listed tx hashes),
1 unexpected error.

Env (repo-root `.env` is auto-loaded, real env wins; **never commit keys** —
`.env` is gitignored and CI greps for leaks):

- `GNOSIS_RPC_URL` — defaults to `https://rpc.gnosischain.com`
- `DEPLOYER_PRIVATE_KEY` — the sponsor key (`0x6636…D9F0`), only for `--execute`
- `BANKR_API_KEY` — optional, enables the Bankr advisory executor

## Enabling execution in CI

`.github/workflows/agent-daily.yml` runs a **dry run every day at 13:00 UTC**
(after CRE Daily's morning send) and uploads the run report artifact. It never
executes on a schedule.

To execute from CI (operator opt-in, deliberate every time):

1. Add the `DEPLOYER_PRIVATE_KEY` repository secret (optionally `BANKR_API_KEY`).
2. Actions → *agent-daily* → *Run workflow* → set **execute = true**.

The execute step fails fast if the secret is missing, maps exit 2 ("acted") to
success, surfaces exit 4 ("PARTIAL — some txs landed before the batch
aborted") as a distinct error telling the operator to check the landed tx
hashes, and never echoes secret material. Note the sponsor wallet currently
holds ~0.001 xDAI — top up gas before expecting sustained execution.

## Bankr integration (stub)

Bankr (`api.bankr.bot`) has **no Gnosis support** and the CoverPool sponsor is
immutable, so a Bankr wallet can never pull the sponsor levers. Its honest role
here is advisory/notification: when `BANKR_API_KEY` is set, the executor layer
consults the Bankr Agent API for a second opinion on the Plan and posts
post-execution notifications (and can optionally mirror a correlated position
on Base). It can never originate numbers or widen a Plan; by default even its
"veto" is recorded, not enforced. Details, key provisioning, and configuration
live with the executor: see `executors/bankr.mjs` (executor workflow documents
specifics).
