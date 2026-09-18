# NY Rent Cover — Build Specification (pinned)

Fully collateralized Manhattan office-rent protection on Gnosis Chain (chainId 100), settled by an
on-chain DKIM-verified CRE Daily "Market Snapshot" email. This file is the contract between build
agents — interfaces here are FROZEN; deviations require a written reason in the final report.

Product implements the "Tokenized Insurance RWA Strategy and MVP PRD" (Option 2: protection token),
with the reference index changed to **CRE Daily · Manhattan Office Rent · Avg Effective $/SF**
(source newsletter: CompStak data), because that is the only authenticated email feed we have.

## 0. Ground truth (verified locally, fixtures in `fixtures/credaily-2026-09-17/`)

- Raw email `credaily-cpace-2026-09-17.eml` (110,429 B, CRLF, sha256 `1a280566…b2ba`).
- DKIM: `d=newyork.credaily.com; s=b37; a=rsa-sha256; c=relaxed/relaxed; t=1789642464`; no `l=` tag.
- `signed-headers.bin` (1,378 B) = relaxed-canonicalized signed header block, RFC 6376 h= consumption
  (LAST unused instance first; oversigned names consume nothing), terminated by the canonical
  `dkim-signature:` line with `b=` emptied, no trailing CRLF. sha256 of this block RSA-verifies
  (PKCS#1 v1.5, SHA-256 DigestInfo) against the 2048-bit modulus in `meta.json` (e=65537). VERIFIED.
- `canon-body.bin` (102,197 B) = relaxed-canonicalized body; sha256 == bh `XO8VsgH6…5SOE=`. VERIFIED.
- Value extraction from the quoted-printable HTML body: anchor `Manhattan Office Rent` occurs exactly
  once (raw canon offset 43,411); pattern `Manhattan Office Rent … Avg Effective … $92.88 / SF`
  (≤600 decoded bytes between tokens). Extracted value 92.88 → **9288 cents**. VERIFIED.
- The recipient address in the signed `to:` header (ron.t1234@gmail.com, a throwaway) becomes public
  on-chain at settlement. Documented, accepted.

## 1. Why direct on-chain DKIM instead of issue.fund's Groth16 circuit

We mirror `ronturetzky/issue.fund`'s PROTOCOL discipline exactly (immutable pinned key, strict
template policy parsed in Solidity, no trusted server, timestamp windows, reject `l=`, one-shot
settlement, local preflight in the app). We replace its Groth16 layer with direct on-chain
verification because issue.fund's circuit pins body SHA from the standard IV with a 4,096-byte max
body — this email's body is 102 KB, far beyond any feasible circuit — and the newsletter needs no
privacy. Gnosis calldata makes the direct path cheap (~3.5–5.5M gas per settlement). Document this
divergence in docs/PROTOCOL.md.

## 2. Contracts (Foundry, solc 0.8.26, optimizer 200, OZ v5)

