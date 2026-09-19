# Operations

Runbooks for deploying the contracts, recording a settlement email, and recovering from the
failure modes the protocol documents. Contract interfaces are frozen in [SPEC.md](SPEC.md);
trust boundaries in [PROTOCOL.md](PROTOCOL.md).

## Environment

Copy `.env.example` to `.env` (gitignored) and fill:

| Variable | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Deployer/sponsor key. **Never committed, never echoed.** The real deployer is `0x6636A1CCBdf54485067304C1a590DE016DeaD9F0`. |
| `GNOSIS_RPC_URL` | Gnosis RPC, e.g. `https://rpc.gnosischain.com` |

No private key ever appears in the repository, CI logs, or `deployment.json`. Local e2e uses only
the publicly known Anvil dev accounts.

## Deploy runbook (Gnosis, chainId 100)

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

   The script deploys `CredailyRentOracle` → `CoverToken`+`CoverPool` (CREATE-address precompute
   for the circular immutable) → creates the demo series (strikes 8800/9600, 2850 bps premium,
   obs window 2026-09-01 → 2026-09-30 23:59 UTC = saleEnd, redeem +90 days, capacity 0.02 WXDAI)
   and asserts the deployed state. Broadcast output is etherform-compatible
   (`broadcast/Deploy.s.sol/100/run-latest.json`).

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

### Executed deployment (2026-09-18)

The runbook above was executed against Gnosis mainnet; all three contracts are Sourcify
`exact_match` verified.

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
4. **After settlement.** Buyers redeem on `/redeem/:id` until `redeemEnd`; after `redeemEnd` the
   sponsor's residual reserves become withdrawable (`/sponsor`). Settlement gas for the real
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

`npm run e2e` at the repo root orchestrates the whole loop: Anvil → `Deploy.s.sol` with the
well-known Anvil dev key #0 → currency seeding → `vite build && vite preview` → the Playwright
journey/failure suites. See [TESTING.md](TESTING.md) and `e2e/README.md`. Local runs write a
temporary `web/src/deployment.json` (restored afterwards) and never touch Gnosis or real keys.

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
- **RPC down / wrong network:** the app prompts a RainbowKit switch to Gnosis; headless tooling
  takes `GNOSIS_RPC_URL` from env — point it at any healthy Gnosis RPC.
- **Sponsor liquidity:** `withdrawExcess` can never take reserved collateral; if a withdraw
  reverts, the amount exceeds `freeCapital()` — wait for `redeemEnd` or unsold capacity.

## Agent runbook (daily rent-scout, `agent/`)

The `agent/` package (own `package.json`, Node ≥ 22, `viem` as its only dependency) is the
autonomous sponsor: real collectors (CRE Daily web archive, Kalshi, CRE reports, the on-chain
oracle) → deterministic policy (`agent/policy/decide.mjs`, pure + clamped) → Gnosis executors
(`agent/executors/direct.mjs`). Full architecture, policy-constant table, and a worked example
live in [`agent/README.md`](../agent/README.md).

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
   Actions). This is the immutable CoverPool sponsor key — same hygiene as the deploy runbook:
   never committed, never echoed; the workflow passes it via step `env` only and fails fast if
   it is missing.
2. Trigger the workflow manually: Actions → agent-daily → *Run workflow* → set `execute=true`.
   Exit `2` (acted) is mapped to success; exit `3` (policy refused) fails the run — read the
   uploaded run report before retrying.
3. Locally the same path is `node run.mjs --execute` with `DEPLOYER_PRIVATE_KEY` in the
   repo-root `.env`. The executor re-reads live state, simulates each transaction immediately
   before sending, aborts the batch on first failure, and refuses if the signer is not the
   on-chain sponsor or if sponsor xDAI cannot cover wrap value + 3× estimated fees.

### Bankr (optional, strictly advisory)

Bankr has **no Gnosis support** and the sponsor is immutable, so Bankr can never execute the
pool. With the `BANKR_API_KEY` secret/env set, `agent/executors/bankr.mjs` adds: a pre-execution
second opinion on the Plan via `api.bankr.bot` (approve/caution/veto — recorded, non-blocking
unless `BANKR_ADVISORY_BLOCKING=1`), a post-execution operator notification, and an optional
tiny Base-chain mirror (double-gated: also needs `BANKR_MIRROR=1`). `BANKR_LLM_KEY` enables the
OpenAI-compatible `llm.bankr.bot` gateway for the advisory prompt. Without the key everything
degrades to `{enabled:false}` no-ops — Bankr can never block Direct execution.
