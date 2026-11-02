# RentSafe

**Live app:** https://rentsafe.nyc/ serves **neighborhood rent policies** only: anyone can
create and fund rent protection on an Apartments.com neighborhood page for a month, renters
buy it, and a Google Alerts email verified on-chain (DKIM) sets the headline rent that decides
the payout. Everything is paid in native USDC on **Arbitrum One**. See
[docs/APARTMENTS.md](docs/APARTMENTS.md).

The app reads two policy pools on the same oracle (`0x2352…c855`):

| Pool | Address | Claim token | Rules |
|---|---|---|---|
| **V2** (every new policy) | [`0xe46d…5a14`](https://arbiscan.io/address/0xe46d0489275FC5C7b536dcef06196cd1aA595a14) | [`0x0aa4…AE00`](https://arbiscan.io/address/0x0aa44da9186514fa378af7AC0574062aF8b6AE00) | The creator picks when sales close, up to the last second of the policy month; sales stop as soon as the month's rent is recorded (`RentAlreadyRecorded`); claims open two days after the month. |
| **V1** (earlier policies, at `/policies/v1/:id`) | [`0xa59b…F30A`](https://arbiscan.io/address/0xa59b195135D5220c82d2C19270CadC392585F30A) | [`0x6721…5471`](https://arbiscan.io/address/0x67214a5dA4C99aA11Bd709cf22aAAF98972C5471) | Sales close at the first second of the policy month; claims open seven days after it. |

The addresses the app uses live in `web/src/chain/apartments-deployment.json`.

**Retired from the frontend:** the Manhattan office-rent products (the fixed-price CoverPool
markets on Gnosis and Arbitrum, the Uniswap v4 RENT markets on Polygon and Arbitrum, the CRE
Daily newsletter settlement flow, the Bankr docs, Story and the recorded walkthroughs) no
longer have pages in the app; their old routes redirect to the home page. **Their contracts
remain on-chain and unchanged**, and the sections below document them. Operator tooling for
them keeps its ABIs and deployment records in `scripts/data/` (moved out of `web/src`); the
agent and the v4 docs ([docs/V4.md](docs/V4.md), [docs/V4-ROLLOUT.md](docs/V4-ROLLOUT.md))
are unchanged.

### The office-rent contracts

Fully collateralized, fully permissionless protection against Manhattan office rent staying
high, settled by an email. The oracle input is CRE Daily's "Market Snapshot" newsletter
(**Manhattan Office Rent · Avg Effective $/SF**, CompStak data), verified **entirely on-chain**:
RSA-SHA256 DKIM signature, body hash and template parsing all execute in the EVM against an
immutable pinned key. No committee, no price feed, no trusted server, no ZK ceremony.

## Preserved fixed-price mode

The following describes the fixed-price deployment. Its nontransferable tokens are distinct
from the v4 RENT ERC-20. Neither has a page in the app any more.

The live Gnosis lifecycle was exercised on 2026-09-19 with wallet `0x86213f…112844` and **no
mocked steps**: Gmail's freshly downloaded `.eml` was byte-for-byte identical to the audited
fixture; the buyer minted `0.001` of Series #2 cover;
the already-recorded email was cross-checked against the successful
[`submitObservation` transaction](https://gnosisscan.io/tx/0x6370f8ad14ec73b4a7b1d7c030fecf6fcc3484eb128d64d89e1b4c41d37cb0c6);
Series #2 [settled at 61%](https://gnosisscan.io/tx/0x5811678afbd3f3ac2654212535fe1abc87e9c2d294d6f0be68b0889c8881c87c);
and the holder [burned the claim for `0.00061 WXDAI`](https://gnosisscan.io/tx/0x5096186bfbc7e3d3b6aeabe9259f825fe653bca32ea19680adb0f1524e79a06a).
Series #2 belongs to the retired v1 demo and allowed sales during its observation window, so
the purchase was informed by the public result. This proves the mechanics, not fair market
price discovery; current permissionless pools enforce `saleEnd <= obsStart` on-chain. (The
recorded GIF walkthroughs were removed from the app with the office pages; they remain in git
history.)

- **Anyone underwrites** — there are no roles at all. `createSeries` escrows the creator's own
  capital 1:1 as that series' backing (payout 0 at/below $88.00, 1 at/above $96.00 for the
  demo strikes) and premiums accrue to that series alone; the creator's only levers are
  pausing its own sales, topping up escrow before the sale ends, cancelling while unsold, and
  the one-shot residual withdrawal after the claim window.
- A **buyer** pays a premium (28.50% of max claim in the demo) and mints non-transferable
  ERC-1155 cover units, 1 unit = 1 currency-wei of max claim — backed 1:1 by escrow at the
  moment of purchase. Sales always close before the observation window opens
  (`saleEnd ≤ obsStart` is enforced on-chain), so nobody can buy against an email that may
  already exist.
- **Anyone** may submit an authentic snapshot email to the oracle and settle a series whose
  observation window contains the email's signed timestamp. The 2026-09-17 issue printed
  **$92.88 / SF** ⇒ payout ratio **61%** between the demo strikes.
- Buyers **redeem** `amount × ratio` out of the series escrow; after the redeem window, the
  residual (escrow − payouts + premiums) releases to the series creator.

The settlement statement, trust boundaries, permissionless market structure and limitations
(template drift, key rotation, caveat-emptor series pricing) are in
[docs/PROTOCOL.md](docs/PROTOCOL.md); the pay-with-any-token Uniswap integration in
[docs/UNISWAP.md](docs/UNISWAP.md). The full evidence chain for the pinned DKIM key — DNS
record, fingerprints, Gmail `dkim=pass`, reproducible local verification — is in
[docs/VERIFICATION.md](docs/VERIFICATION.md). ([docs/SPEC.md](docs/SPEC.md) is the frozen
legacy record of the original sponsor-model build.)

**Unaudited. Experimental. The demo series uses tiny amounts of real currency; use tiny amounts.**

## Why on-chain DKIM (and not a Groth16 circuit)

This project mirrors the discipline of issue.fund (pinned immutable key, strict Solidity-parsed
template, timestamp windows, one-shot settlement, local preflight) but verifies the email
directly in the EVM: the newsletter's canonical body is 102 KB — far beyond a zk-email circuit's
body bound — and a mass newsletter needs no privacy. Cheap calldata on the deployed chains
makes direct verification affordable. Full rationale: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quickstart

Prerequisites: Node 22, Foundry ≥ 1.5.

```sh
# Contracts: real-email settlement, tamper matrix, pool fuzz + invariants
forge test -vv

# Web app unit tests (policy helpers, Google Alert parsing, emailkit parity)
npm --prefix web test

# Neighborhood-policy browser suite: Arbitrum One fork on :8551 with a test-key
# oracle and V1 + V2 pools, production build on :5177
npm --prefix e2e install && npm --prefix e2e exec playwright install chromium   # first time
npm --prefix e2e run e2e:policies

# Frontend against your own wallet
npm --prefix web install && npm --prefix web run dev
```

Deploy/settlement runbooks (env, gas estimate discipline, Blockscout verification):
[docs/OPERATIONS.md](docs/OPERATIONS.md). What every suite covers:
[docs/TESTING.md](docs/TESTING.md). The app's own walkthrough is the policy guide
(https://rentsafe.nyc/#/policies/guide).

## Fixed-price deployments (permissionless version, 2026-09-19)

The fixed-price contract version is on two chains, all eight contracts Sourcify `exact_match` verified. The additive v4 stack has its own deployment manifest and does not change these addresses.
Both pools launched with **zero series** — underwriting is a permissionless post-deploy act
(see the on-hold ops plan in [docs/OPERATIONS.md](docs/OPERATIONS.md)).

| Contract | Gnosis (100) | Arbitrum One (42161) |
|---|---|---|
| `CoverPool` | [`0x68A3b66c…9Aa3`](https://gnosis.blockscout.com/address/0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3) | [`0x6699fb5c…5e4c`](https://arbiscan.io/address/0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c) |
| `CredailyRentOracle` | [`0xCBD1F13e…6E43`](https://gnosis.blockscout.com/address/0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43) | [`0x128fF279…59B3`](https://arbiscan.io/address/0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3) |
| `CoverToken` | [`0x821d100A…C857`](https://gnosis.blockscout.com/address/0x821d100Aa36Beec16D830C7E2B8D5249AF62C857) | [`0xaB1abFCa…925E`](https://arbiscan.io/address/0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E) |
| `SwapAndBuyRouter` | [`0x36861cbD…5f8b`](https://gnosis.blockscout.com/address/0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b) | [`0xFE9CA93d…2F2F`](https://arbiscan.io/address/0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F) |
| Currency | WXDAI `0xe91D…a97d` (18 dec) | USDC `0xaf88…5831` (6 dec) |

## Legacy deployment (retired sponsor-model v1 — Gnosis, chainId 100)

Deployed 2026-09-18 and settled the same day with the real 2026-09-17 newsletter; retired
2026-09-19 (free capital withdrawn, outstanding sold cover stays backed). All three
contracts are source-verified (Sourcify `exact_match`, imported by Blockscout).

| Contract | Address |
|---|---|
| `CredailyRentOracle` | [`0xdd45a0f7fcA25dD540625130d6c252b1880D0561`](https://gnosis.blockscout.com/address/0xdd45a0f7fcA25dD540625130d6c252b1880D0561) |
| `CoverPool` | [`0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3`](https://gnosis.blockscout.com/address/0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3) |
| `CoverToken` | [`0x48Db7336C15DC4439aE3F023e24FAA26b400CC87`](https://gnosis.blockscout.com/address/0x48Db7336C15DC4439aE3F023e24FAA26b400CC87) |
| Currency (WXDAI) | `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` |

Pinned DKIM key: `d=newyork.credaily.com`, `s=b37`, RSA-2048,
`keccak256(modulus) = 0x2f2f9938…4a41` ([docs/VERIFICATION.md](docs/VERIFICATION.md)).

### Recorded lifecycle (series 0, mainnet)

The demo series ran the entire flow on-chain with the real email:

| Step | Tx |
|---|---|
| `submitObservation` — the 2026-09-17 `.eml` (1,378 B signed headers + 102,197 B canonical body + RSA sig) DKIM-verified in the EVM, `$92.88/SF` extracted | [`0x6370f8ad…7cb0c6`](https://gnosis.blockscout.com/tx/0x6370f8ad14ec73b4a7b1d7c030fecf6fcc3484eb128d64d89e1b4c41d37cb0c6) |
| `settle(0)` — ratio = clamp((9288−8800)/(9600−8800)) = **0.61** | [`0xf7572e1f…8922fc`](https://gnosis.blockscout.com/tx/0xf7572e1f0886141324fa65af2ca2a3deccec9b6f0450624c21af8707db8922fc) |
| `redeem` — buyer burned cover units for 61% of max claim | [`0xa3fabcc5…76f2d9`](https://gnosis.blockscout.com/tx/0xa3fabcc5580055b4bac50f6e470922202f3bff54f214fcf5e625f19d8176f2d9) |

Recorded observation: `t=1789642464`, `cents=9288`,
`emailId=0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1` (the body hash).

### Historical series 1 — created by the agent (2026-09-19)

The rent-scout agent (`agent/`) priced and opened the current series from live data — strikes
anchored at the DKIM-verified $92.88 print, premium 1133 bps = 9.06% expected claim × 1.25
loading (Bachelier, σ=$1.50/SF·mo), sale open until the observation window starts (production
rule `saleEnd ≤ obsStart`, so the series-0 informed-trading caveat does not apply):

| Step | Tx |
|---|---|
| `approve` + `fundPool(0.5 WXDAI)` — agent capital move, clamped to its 0.5/run limit | [`0xf21216ef…48edd6`](https://gnosis.blockscout.com/tx/0xf21216eff36618c6413c4ab1fce07ae1fac0ecc605a1954a8f65e0fda448edd6) |
| `createSeries($92.88 → $100.88, 1133 bps, cap 0.500335)` — obs Oct 3 – Nov 2, 2026 | [`0xb8731455…4d77c1`](https://gnosis.blockscout.com/tx/0xb8731455cddf8a3114f22d099e45850bc818f584fa75ab5909385a4acf7d77c1) |

And the pay-with-any-token path proven on mainnet (the exact call sequence the app makes):

| Step | Tx |
|---|---|
| Uniswap v3 `exactInputSingle` 0.002 WXDAI → USDC.e (0.01% pool) | [`0x34376179…a57805`](https://gnosis.blockscout.com/tx/0x34376179db1e4e7399cff03bdd423f7e1420b01f232e77f972b4ca2985a57805) |
| Uniswap v3 `exactOutputSingle` USDC.e → exactly the 0.001133 WXDAI premium | [`0x749fd13d…2b2873`](https://gnosis.blockscout.com/tx/0x749fd13d371e3eec1cab94b281fbf5aad3e6a5cc67bc01ed60146070224b2873) |
| `buyProtection(1, 0.01 WXDAI, …)` — cover minted, paid via USDC.e | [`0xa626280b…c467d2e`](https://gnosis.blockscout.com/tx/0xa626280b7f20652b2042f599aebe7387d3812e387d1d6c8a0406bf951c467d2e) |

## Screens

Hash-routed React app in `web/` (works on static hosting), Arbitrum One only:

| Route | What it does |
|---|---|
| `/` | Home: what a policy is, the three roles, the newest policies from both pools, how settlement works, the risks |
| `/policies` | Every policy from both pools (V1 ones badged with the earlier rules) |
| `/policies/new` | Create a V2 policy: page, month (including the current one), when sales close, strikes, premium, escrow |
| `/policies/:id`, `/policies/v1/:id` | A V2 or V1 policy: buy, claim or refund, finalize, and the creator's cancel / pause / add escrow / withdraw |
| `/policies/submit` | Record a month's rent from an original Google Alert `.eml` (parsed locally first), listing matching policies in both pools |
| `/policies/guide` | Step-by-step guide for renters, creators and recorders |

Any other route (including every retired office-market route) redirects to `/`.

## Repository map

| Path | Contents |
|---|---|
| `src/`, `script/`, `test/` | Foundry contracts (`Dkim` library, oracle, pool, token), deploy script, scenario-matrix tests |
| `web/` | Vite + React app (neighborhood policies), `emailkit` DKIM library (`web/src/lib/emailkit.ts`) |
| `scripts/` | Operator scripts (`verify-eml.mjs`, `settle.mjs`, `e2e-mainnet.mjs`, v4 launch tooling) and their office-market ABIs and deployment records in `scripts/data/` |
| `e2e/` | The neighborhood-policy Playwright suite (`e2e/policies`) on an Arbitrum fork |
| `fixtures/` | The verified 2026-09-17 CRE Daily email (raw + canonical goldens + key evidence), test keypair |
| `docs/` | Protocol, verification, operations, testing |
| `.github/` | Etherform CI (build + test + fmt) and network config |

Never commit private keys or `.env` (the deployer key exists only in local env), and never commit
personal-mailbox emails beyond the documented fixture.

## Agent executors (`agent/executors/`)

Pluggable executors that consume the sponsor agent's Plan
(`{ targetFreeCapitalWei, newSeries|null, pause|null, rationale[] }`, produced by
`agent/policy/decide.mjs`):

- **`direct.mjs` — the Gnosis writer** (viem, `DEPLOYER_PRIVATE_KEY`). Reads live state
  (sponsor xDAI/WXDAI, allowance, `freeCapital` = pool balance − `totalReserved()`,
  `salesPaused`), computes the minimal tx diff for the Plan (wrap xDAI if WXDAI is short →
  approve the exact amount if allowance is short → `fundPool`/`withdrawExcess` delta →
  `createSeries` → `setSalesPaused`), simulates every tx before sending, sends sequentially
  with receipt waits + Blockscout links, and aborts the batch on the first failure. Gas
  sanity: it refuses to send unless the sponsor holds the wrap value plus 3× estimated fees.
  `--dry-run` returns the tx list without sending anything.
- **`bankr.mjs` + `v4/bankr.mjs` — advisory and Arbitrum custody.** Real client for the Bankr API (`api.bankr.bot`,
  `X-API-Key: $BANKR_API_KEY`; async `POST /agent/prompt` + polled `GET /agent/job/{id}`)
  and Bankr's LLM Gateway (`llm.bankr.bot`, `$BANKR_LLM_KEY`). **Bankr has NO Gnosis
  support** (its chains: Base, Ethereum, Polygon, Unichain, World Chain, Arbitrum, BNB,
  Robinhood Chain, Arc, Solana and Hyperliquid). The legacy fixed-pool rail and the v4 rail
  have independent execution gates. The live v4 adapter signs the existing bounded quote
  plan through Bankr custody after wallet-identity, simulation, balance, gas, time-window and
  position checks. The settlement-only companion verifies raw DKIM email and cannot trade.
  Without `BANKR_API_KEY` both paths remain read-only/disabled.
- **`index.mjs`** selects executors from the environment and exposes
  `execute(plan, { dryRun })`; also a CLI: `node agent/executors/index.mjs --plan p.json --dry-run`.

Tests: `npm --prefix agent test` covers fixed and v4 planning, custody request construction,
settlement gating and authentic-email preflight; the live identity test self-skips when no
`BANKR_API_KEY` is provisioned. `npm --prefix agent run test:fork` spawns
`anvil --fork-url https://rpc.gnosischain.com`, impersonates the sponsor, and proves every
sponsor lever (wrap → exact approve → `fundPool` → `createSeries` → `setSalesPaused` →
`withdrawExcess`) against the **real forked mainnet contracts** without spending.

### Permissionless creation UI

[Create a policy](https://rentsafe.nyc/#/policies/new) opens a neighborhood policy on the V2 pool. The office-rent factories have no creation page any more; create office series directly against their contracts.
