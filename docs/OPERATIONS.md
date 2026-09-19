# Operations

Runbooks for deploying the contracts, recording a settlement email, and recovering from the
failure modes the protocol documents. Trust boundaries live in [PROTOCOL.md](PROTOCOL.md);
the Uniswap pay-with-any-token wiring in [UNISWAP.md](UNISWAP.md). ([SPEC.md](SPEC.md) is the
frozen legacy record of the original v1 build and no longer describes the deployed
interfaces.)

## Environment

Copy `.env.example` to `.env` (gitignored) and fill:

| Variable | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Deployer key (in the retired v1 also the pool sponsor; the current pool has no roles). **Never committed, never echoed.** The real deployer is `0x6636A1CCBdf54485067304C1a590DE016DeaD9F0`. |
| `GNOSIS_RPC_URL` | Gnosis RPC, e.g. `https://rpc.gnosischain.com` |

No private key ever appears in the repository, CI logs, or `deployment.json`. Local e2e uses only
the publicly known Anvil dev accounts.

## Deploy runbook (Gnosis, chainId 100) — Legacy (retired v1)

> **Legacy (retired v1).** This runbook and its gas table record the 2026-09-18 execution
> against the SPONSOR-model contracts (fund/withdraw levers, demo series created at deploy).
> It is preserved as history; nothing below is how the current permissionless version deploys.
> For the current procedure see the [Arbitrum deployment (current)](#arbitrum-deployment-current)
> runbook — same script on any chain, and **mainnet deploys create no series** (the agent, or
> any underwriter, escrows capacity and calls the permissionless `createSeries` afterwards).

1. **Preconditions.**
   - `forge --version` ≥ 1.5, solc 0.8.26 per `foundry.toml`.
   - Verify the currency before pinning (SPEC §2.4 requires this check by RPC):

     ```sh
     cast call 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d "symbol()(string)"   --rpc-url $GNOSIS_RPC_URL   # WXDAI
     cast call 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d "decimals()(uint8)"  --rpc-url $GNOSIS_RPC_URL   # 18
     ```
   - Confirm the generated key constant matches the fixture:
     `src/gen/CredailyKey.sol` modulus keccak must equal
     `0x2f2f9938845a16a65bb4651356bc7d160fca499a50aea0c158b2b766c6b84a41`
     (see [VERIFICATION.md](VERIFICATION.md)).

2. **Estimate first, deploy second.** Run the estimate and, if short, **report the exact
   shortfall instead of partially deploying**:

   ```sh
   source .env
   forge script script/Deploy.s.sol:Deploy --rpc-url "$GNOSIS_RPC_URL"                   # simulate + estimate
   forge script script/Deploy.s.sol:Deploy --rpc-url "$GNOSIS_RPC_URL" \
     --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast                                   # real deploy
   ```

   **Measured cost (local Gnosis fork, 2026-09-18).** The full path was rehearsed against
   `anvil --fork-url https://rpc.gnosischain.com` (fork gas price ≈ 1 gwei): `Deploy.s.sol`
   broadcast, then `scripts/e2e-mainnet.mjs --dry-run` and the full live lifecycle:

   | Step | Gas (actual receipts) |
   |---|---|
   | Deploy `CredailyRentOracle` | 2,626,772 |
   | Deploy `CoverToken` | 1,233,389 |
   | Deploy `CoverPool` | 1,635,029 |
   | `createSeries` (demo) | 103,991 |
   | wrap 0.002285 xDAI → WXDAI | 45,041 |
   | `approve` | 46,085 |
   | `fundPool(0.002)` | 61,795 |
   | `buyProtection(0, 0.001, …)` | 99,136 |
   | `submitObservation` (real 110,429 B `.eml`) | 4,177,060 |
   | `settle` | 91,308 |
   | `redeem` | 93,228 |
   | **Total deploy + lifecycle** | **10,212,834** |

   At the observed ~1 gwei that is **≈ 0.0102 xDAI of gas**, plus **0.002285 xDAI wrapped to
   WXDAI** for the fund + premium (recoverable: 0.00061 comes back as the redemption payout and
   the rest is sponsor `withdrawExcess`-able) — **≈ 0.0125 xDAI cash needed up front**. The
   deployer wallet holds ~0.00102 xDAI, so the exact shortfall is **≈ 0.0115 xDAI**
   (0.015 recommended for gas-price headroom). Dry-run gas *estimate* for the lifecycle alone
   (`e2e-mainnet.mjs --dry-run` on the fork) was 4,748,186 gas ≈ 0.00475 xDAI, consistent with
   the 4,613,653 measured.

   **Fork-rehearsal gotcha:** Anvil's well-known dev account #0 carries an EIP-7702 delegation
   on real Gnosis (sweeper bots own that public key), so on a fork its code intercepts the
   ERC-1155 mint callback and `buyProtection` reverts. Clear it first:
   `cast rpc anvil_setCode 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x --rpc-url <fork>`.
   The real deployer key has no delegation; this is fork-only.

   The gas table above is the measured cost of the 2026-09-18 executed run (the retired v1
   sponsor-model contracts, no router, demo series created at deploy). A re-run today deploys
   the current permissionless stack — oracle → token → pool → router, **zero series on
   mainnet** — and prices differently; simulate first, as always. Broadcast output is
   etherform-compatible (`broadcast/Deploy.s.sol/100/run-latest.json`).

3. **Record addresses.** Write `web/src/deployment.json`
   (`{ chainId, oracle, pool, token, currency, seriesIds }`) from the broadcast file and update
   the addresses section of `README.md`. The app build bakes `web/src/deployment.json` in, so
   redeploying GitHub Pages after an address change means rebuilding `web/` and pushing the
   `gh-pages` branch.

4. **Verify sources.** Blockscout's etherscan-compat `/api` now rate-limits keyless
   verification, so use Sourcify (Blockscout auto-imports Sourcify matches):

   ```sh
   forge verify-contract <addr> src/CredailyRentOracle.sol:CredailyRentOracle \
     --chain 100 --verifier sourcify
   # repeat for CoverToken, CoverPool; poll the printed job URL until exact_match
   ```

5. **Lifecycle smoke on mainnet.** `node scripts/e2e-mainnet.mjs` runs the entire tiny lifecycle
   (fund, buy, `submitObservation` with the real fixture email, `settle`, `redeem`) against the
   fresh deployment using the env key. Defaults are 0.0004 fund / 0.0002 max-claim; override
   with `--fund`/`--claim`.

### Executed deployment (2026-09-18) — legacy artifact

The runbook above was executed against Gnosis mainnet; all three contracts are Sourcify
`exact_match` verified. **This deployment predates the current contract version** — its
`CoverPool` is the sponsor model (immutable sponsor holding fund/withdraw/pause levers, a
shared capital pot, no `buyProtectionFor`, no `SwapAndBuyRouter`), where the current version
is fully permissionless with per-series creator escrow and no roles at all — and it remains
live on-chain as a documented legacy artifact only. The codebase carries exactly one contract
version (the current `src/CoverPool.sol`); any new deployment, on any chain, uses it.

| Contract | Address |
|---|---|
| `CredailyRentOracle` | `0xdd45a0f7fcA25dD540625130d6c252b1880D0561` |
| `CoverToken` | `0x48Db7336C15DC4439aE3F023e24FAA26b400CC87` |
| `CoverPool` | `0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3` |

Lifecycle run (series 0, real 2026-09-17 email): `submitObservation`
tx `0x6370f8ad14ec73b4a7b1d7c030fecf6fcc3484eb128d64d89e1b4c41d37cb0c6` (block 48320714,
recorded `t=1789642464`, `cents=9288`,
`emailId=0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1`), `settle`
tx `0xf7572e1f0886141324fa65af2ca2a3deccec9b6f0450624c21af8707db8922fc` (block 48320715,
gas 91,309, payout ratio 0.61 WAD-scaled), `redeem`
tx `0xa3fabcc5580055b4bac50f6e470922202f3bff54f214fcf5e625f19d8176f2d9` (block 48320716,
gas 78,485). Buyer paid 0.000057 WXDAI premium on 0.0002 max claim and redeemed
0.000122 WXDAI. Gas prices on Gnosis were ~17 nano-gwei at the time — total fees for the
entire deploy + lifecycle were on the order of 10⁻¹⁰ xDAI, far below the fork-rehearsal
estimate at 1 gwei.

### CI path (etherform)

`.github/workflows/cicd.yml` calls
`BreadchainCoop/etherform/.github/workflows/_foundry-cicd.yml@main` (foundryup breakage
fixed upstream in etherform PR #60) — every push/PR runs
`forge build`, `forge test`, `forge fmt --check`. `.github/deploy-networks.json` maps chainId 100
to `https://gnosis.blockscout.com` so an operator-triggered deploy run resolves the explorer.
PR-triggered deploys are deliberately **off** (`deploy-on-pr` unset): mainnet xDAI deploys stay a
manual, local, operator action with the key only ever in local env.

## Settlement runbook

Settlement needs one authentic CRE Daily "Market Snapshot" email whose signed `t` falls inside
the series observation window.

1. **Get the original `.eml` out of Gmail.** Open the specific newsletter message → three-dot
   menu → **Download message**. Do not forward it, do not use "Print"; only the original raw
   message preserves the signed bytes. (The signed `to:` recipient becomes public on-chain —
   use a throwaway mailbox; ours is documented in PROTOCOL.md.)
2. **Preflight locally.** Either drag the `.eml` onto the app's `/settle/:id` page (per-check
   pass/fail list) or run:

   ```sh
   node scripts/verify-eml.mjs path/to/message.eml
   ```

   Fix nothing by hand — if a check fails, the email is unusable by construction (wrong template,
   rotated key, tampering in transit). See recovery below.
3. **Submit.** Two transactions, both permissionless:
   - via app: `/settle/:id` → *Record observation* then *Settle series*;
   - or headless:

     ```sh
     node scripts/settle.mjs --eml path/to/message.eml --series <id> \
       --deployment web/src/deployment.json     # key via env, never argv
     ```

   If the oracle already knows the email (`AlreadyRecorded`), the tooling skips straight to
   `settle` — recording is global, one settlement email can settle many series.
4. **After settlement.** Buyers redeem on `/redeem/:id` until `redeemEnd`; after `redeemEnd`
   each series creator's residual (`escrow − paidOut + premiumsAccrued`) becomes withdrawable
   through the one-shot `withdrawResidual(seriesId)`. Settlement gas for the real
   fixture: `submitObservation` executes in 3,854,631 gas (`RealEmail.t.sol` `--gas-report`;
   `extractSnapshot` alone is 1,619,795 for the 102 KB body) and costs 4,177,060 gas as an
   on-chain transaction (measured on a Gnosis fork — the difference is calldata intrinsic gas
   for the 110 KB payload); at typical 1–2 gwei that is ≈ 0.004–0.008 xDAI.

## Local stack (development and e2e)

| Port | Process |
|---|---|
| 8547 | Anvil, chainId 31337 (spawned by the Playwright global setup, or `anvil --port 8547 --chain-id 31337`) |
| 5174 | `vite preview` of the built app (e2e; `npm --prefix web run preview`) |
| 5173 | `vite` dev server (manual development) |

`npm run e2e` at the repo root orchestrates the whole loop: Anvil (clock pinned with
`--timestamp` before the fixture email's signed `t` — required now that `saleEnd ≤ obsStart`
is a contract rule and only local chains get a demo series, escrowed inline by the dev key) →
`Deploy.s.sol` with the well-known Anvil dev key #0 → currency seeding → `vite build && vite
preview` → the Playwright journey/failure suites. See [TESTING.md](TESTING.md) and
`e2e/README.md`. Local runs write a temporary `web/src/deployment.json` (restored afterwards)
and never touch mainnet chains or real keys.

## Recovery

- **Preflight says the body hash or signature fails** on a Gmail original: the message was
  modified after signing (some clients rewrite MIME on export) — re-download from the web Gmail
  three-dot menu, and compare against the committed fixture flow in `docs/VERIFICATION.md`.
- **Template drift** (extraction check fails on an authentic email): the oracle cannot record it,
  by design. Open series ride to `redeemEnd` with no payout, then reserves release. New template
  ⇒ reviewed new deployment; do not loosen parsing.
- **Key rotation** (RSA check fails on an authentic new email while old fixtures still pass): the
  immutable oracle is stranded for future emails. Re-pin path = deploy a **new**
  `CredailyRentOracle` with the new DNS key after redoing the whole evidence chain in
  [VERIFICATION.md](VERIFICATION.md), then create new series against it. Existing series on the
  old oracle keep their original terms.
- **Transaction reverted:** the app decodes custom errors (`AlreadyRecorded`, `BadSignature`,
  `BadBodyHash`, `AnchorNotUnique`, window/solvency errors) into human-readable copy; the same
  names appear in `cast` traces. Reread series state before retrying.
- **RPC down / wrong network:** the app prompts a RainbowKit switch; headless tooling takes
  its RPC URL from env — point it at any healthy endpoint for the deployment's chain.
- **Creator liquidity:** escrow backing sold cover is untouchable while claims are live. A
  reverting `withdrawResidual` means the claim window is still open (`RedeemWindowOpen`) or
  the one-shot already happened (`ResidualAlreadyWithdrawn`); `cancelSeries` refunds only
  while `sold == 0`. There is nothing else to unlock — wait for `redeemEnd`.

## Agent runbook (daily rent-scout, `agent/`)

The `agent/` package (own `package.json`, Node ≥ 22, `viem` as its only dependency) is the
autonomous reference underwriter: real collectors (CRE Daily web archive, Kalshi, CRE reports,
the on-chain oracle) → deterministic policy (`agent/policy/decide.mjs`, pure + clamped) →
executors (`agent/executors/direct.mjs`). Full architecture, policy-constant table, and a
worked example live in [`agent/README.md`](../agent/README.md).

> Against the CURRENT permissionless pool the agent holds no role at all: it is one underwriter
> wallet among any number, escrowing its own capital inside `createSeries` and managing only
> its own series (pause / addCapacity / cancel / residual). The executor specifics below that
> name sponsor levers (`fundPool`, `setSalesPaused`, `withdrawExcess`) describe the agent as
> built against the retired v1 Gnosis pool, which remains live as a legacy artifact; the
> `agent/` workflow owns updating them.

### Dry run (default — never touches the chain, no key needed)

```sh
npm run agent            # repo root: installs agent deps + runs a dry run
# or, inside agent/:
npm install && node run.mjs            # live collectors + live Gnosis reads
node run.mjs --skip-collectors         # chain-only signals (offline endpoints)
```

The run prints the signal notes, chain state, every policy rationale line, and the Plan table,
then writes the machine-readable report to `agent/runs/<date>.json` (gitignored; CI uploads it
as an artifact). Exit codes: `0` ok/dry, `2` acted, `3` refused (e.g. failed chain read), `1`
unexpected error. Safety clamps enforced by the policy: ≤ 0.5 WXDAI capital delta per run,
premium in [500, 5000] bps, at most one new series per run, no obs-window overlap with
unsettled series, `saleEnd <= obsStart` always, refusal without a verified chain read.

Tests: `npm test` inside `agent/` (all `*.test.mjs` against real captured fixtures);
`npm run test:fork` spawns `anvil --fork-url` against Gnosis mainnet, impersonates the sponsor,
and proves every sponsor lever (wrap → exact approve → `fundPool` → `createSeries` →
`setSalesPaused` → `withdrawExcess`) end-to-end without spending real funds.

### Scheduled runs + enabling on-chain execution (GitHub Actions)

`.github/workflows/agent-daily.yml` runs the dry run every day at 13:00 UTC (after CRE Daily's
morning send) and uploads `agent/runs/*.json`. Scheduled runs **never** execute.

To allow on-chain execution (operator opt-in, per run):

1. Add the repository secret `DEPLOYER_PRIVATE_KEY` (Settings → Secrets and variables →
   Actions). This is the agent's underwriter wallet key (v1: the pool sponsor key) — same
   hygiene as the deploy runbook: never committed, never echoed; the workflow passes it via
   step `env` only and fails fast if it is missing.
2. Trigger the workflow manually: Actions → agent-daily → *Run workflow* → set `execute=true`.
   Exit `2` (acted) is mapped to success; exit `3` (policy refused) fails the run — read the
   uploaded run report before retrying.
3. Locally the same path is `node run.mjs --execute` with `DEPLOYER_PRIVATE_KEY` in the
   repo-root `.env`. The executor re-reads live state, simulates each transaction immediately
   before sending, aborts the batch on first failure, and refuses if the signer is not the
   on-chain sponsor or if sponsor xDAI cannot cover wrap value + 3× estimated fees.

### Bankr (optional, strictly advisory)

Bankr has **no Gnosis support**, so Bankr can never execute against the Gnosis pools (and the
current permissionless pool has no role to hand over in any case — an "agent takeover" is just
a different wallet underwriting its own series). With the `BANKR_API_KEY` secret/env
set, `agent/executors/bankr.mjs` adds: a pre-execution
second opinion on the Plan via `api.bankr.bot` (approve/caution/veto — recorded, non-blocking
unless `BANKR_ADVISORY_BLOCKING=1`), a post-execution operator notification, and an optional
tiny Base-chain mirror (double-gated: also needs `BANKR_MIRROR=1`). `BANKR_LLM_KEY` enables the
OpenAI-compatible `llm.bankr.bot` gateway for the advisory prompt. Without the key everything
degrades to `{enabled:false}` no-ops — Bankr can never block Direct execution.

## Arbitrum deployment (current)

Runbook for `script/Deploy.s.sol` on **Arbitrum One, chainId 42161** — the permissionless
contract version ({CredailyRentOracle} with the same pinned CRE Daily key, {CoverToken}, the
no-roles {CoverPool}, {SwapAndBuyRouter}). The same single script serves every chain; only the
per-chain defaults differ. **Mainnet deploys create no series**: the stack ships empty and the
first series comes from whoever escrows capital through the permissionless `createSeries` —
the reference agent, or any underwriter (the postflight asserts `seriesCount() == 0` and that
no sponsor/owner-era selector answers on the pool).

**Six decimals.** The pool currency on Arbitrum is native (Circle-issued) USDC — **6 decimals,
not 18**. The pool math is decimal-agnostic, but every human-entered amount (escrow capacity,
max-claim, premium) is in 6-dec units: `500000` = 0.5 USDC.

1. **Preconditions.**
   - `forge --version` ≥ 1.5, solc 0.8.26 per `foundry.toml`; `ARBITRUM_RPC_URL` set, e.g.
     `https://arb1.arbitrum.io/rpc`.
   - Verify the currency and swap router before pinning (the script re-checks both by RPC and
     reverts on mismatch):

     ```sh
     cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "symbol()(string)"   --rpc-url $ARBITRUM_RPC_URL  # USDC
     cast call 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 "decimals()(uint8)"  --rpc-url $ARBITRUM_RPC_URL  # 6
     cast call 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 "factory()(address)" --rpc-url $ARBITRUM_RPC_URL  # 0x1F98…F984
     ```
   - Confirm the generated key constant exactly as in the Gnosis runbook — the oracle bytecode
     and DKIM key are identical; the `modexp` precompile (0x05) the RSA check needs exists on
     Nitro.
   - Optional env: `CURRENCY` overrides the pool currency (defaults to native USDC above);
     `UNISWAP_ROUTER` overrides SwapRouter02 (defaults to the canonical `0x68b3…Fc45` on
     Arbitrum and `0xc6D2…e9Be` on Gnosis; zero address skips the router deploy — the default
     on local chains).

2. **Estimate first, deploy second.** Same rule as on Gnosis — if the deployer is short, report
   the exact shortfall instead of partially deploying:

   ```sh
   source .env
   forge script script/Deploy.s.sol:Deploy --fork-url "$ARBITRUM_RPC_URL"               # simulate + estimate
   forge script script/Deploy.s.sol:Deploy --rpc-url  "$ARBITRUM_RPC_URL" --broadcast   # real deploy (key via env)
   ```

   **Simulated cost (Arbitrum One fork, 2026-09-19).** Tx-level estimates from the dry run
   (they include intrinsic/calldata gas and Foundry's buffer). Arbitrum adds an L1 data fee on
   top of L2 gas, so receipts will read slightly higher:

   | Step | Gas (tx-level estimate) |
   |---|---|
   | Deploy `CredailyRentOracle` | 3,911,713 |
   | Deploy `CoverToken` | 1,899,861 |
   | Deploy `CoverPool` | 2,833,532 |
   | Deploy `SwapAndBuyRouter` | 1,021,742 |
   | **Estimated total** | **≈ 9,666,848** |

   At the observed ~0.04 gwei Arbitrum gas price the whole run priced at **≈ 0.00039 ETH**.
   (Figures from the 2026-09-19 dry run of the immediately preceding contract version; the
   permissionless `CoverPool` differs by a few storage fields and drops the demo-series
   transaction entirely, so re-simulate for exact numbers — the same dry run against Gnosis
   estimated ≈ 8.7M gas total, ≈ 1.7e-10 xDAI at the observed fork gas price.)

   The script deploys `CredailyRentOracle` → `CoverToken`+`CoverPool` (CREATE-address
   precompute for the circular immutable) → `SwapAndBuyRouter` against SwapRouter02 (the router
   reads the pool currency from `pool.currency()` — a currency mismatch is impossible by
   construction) — **and nothing else on mainnet: zero series** — then asserts the deployed
   state: wiring, `seriesCount() == 0`, the absence of every sponsor/owner-era selector on the
   pool, and the router's `pool`/`swapRouter`/`usdc`/`weth9` targets (the `weth9` check
   re-reads `SwapRouter02.WETH9()` by RPC, so a wrong router override cannot pass postflight).
   Broadcast output is etherform-compatible (`broadcast/Deploy.s.sol/42161/run-latest.json`).

3. **First series (post-deploy, permissionless).** The deployer holds no role, so opening the
   market is an ordinary underwriter action from any wallet: approve the pool for the capacity,
   then `createSeries(strikes, rateBps, saleEnd, obsStart, obsEnd, redeemEnd, capacity)` — the
   capacity is escrowed 1:1 in the same transaction, and `saleEnd ≤ obsStart` (all timestamps
   future and ordered) is enforced on-chain. The reference agent prices and opens the standard
   monthly series this way (see the agent runbook above); a human with `cast` can do the same.

4. **Record addresses and verify sources.** As in the Gnosis runbook: write the deployment
   record from the broadcast file, then Sourcify with `--chain 42161` (Blockscout at
   `https://arbitrum.blockscout.com` auto-imports Sourcify matches); repeat for all four
   contracts. `.github/deploy-networks.json` maps chainId 42161 to that explorer for the CI
   deploy path — PR-triggered deploys stay **off**, mainnet deploys stay a manual, local,
   operator action with the key only ever in local env.

5. **Local rehearsal.** The same script serves anvil (chainId 31337) — and any other chain
   without pinned defaults: with no `CURRENCY` override it deploys the `LocalWXDAI` stand-in
   (18 decimals) and skips the router unless `UNISWAP_ROUTER` points at deployed code. Local
   chains are the ONE place the script still creates the demo series (escrowed inline by the
   broadcaster, window derived from the chain clock) so the e2e loop has something to buy —
   spawn anvil with the pinned `--timestamp` (see the local-stack section) or the script
   reverts rather than mint a series the fixture email could never settle.

### Underwriter trust model (Option B — no roles, no handoff)

There is no sponsor role and therefore no takeover runbook: an "agent takeover" is just a
different wallet underwriting its own series. Facts to internalize before running an
underwriter wallet (agent or human):

- **Capital commits at creation.** `createSeries`/`addCapacity` escrow real funds immediately;
  the only ways back out are `cancelSeries` (whole escrow, but only while `sold == 0`) and the
  one-shot `withdrawResidual` after `redeemEnd`. Once a single unit is sold, the escrow is
  locked for the full window — size series accordingly.
- **Levers are per-series and cannot protect capital.** Pausing sales stops new premium income,
  nothing else; no lever moves escrow backing sold cover. There is no global pause and no
  other wallet that can intervene, for good or ill.
- **Capacity mirror deviation.** Off-chain mirrors of series capacity (dashboards, agent policy
  constants) drift from `series().escrow − sold` the moment anyone buys; always re-read
  on-chain state before acting, exactly like the agent executor already does.

## Market-maker policy (two-sided agent, `agent/policy/`) — APPEND 2026-09-19

The agent's mandate changed with the permissionless pool: it is now a
**two-sided market maker running a hold-to-settlement book**, not a sponsor
steward (the sponsor machinery — `fundPool`/`withdrawExcess`/global pause —
no longer exists on-chain or in the policy). Full story and interface contract:
`agent/README.md`. Operational facts:

- **One model, both sides.** `agent/policy/valuation.mjs` prices ANY series
  (arbitrary strikes/windows) as `fairRatioBps` = E[settlement ratio] under a
  Bachelier normal around the latest authoritative print; σ from print history
  (fallback $1.50/SF-month), horizon to the observation-window midpoint. The
  SELL side quotes `fair × 1.25`; the BUY side arbs any open series quoted
  ≤ `fair − 300 bps` (default edge).
- **Per-run risk caps** (all in per-target currency units; `decimals` 18 on
  Gnosis WXDAI, 6 on Arbitrum USDC): sell escrow ≤ 0.5 units, total buy
  notional ≤ 0.5 units (separate clamp), per-series buys ≤ 25% of remaining
  capacity, premiums bounded by the wallet balance left after the sell escrow.
  Own premium clamped [500, 5000] bps. One own series per run, no own obs-window
  overlap, `saleEnd == obsStart`, `redeemEnd ≥ obsEnd + 7d`.
- **Stale-data behavior**: stale print (>45d) halves deployable sell capital,
  blocks new series AND refuses the entire buy leg (a stale fair value is the
  one an adversary would trade against); blackout (>60d) additionally pauses
  own open series. The policy never auto-unpauses (`allowUnpause` opt-in).
- **Inventory lean** (reviewed in every run report under `plan.inventory`):
  `netExposureUnits = Σ own unsold capacity × fair − Σ held cover × fair`;
  beyond ±0.1 units the next cycle leans — net short: next premium +100 bps,
  buy edge relaxed to 200 bps; net long: buy edge tightened to 400 bps, next
  premium −100 bps. Positions are soulbound: there is no unwind, only leaning.
- **Own-series hygiene** the policy emits automatically: `withdrawResidual`
  after `redeemEnd`, `cancelSeries` for own UNSOLD series whose sale ended or
  whose strikes drifted a full band (800¢) off a fresh print.
- **Execution boundary (unchanged discipline).** Dry-run by default; reports in
  `agent/runs/<date>.json` with RPC hosts redacted and no key material ever.
  Gnosis executes via the direct viem executor. On Arbitrum the execution
  surface is the **Bankr Wallet API** (Bankr wallet
  `0x1a72…5561`, funded 2026-09-19: 0.0005 ETH + 2.0 USDC), but **live
  Bankr-custodied executions are out of scope for automated runs**: everything
  is fork-proven on an anvil Arbitrum fork, and the first live Bankr action is
  a separate operator step after review. Bankr's AI advisory returns
  `subscription_required` on the current key; the advisory path degrades to a
  single honest line in the report and never blocks or fakes a verdict.
- **Review checklist for a run report**: (1) `plan.rationale` — every clamp
  that fired is named; (2) `plan.inventory.lean` matches the book you expect;
  (3) every `buys[i].edgeBps ≥ inventory.edgeMinBps` and
  `Σ maxClaimUnits ≤ 0.5 units`; (4) `pauses`/`cancels`/`withdrawResiduals`
  name only agent-created series ids; (5) refusals (exit 3) name the failed
  input, never a guess.

## Agent as market maker + Bankr custody — APPEND 2026-09-19

Execution-side companion to the policy section above (`agent/README.md` has the
full story). The agent is one permissionless underwriter/buyer wallet per
target; there are no roles to hand over and no privileged runbook — only
wallets, rails and gates.

### Routing (agent/executors/index.mjs)

| Target | Rail | Notes |
|---|---|---|
| gnosis (100) | direct — viem + `DEPLOYER_PRIVATE_KEY` | Bankr has no Gnosis support (docs.bankr.bot/getting-started/supported-chains) |
| arbitrum (42161) | **bankr** — custodied wallet via the Wallet API | preferred when the triple gate passes; else falls back to direct |

Both rails submit the SAME tx list (single shared builder + state read AS the
executing wallet), and the Arbitrum fallback happens only on a **pre-submit**
gate failure — a mid-batch Bankr failure is final (possibly PARTIAL, exit 4)
and is never re-run on the other rail. No double-execution path exists.

### The triple gate (agent/executors/bankr.mjs)

Custody execution needs ALL of: `BANKR_API_KEY` set, `BANKR_EXECUTE=1`
(explicit opt-in), and a LIVE `GET /wallet/me` returning exactly
`BANKR_WALLET` (`0x1a7223bc942b053794e17b537e73d837cf695561` — verified live
2026-09-19, wallet funded with 0.0005 ETH + 2.0 native USDC on Arbitrum);
plus an on-chain check that the wallet holds the currency the plan pulls
(escrow + premiums, in USDC units). Each tx is simulated from-override as the
Bankr wallet immediately before `POST /wallet/submit` (Bankr signs custodially
and broadcasts — docs.bankr.bot/wallet-api/submit) and receipts are polled
locally; the batch aborts on the first failure with landed hashes listed.

### Bankr account rails (bankr.bot → Security — server-side, key-proof)

Keep the $500/day + $500/tx defaults (per-run caps are ~1 USDC total, far
below). "Enable arbitrary contract calls" must stay ON for raw submits. Set
the WALLET-level permitted-recipients allowlist to **pool + currency + router
only** — the pool txs carry `value: 0` (the wallet-level list gates `to` only
when `value > 0`), so the allowlist never blocks the agent yet stops
value-bearing sends anywhere else; the API-KEY-level allowed-recipients list
must stay OFF (it blocks ALL raw submissions). Add the runner's IP to the key
allowlist and turn on passkey MFA so a leaked API key can neither spend
elsewhere nor loosen the rails.

### Advisory honesty

One Agent-API prompt per run asks Bankr's agent for a second opinion on the
two-sided plan. The current key is free-tier: the Agent API answers HTTP 403
`{"error":"subscription_required"}` (live-captured →
`agent/fixtures/bankr-agent-prompt-subscription-required.json`). The executor
catches exactly that shape and prints ONE honest line, never a fake verdict;
a real verdict is recorded, not enforced (`BANKR_ADVISORY_BLOCKING=1` opt-in).
Bankr Club or Max-Mode credits restore the real second opinion.

### Live-custody status (honest)

Proven: unit suite (gate, paywall degrade, pipeline, PARTIAL semantics) +
`npm run test:fork:bankr` — the production `execute()` against a real anvil
fork of Arbitrum (real contracts, the real wallet's inherited balances; the
only substitution is `/wallet/submit` broadcasting the identical tx from the
impersonated wallet) + live read-only `GET /wallet/me` identity verification.
NOT yet run anywhere: a live funded `POST /wallet/submit`. The first live
Bankr-custodied action is a deliberate manual operator step after review
(set `BANKR_EXECUTE=1`, run `node run.mjs --target arbitrum --execute`),
out of scope for automated runs.

## Multi-target runner + P&L accounting (agent/run.mjs) — APPEND 2026-09-19

The runner is per-target end to end: signals are gathered ONCE (the settlement
metric is chain-agnostic), then each entry of `agent/targets.mjs` — the frozen
registry of the 2026-09-19 permissionless deployments (gnosis/WXDAI/18 dec →
executor `direct`; arbitrum/USDC/6 dec → executor `bankr`) — gets its own
chain read, market scan, plan, P&L block and exit code. Operational facts:

- **Market-scan robustness**: `seriesCount` + per-series struct + creator +
  `seriesPaused` + the agent's CoverToken balances are read per target; ONE
  undecodable series is skipped and recorded (`chainState.scanSkipped`), and
  the policy excludes it from BOTH sides of the book — a single bad row never
  blinds the run. A top-level read failure refuses THAT target only.
- **Per-target isolation + worst-of exit**: a crash, refusal or partial on one
  target never stops the others; the process exit code is the worst across
  targets (severity 1 > 4 > 3 > 2 > 0 — the classic 0/2/3/4 meanings are
  unchanged). `--execute` may name targets (`--execute gnosis`); the rest of
  the run stays dry.
- **Identity resolution** (the policy refuses without one): bankr targets
  prefer `BANKR_WALLET`, direct targets the `DEPLOYER_PRIVATE_KEY`-derived
  address; `AGENT_ADDRESS`/`AGENT_ADDRESS_<TARGET>` give keyless dry runs an
  identity (used by CI). On bankr targets with `BANKR_API_KEY` set the runner
  also does a read-only `GET /wallet/me` and flags a mismatch in the report.
- **P&L block** (per target, cumulative, currency units): premiums earned
  (Σ own-series `premiumsAccrued`) and residuals withdrawn (Σ own-series
  `withdrawn`) come straight from chain state; premiums paid
  (`ProtectionBought` filtered on the indexed buyer) and redemptions received
  (`Redeemed` filtered on the indexed holder) come from chunked event scans
  whose cursor + totals persist in `agent/runs/state-<chainId>.json`
  (gitignored runtime state; the cursor only ever advances, a failed chunk
  holds it for retry, and a wallet change resets the totals with a note).
  First scan looks back `AGENT_PNL_LOOKBACK_BLOCKS` (default 120000) — P&L is
  cumulative FROM FIRST TRACKED RUN, which for these wallets is deployment
  week; it is bookkeeping, not an audit.
- **Execution-time re-enforcement (the drift lesson)**: `direct.mjs` re-reads
  live state and re-derives every cap from the LIVE token decimals before
  building txs — over-cap sell escrow or buy notional refuses the whole batch;
  buy legs are narrowed to live unsold capacity or dropped (paused / settled /
  sale-closed / own series / premium above the authorized max); creator levers
  are dropped when live state says they would revert; the batch refuses when
  wallet balance < escrow + Σ premiums or native gas < 3× estimated fees.
  Proven against real forks of BOTH mainnets: `npm run test:fork` (Gnosis) and
  `npm run test:fork:arbitrum` (USDC decimals matrix), covering escrowed
  create, the buy leg, pause, one-shot residual and the cancel refund.
- **Policy-driven cycle proof** (`npm run test:fork:cycle`, `npm run
  test:fork:cycle:arbitrum` — `agent/executors/mm-cycle-fork-proof.mjs`): where
  the executor fork proofs hand-craft plans, this one lets `decide()` produce
  every plan against a real anvil fork of the deployed pool, driven by a FRESH
  key-signing EOA: cycle 1 sells (0.5-unit escrow clamp binds, escrow pulled
  1:1), a second actor opens an underpriced series and buys our cover, cycle 2's
  re-run plans the arbitrage buy (edge ≥ 300 bps, 25% per-series cap, never own
  series, soulbound cover + premium accounting asserted), and after a warp past
  `redeemEnd` cycle 3 refuses sell+buy on the now-stale print but withdraws the
  residual, proven to the base unit as escrow + premiumsAccrued − paidOut.
  Passed on forks of both mainnets 2026-09-19 (WXDAI 18 dec and USDC 6 dec,
  identical economics). One fork-realism note: anvil's well-known dev accounts
  are unusable as cover recipients on forks — those public keys carry EIP-7702
  delegations on both mainnets, so the soulbound ERC-1155 mint reverts
  `ERC1155InvalidReceiver`; the proof generates ephemeral random EOAs instead.

## Market-maker hardening: redeems, idempotence, self-dealing, P&L, lock — APPEND 2026-09-19

Consolidated fixes from the two-lens (safety + economics) review of the
two-sided agent, all shipped with unit tests and re-proven on both mainnet
forks (`agent/` only; contracts untouched):

- **REDEEM leg — profit realization (was: the buy side could never collect).**
  The Plan gains `redeems: [{seriesId, units}]`: `decide()` emits one for every
  settled holding with `payoutRatioWad > 0` before its `redeemEnd` (staleness
  never blocks it — a settled payout has no valuation dependence), the executor
  builds `redeem(seriesId, units)` (narrowed to live CoverToken holdings,
  dropped when unsettled / window-closed / ratio 0), ordered with the
  collections before the money legs. Holdings that expired unredeemed are
  reported as a realized loss. The cycle fork proofs now drive settlement on
  the fork (a qualifying observation is injected into the oracle's storage —
  scaffolding; the POOL's real `settle()` fixes the ratio) and assert the
  redeem collects EXACTLY units × ratio on both chains, and that a verbatim
  re-run of the executed plan is a local no-op.
- **Plan stamp + re-run idempotence.** `decide()` stamps the plan with
  `{chainId, pool, decidedAtBlock, wallet}`; both rails share `computeTxDiff`,
  which REFUSES any stamped plan whose chainId / pool / executing wallet
  mismatch live state (no cross-target replay; a plan sized for one wallet
  never executes from another). The executors CLI now requires `--target`.
  Sell-leg guard: `createSeries` is dropped when an operator-book OPEN series
  with the same strikes + obs window already exists live. Buy-leg guard: the
  25% per-series cap is CUMULATIVE — `decide()` skips series already held
  at/above cap and sizes new buys net of holdings, and the executor re-checks
  live holdings before each buy.
- **Two-wallet self-dealing exclusion.** `config.operatorWallets` = deployer
  `0x6636A1CCBdf54485067304C1a590DE016DeaD9F0` + Bankr custody wallet
  `0x1a7223bc942b053794e17b537e73d837cf695561`. The buy side never buys ANY
  operator wallet's series on any target (policy + executor, rationale names
  each exclusion), and the one-own-live-sale / obs-window-overlap guards treat
  the operator's wallets as one book.
- **P&L integrity.** `residualsWithdrawn` decomposes into escrow returned
  (capital) + premium income; `claimsPaid` (Σ paidOut on own series) is the
  sell book's realized-loss line; `redemptionsForgone` (settled cover held
  past redeemEnd, valued units × ratio) is the buy book's.
- **Inventory metric.** Net exposure = Σ own-book SOLD × fair (settled: sold ×
  ratio − paidOut; extinguished past redeemEnd) − Σ PURCHASED holdings × fair.
  Unsold capacity is uncommitted, not short (the old unsold-based metric made
  the short lean price the next series UP — counterproductive). Held cover is
  valued 0 past redeemEnd or when the obs window died without a qualifying
  observation, and only cover the agent actually BOUGHT counts — the
  cumulative `ProtectionBought(buyer=agent)` ledger in
  `agent/runs/state-<chainId>.json` separates purchases from outsider-minted
  soulbound gifts, which are reported but can no longer steer the lean.
- **Run lock.** `--execute` takes `agent/runs/.lock` (pid + timestamp, stale
  after 30 min); a concurrent execute run is refused with exit 3.
- **Bankr custody rail: ON HOLD.** Implemented and fork-proven, currently
  dormant; the DIRECT executor (deployer identity) is the active rail on BOTH
  chains. Custody runs only behind an explicit `BANKR_EXECUTE=1`, which also
  flips the Arbitrum plan identity to `BANKR_WALLET` — and a failed custody
  gate then REFUSES that target loudly (exit 3) instead of silently
  downgrading to the direct key. In custody mode `DEPLOYER_PRIVATE_KEY` is not
  required.

Verification 2026-09-19: `npm test` 223/223 green (was 196); `test:fork`,
`test:fork:arbitrum`, `test:fork:cycle`, `test:fork:cycle:arbitrum` all passed
against fresh forks of both mainnets, the cycle proofs ending in a realized
redeem (0.2 units × ratio 0.5 → 0.1 units collected, cover burned) and a
no-op idempotent re-run.

## Current continuation: one September market and Uniswap v4

The September 2026 → September 2027 one-market specification and the subsequent
request to build the v4 hook supersede the October-window sequence below. Website
publication is authorized. New v4 mainnet execution awaits the operator's funding
decision; use [V4-ROLLOUT.md](V4-ROLLOUT.md) for the rehearsed deployment, exact shared
terms, budget checks and restart journal. Bankr remains held. Local/fork addresses
must never be copied into the production manifest.

## Archived next-ops plan (superseded; do not execute)

Both permissionless deployments are live with **zero series**; nothing below has been
executed. The operator-approved sequence, in order:

1. **One demonstration series, created and settled.** The on-chain rules
   (`saleEnd ≤ obsStart`, future-ordered timestamps) mean the archived 2026-09-17 email can
   never qualify for a newly created series — settlement requires the **next authentic
   CRE Daily issue**. Create a short-window series so that cycle completes quickly:
   sale from creation until `obsStart` set a few days out, `obsEnd = obsStart + ~10 days`
   (wide enough to catch one issue at the observed ~2–5 day cadence),
   `redeemEnd = obsEnd + 7 days` (the contract minimum). Strikes/premium: run
   `node agent/run.mjs` and use its plan (standard 800-cent band anchored to the latest
   print; ~919 bps at the current σ), or price manually with `agent/policy/valuation.mjs`.
   When the next issue lands in the throwaway inbox: settle via the app's upload flow (or
   `scripts/e2e-mainnet.mjs` path), redeem any held cover, `withdrawResidual`.

2. **The annual series: observation window October 2026 → October 2027.**
   `saleEnd = obsStart = 1790812800` (2026-10-01 00:00 UTC — sale open from creation until
   then), `obsEnd = 1822348800` (2027-10-01 00:00 UTC), `redeemEnd = 1824940800`
   (obsEnd + 30 days). Strikes: standard band anchored at the latest print (9288/10088 at
   today's data). Premium must be priced at the 1-year horizon — use
   `fairPremiumBps` from `agent/policy/valuation.mjs` with this window (σ scales ≈ √12 vs
   monthly; illustratively ≈ 2,700–2,800 bps at σ=$1.50/SF·mo, but take the engine's
   number at execution time, not this note). Capacity per the operator's capital decision;
   the agent's 0.5-unit clamp applies if executed through `run.mjs`.

Also on hold, in order behind the above: Pages deploy of the multichain RentSafe build,
live-site verification, and guide-GIF re-records for the changed flows. The Bankr custody
rail stays dormant (direct executor on both chains) until re-enabled.
