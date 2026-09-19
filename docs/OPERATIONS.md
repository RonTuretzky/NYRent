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