### 2.1 `src/lib/Dkim.sol` — pure library
- `rsaVerify(bytes calldata sig256, bytes32 digest, bytes memory modulus256) → bool`
  modexp precompile (0x05) with e=65537; strict PKCS#1 v1.5: `00 01 FF×205 00 <19-byte SHA-256
  DigestInfo> <32-byte digest>`; constant layout for 2048-bit; reject any deviation.
- `parseDkimTags(bytes calldata dkimLine)` → struct { d, s, a, c, v, bhB64, t, hasL, bEmpty } —
  operates on the canonical (lowercase-name, single-spaced) `dkim-signature:` line; tags split on
  `;`, trimmed; unknown tags ignored; duplicate tags revert.
- `base64Encode32(bytes32) → string` (44 chars incl. padding) for bh comparison.
- `extractSnapshot(bytes calldata body) → (uint256 cents, uint256 anchorCount)` — single left-to-
  right pass over the RAW canonical body implementing on-the-fly quoted-printable decoding:
  `=\r\n` → skip (soft break), `=HH` → byte, else literal. On the DECODED stream: count occurrences
  of `Manhattan Office Rent`; after the FIRST occurrence, within ≤600 decoded bytes find
  `Avg Effective`, then within ≤600 more find `$`, optional spaces, then digits `.` two digits →
  cents (value < 2^31), then optional spaces, then `/ SF` (single internal space; the canonical body
  has collapsed whitespace). Continue the pass to the end so anchorCount is total. Solidity, no
  assembly unless a hot loop demonstrably needs it; target < 3M gas for the 102 KB fixture
  (measure in tests with `--gas-report`).

### 2.2 `src/CredailyRentOracle.sol`
Ownerless once deployed. Constructor: `bytes modulus` (256 B, stored), pins
`MODULUS_HASH = keccak256(modulus)` and constants `DOMAIN="newyork.credaily.com"`, `SELECTOR="b37"`.
- `submitObservation(bytes calldata signedHeaders, bytes calldata canonBody, bytes calldata sig)`:
  1. `bh32 = sha256(canonBody)`; `emailId = bh32`; revert `AlreadyRecorded` if seen.
  2. signedHeaders must contain, at a line boundary, `from:` whose line contains
     `<mail@newyork.credaily.com>`; must END with a line starting `dkim-signature:` (no trailing
     CRLF). Extract that trailing line; `parseDkimTags`: require v=1, a=rsa-sha256,
     c=relaxed/relaxed, d=DOMAIN, s=SELECTOR, !hasL, bEmpty; `tags.bhB64 == base64Encode32(bh32)`;
     `t` parses, `t <= block.timestamp + 1 days`.
  3. `rsaVerify(sig, sha256(signedHeaders), modulus)` — else `BadSignature`.
  4. `(cents, anchors) = extractSnapshot(canonBody)`; require `anchors == 1`, `cents > 0`.
  5. Store `Observation{ uint64 t, uint32 cents, bytes32 emailId }`, append to array; emit
     `ObservationRecorded(index, t, cents, emailId, msg.sender)`.
- Views: `observationCount()`, `observations(uint256)`, `modulus()`.
Anyone may submit any authentic snapshot email; recording is append-only and permissionless.

### 2.3 `src/CoverToken.sol`
ERC-1155 (OZ), `id = seriesId`, amounts are WAD claim units (1e18 units = 1 currency-wei of max
claim × 1e18 / 1e18 — see 2.4; simply: `amount` = max-claim in currency wei). mint/burn only by the
immutable `pool`; `safeTransferFrom`/batch revert `TransfersDisabled` (PRD demo rule). URI returns a
data:application/json base64 with series name.

### 2.4 `src/CoverPool.sol`
Currency: immutable `IERC20 currency` (deploy with WXDAI `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d`
— agent MUST verify symbol()/decimals() by RPC before pinning in the deploy script). Token amounts:
1 token unit = 1 wei of currency max claim (quantity minted == maxClaim in wei).
Roles: immutable `sponsor` (deployer for MVP) = admin: createSeries, pause/unpause sales, fund,
withdrawExcess. Nothing else privileged; settle/redeem permissionless. No upgradeability.

```solidity
struct Series {
  uint32 strikeLowCents;   // payout 0 at/below     (demo: 8800)
  uint32 strikeHighCents;  // payout 1 at/above     (demo: 9600)
  uint16 premiumRateBps;   // premium per 1e4 of max claim (demo: 2850)
  uint64 saleEnd;          // no purchases after
  uint64 obsStart;         // observation window [obsStart, obsEnd]
  uint64 obsEnd;
  uint64 redeemEnd;        // = obsEnd + claim window (create param); after: reserves release
  uint128 capacity;        // max total max-claim (currency wei)
  uint128 sold;            // total max-claim sold
  bool    settled;
  uint64  payoutRatioWad;  // ratio in 1e18, set once
  uint64  observationT;    // provenance
  bytes32 emailId;
}
```
- `fundPool(uint256 amt)` sponsor; `withdrawExcess(uint256 amt)` sponsor, only from
  `freeCapital() = balance − Σ reservedOf(series)` where reserved = `sold` before settlement,
  `sold × ratio − redeemed` after settlement until `redeemEnd`, `0` after `redeemEnd`.
- `createSeries(params)` sponsor: validate lowCents < highCents, saleEnd ≤ obsEnd, obsStart < obsEnd
  < redeemEnd, capacity > 0. (Production rule saleEnd ≤ obsStart is a DOCUMENTED recommendation;
  the demo series intentionally sells during the window — note the informed-trading caveat.)
- `quote(seriesId, maxClaim) → (premium, components…)` view; premium = maxClaim × premiumRateBps /1e4.
- `buyProtection(seriesId, maxClaim, maxPremium)`: sale open, not paused, `sold+maxClaim ≤ capacity`,
  **solvency**: `sold+maxClaim ≤ freeCapital-adjusted capacity` — issuance must keep
  `Σ reserved ≤ balance` after collecting premium; pulls premium (SafeERC20), mints token.
- `settle(seriesId, obsIndex)`: !settled, observation from oracle with
  `obsStart ≤ obs.t ≤ obsEnd`; ratio = clamp((cents−low)×1e18/(high−low), 0, 1e18); store; emit.
  If multiple observations qualify, FIRST call wins (one-shot; document).
- `redeem(seriesId, amount)`: settled, `block.timestamp ≤ redeemEnd`, burn, pay
  `amount × ratio / 1e18`. Claims always payable while reserved (pause never blocks redeem).
- Invariants (mirror PRD): solvency, immutability after first sale (no setter exists at all),
  settle-once, redemption priority, no fee sink.

### 2.5 `script/Deploy.s.sol`
Reads modulus from `fixtures/credaily-2026-09-17/meta.json` via `vm.readFile`+`vm.parseJson…` (or a
generated Solidity constant — generate `src/gen/CredailyKey.sol` from meta.json by script; prefer
the generated-constant approach so the deploy has zero file deps). Deploys Oracle → CoverToken+
CoverPool (CREATE-address precompute for the circular immutable, as in nyc-rent-index/script) →
`createSeries` demo: strikes 8800/9600, premium 2850 bps, saleEnd = obsEnd = 2026-09-30 23:59 UTC,
obsStart = 2026-09-01, redeemEnd = obsEnd + 90 days, capacity 0.02 WXDAI (tiny; deployer is
near-broke). Post-deploy asserts. Etherform-compatible broadcast output.

## 3. `emailkit` — shared TS library (`web/src/lib/emailkit.ts`, no deps beyond WebCrypto)
Port of the verified python: parse .eml (CRLF or LF tolerated → normalize CRLF), unfold headers,
select the `dkim-signature` header whose `d=` equals `newyork.credaily.com`, relaxed body & header
canonicalization, h= consumption (last-unused-first), b=-emptied trailing dkim line, base64 sig →
`{ signedHeaders: Uint8Array, canonBody: Uint8Array, sig: Uint8Array, tags, valuePreview,
anchorCount, bh }` + `preflight()` running: bh match, RSA verify via WebCrypto
(`RSASSA-PKCS1-v1_5` importKey spki from the DNS/pinned modulus), tag policy, extraction — returns a
checklist of named checks {id, label, pass, detail} the UI renders. Node test runner
(`node --test`) tests against fixtures: golden equality of the three .bin files, value 9288,
tamper cases (flip byte in body/header/sig → precise failing check).
Also `scripts/settle.mjs` (Node + viem): reads an .eml + deployment.json + env key → calls
`submitObservation` then `settle`; and `scripts/e2e-mainnet.mjs` running the entire lifecycle.

## 4. Frontend (`web/`, Vite + React + TS)
- Deps: wagmi v2, viem v2, @rainbow-me/rainbowkit v2 (injected-only default connectors — must work
  with NO WalletConnect projectId), @tanstack/react-query, @phosphor-icons/react, tailwindcss v4
  with `@decentralpark/ui/tailwind-preset`, `@decentralpark/ui/theme` + `/fonts` CSS.
- Install `@decentralpark/ui` per its AGENTS.md/README (git dep or vendored `npm pack` from
  `.context/ref/decentralpark-ui-kit` — the clone lives at
  `/Users/wk/conductor/workspaces/research/seville-v2/.context/ref/decentralpark-ui-kit`; vendor the
  packed tarball into `web/vendor/` so builds are hermetic).
- Brand: Decentral Park logo/navbar/footer/typography/LiftedButton/Chip from the kit. App name
  "NY Rent Cover".
- Routes (react-router, hash router so GitHub Pages works): `/` landing with a
  **crowdstake.fun-style "How it works"** — study https://crowdstake.fun/#how-it-works (fetch the
  page + its JS) and reproduce the *mechanics* of its visualization (stepper with animated
  SVG flows of value between actors, advancing on click/scroll, smooth transitions) with our five
  steps (Sponsor funds → Buyer pays premium & mints → Email arrives → On-chain DKIM settlement →
  Redeem). Hand-rolled SVG + CSS/JS animation, brand colors, no heavy animation lib (framer-motion
  allowed if it keeps bundle sane).
  `/series` list + `/series/:id` detail (state timeline like SPEC lifecycle, capacity/solvency
  bars, payout-curve SVG with strikes and, once settled, the settled point), `/buy/:id`,
  `/settle/:id` (drag-drop .eml → emailkit preflight checklist with per-check pass/fail UI →
  two txs: submitObservation, settle — handle "observation already recorded" by skipping to
  settle), `/redeem/:id`, `/sponsor` (fund/withdraw, only meaningful for sponsor wallet, still
  viewable read-only), `/docs` link.
- UX/failure handling (explicit acceptance): wrong network → RainbowKit chain switch prompt to
  Gnosis; every tx has pending/confirmed/reverted states with decoded custom errors mapped to
  human copy (viem `decodeErrorResult` with our ABI); preflight failures show WHICH DKIM check
  failed and why; file that isn't an email → friendly error; empty/loading/zero-state for every
  list; amounts validated client-side (> balance, > capacity, > maxPremium slippage); all reads via
  wagmi hooks with refetch on block. No mocks: all data from chain + real .eml parsing. The ONLY
  simulated thing anywhere: none in the app. (Emails themselves can't be generated on demand —
  that's the user-accepted constraint, not a mock.)
- `web/src/deployment.json`: `{ chainId, oracle, pool, token, currency, seriesIds }` — written by
  deploy tooling; app reads at build time.

## 5. Docs
- `docs/PROTOCOL.md` — modeled on issue.fund's: settlement statement (numbered acceptance rules),
  what is trusted (CRE Daily/CompStak data + template, SendGrid key custody for d=newyork domain,
  DNS at pin time, the contracts), explicit limitations (template drift breaks parsing → new
  deployment; key rotation strands future emails → document re-pin path = new oracle deployment),
  divergence-from-issue.fund section (§1 above).
- `docs/VERIFICATION.md` — evidence chain for the pinned key (DNS record, fingerprint, Gmail
  dkim=pass, local verify script `scripts/verify-eml.mjs` anyone can run against the fixture).
- `docs/OPERATIONS.md` — deploy runbook (env, forge script, etherform CI path, Blockscout verify),
  settlement runbook (getting an .eml out of Gmail, running the app or settle.mjs).
- `docs/TESTING.md` — the scenario matrix and how to run each suite.
- `docs-site/index.html` — single-file branded docs site (Decentral Park palette per ui-kit
  theme.css tokens) rendering: how it works, the settlement rules, contract addresses (reads
  deployment.json), links to md docs, payout-curve visual. Static, no build step.
- `README.md` — top-level: what/why/quickstart/addresses/screens.

## 6. CI (etherform)
`.github/workflows/cicd.yml` calling `BreadchainCoop/etherform/.github/workflows/_foundry-cicd.yml@main`
per its README minimum setup (build+test+fmt); `.github/deploy-networks.json` with gnosis
(chainId 100, rpc, blockscout `https://gnosis.blockscout.com`). Do not enable testnet-deploy-on-PR.

## 7. Tests — the scenario matrix ("test all scenarios")
Foundry (`test/`):
- `RealEmail.t.sol`: fixture bytes via `vm.readFileBinary`; submitObservation succeeds → t/cents/
  emailId exact; settle demo-series → ratio 0.61e18; buy → redeem pays 61%; sponsor withdraw math;
  gas report for settlement documented.
- `TamperEmail.t.sol`: body byte flip (BadBodyHash), header byte flip (BadSignature), sig flip,
  truncated body, wrong d=/s= (craft with TEST KEYPAIR), l= present, b= non-empty, missing from:,
  future t, replay (AlreadyRecorded), second-anchor body → AnchorNotUnique, value overflow digits.
  Use a generated test RSA-2048 keypair (`fixtures/testkey/`, private key committed AND clearly
  labeled test-only) + a JS generator `scripts/make-synthetic-eml.mjs` producing synthetic signed
  emails for every negative/positive branch; golden synthetic fixtures checked in so forge tests
  need no ffi.
- `CoverPool.t.sol` + fuzz + invariants: solvency under random fund/buy/settle/redeem/withdraw
  sequences; pause never blocks redeem; capacity and slippage bounds; redeemEnd release; settle
  window edges (t == obsStart, == obsEnd, ±1); clamp edges (cents == low, == high, below, above).
JS (`node --test`): emailkit goldens + tampers (§3).
Playwright (`e2e/`): against `anvil` + local deploy + `vite build && preview`: journey test
(connect injected test wallet via a lightweight EIP-1193 shim, fund, buy, settle by uploading the
real .eml, redeem), failure tests (tampered .eml shows failing check; buy over capacity disabled;
wrong-network banner). Mirror issue.fund's playwright setup style.

## 8. Deployment (performed by the operator, not agents)
Deployer `0x6636A1CCBdf54485067304C1a590DE016DeaD9F0` (key via env only — NEVER in the repo).
Currency WXDAI; tiny demo capacity. Ordering: Deploy.s.sol → run `scripts/e2e-mainnet.mjs`
(fund 0.002, buy 0.001 max-claim, submitObservation with the real email, settle, redeem) →
write `web/src/deployment.json` + docs addresses → Blockscout verification.
Balance note: deployer currently holds ~0.00102 xDAI; full deploy+lifecycle is estimated
0.015–0.03 xDAI — measure with `forge script --rpc-url … ` estimate and REPORT the exact shortfall
rather than partially deploying.
