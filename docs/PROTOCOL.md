# Protocol and trust boundaries

NY Rent Cover sells fully collateralized protection against Manhattan office rent staying high,
settled by an on-chain DKIM verification of a CRE Daily "Market Snapshot" newsletter
(`d=newyork.credaily.com`). There is no committee, no multisig, no trusted server and no price
feed: the settlement input is one authentic email, verified byte-for-byte inside the EVM. There
are also **no roles at all**: anyone underwrites by escrowing capital into a series of their
own, and the only per-series levers belong to that series' creator.

## Settlement statement

### Oracle acceptance (`CredailyRentOracle.submitObservation`)

For a submission `(signedHeaders, canonBody, sig)`, the oracle records an observation if and only
if all of the following hold:

1. `emailId = sha256(canonBody)` has not been recorded before. A replay reverts `AlreadyRecorded`.
2. `signedHeaders` is the relaxed-canonicalized signed header block. It must contain, starting at a
   line boundary, a `from:` line containing `<mail@newyork.credaily.com>`, and it must END with a
   line starting `dkim-signature:` with no trailing CRLF. The trailing DKIM line is the one parsed;
   the contract does not search arbitrary header text.
3. That canonical `dkim-signature:` line parses under a strict tag policy: `v=1`, `a=rsa-sha256`,
   `c=relaxed/relaxed`, `d=newyork.credaily.com`, `s=b37`, the `b=` value emptied, and **no `l=`
   body-length tag**. Duplicate tags revert. Unknown tags are ignored.
4. The signed body hash agrees with the submitted body: `tags.bh == base64(sha256(canonBody))`
   (44-character base64 comparison).
5. The signed issuance time `t=` parses and satisfies `t <= block.timestamp + 1 days`. A message
   "from the future" is rejected; historical authentic messages remain submittable.
6. `sha256(signedHeaders)` RSA-verifies (RSASSA-PKCS1-v1_5, SHA-256 DigestInfo, strict
   `00 01 FF×205 00` padding for the 2048-bit layout, `e = 65537`) against the **immutable pinned
   modulus** (`keccak256(modulus) = 0x2f2f9938845a16a65bb4651356bc7d160fca499a50aea0c158b2b766c6b84a41`).
   Any padding deviation is rejected. Else `BadSignature`.
7. Value extraction succeeds on the raw canonical body with on-the-fly quoted-printable decoding:
   the anchor `Manhattan Office Rent` occurs **exactly once** in the decoded stream; within ≤600
   decoded bytes after it appears `Avg Effective`; within ≤600 more appears `$`, optional spaces,
   digits, `.`, exactly two digits (→ cents, `0 < cents < 2^31`), optional spaces, then `/ SF`.
   Two anchors (`AnchorNotUnique`), a missing pattern, or an out-of-range value reject the email.

A passing submission appends `Observation{ t, cents, emailId }` to an append-only array and emits
`ObservationRecorded(index, t, cents, emailId, msg.sender)`. Submission is **permissionless**:
anyone holding any authentic snapshot email may record it. `msg.sender` earns nothing and selects
nothing; it only pays gas.

### Series settlement (`CoverPool.settle`)

8. A series settles against oracle observation `obsIndex` if the series is unsettled and
   `obsStart <= obs.t <= obsEnd` (the *signed email time*, not the submission time, is windowed).
9. The payout ratio is `clamp((cents − strikeLowCents) × 1e18 / (strikeHighCents − strikeLowCents), 0, 1e18)`,
   stored once with the observation's `t` and `emailId` for provenance.
10. Settlement is **one-shot**: if multiple observations fall inside the window, the FIRST
    successful `settle` call wins and no later call can change the ratio. Buyers and series
    creators who care about which qualifying email settles the series must race to call
    `settle`; both roles are permissionless callers.

### Redemption and per-series escrow (`CoverPool.redeem`, creator accounting)

11. `redeem(seriesId, amount)` requires the series settled and `block.timestamp <= redeemEnd`;
    it burns `amount` cover units (1 unit = 1 currency-wei of max claim) and pays
    `amount × ratio / 1e18` in the pool currency, **out of that series' own escrow**. The
    per-series pause never blocks redeem.
12. Accounting is strictly per series — there is no shared pot. Each series tracks `escrow`
    (the creator's capital, equal to the max sellable claim), `sold`, `premiumsAccrued`,
    `paidOut` and `withdrawn`. Conservation invariant: at all times
    `Σ over series of (escrow + premiumsAccrued − paidOut − withdrawn) == currency.balanceOf(pool)`
    (donations can only push the balance above the sum). Per-series solvency holds by
    construction: issuance requires `sold + maxClaim ≤ escrow` (every unit backed 1:1 at
    purchase time), and `paidOut ≤ sold × ratio ≤ escrow`.
13. Series terms are immutable after creation — no setter exists at all. The creator's only
    levers, each confined to its own series and none able to touch sold cover's backing:
    `setSeriesPaused` (sales only), `addCapacity` (more escrow, only before `saleEnd` and
    only while unsettled — a settled series can never sell again, so a top-up would be
    dead money), `cancelSeries` (full escrow refund, only while `sold == 0` and unsettled;
    permanently closes the series and zeroes its escrow) and `withdrawResidual` (one-shot,
    only after `redeemEnd` and never on a cancelled series:
    `escrow − paidOut + premiumsAccrued − anything already withdrawn`). The two exits are
    **strictly mutually exclusive**: they share a one-shot latch consumed in both
    directions, so whichever runs first permanently blocks the other and the creator's
    capital can leave the series exactly once. There is no global pause, no fee sink, no
    upgrade path and no admin over the oracle.
14. **Unsettled series.** A series with no qualifying settlement pays no claims at all —
    `redeem` requires settlement — and once `redeemEnd` passes the full escrow plus premiums
    return to the creator via `withdrawResidual`. `settle` itself has no deadline (only the
    observation's signed `t` is windowed), but a settlement landing after `redeemEnd` cannot
    reopen redemption: buyers' claims expire worthless at `redeemEnd` either way.

Cover tokens are ERC-1155 positions (`id = seriesId`) minted only by the pool; transfers revert
`TransfersDisabled` (demo rule, see PRD) so positions stay with their buyer until burn.

## Roles and trust: permissionless underwriting

**There is no sponsor, no owner, no operator.** `createSeries` is callable by anyone and pulls
the full `capacity` from the caller into the contract as that series' escrow; the caller is
recorded as the series **creator**. Underwriting is therefore trustless in the only direction
that matters to a buyer: the capital backing a claim is already inside the contract before a
single unit can be sold, and nothing the creator can do afterwards reaches it.

**Creator rights (all scoped to the creator's own series):**

- `setSeriesPaused` — stops NEW sales of that series only; never blocks settle or redeem.
- `addCapacity` — escrows more capital 1:1, raising the sellable claim; only before `saleEnd`
  and only while the series is unsettled.
- `cancelSeries` — refunds the full escrow, zeroes it, and permanently closes the series;
  only while nothing has been sold and nothing has settled. Once one unit is sold, the
  backing is locked until `redeemEnd`.
- `withdrawResidual` — one-shot, only after `redeemEnd`: whatever the claim window left behind
  (`escrow − paidOut + premiumsAccrued`).

`cancelSeries` and `withdrawResidual` are strictly mutually exclusive (rule 13): each
consumes the same one-shot latch, in either order, so no sequence of the two can ever pay
the creator twice.

**Buyer guarantees, unchanged from the sponsor era:** every claim unit is backed 1:1 by escrow
at the moment of purchase; the premium is bounded by the buyer's own `maxPremium`; settlement
is permissionless against the pinned-key oracle; redemption until `redeemEnd` can never be
paused, and pays out of an escrow no creator lever can touch while claims are live.

**The informed-trading rule is now a contract invariant — with one precisely bounded
residual.** `createSeries` reverts unless `saleEnd ≤ obsStart` (with all timestamps in the
future, ordered `saleEnd ≤ obsStart < obsEnd < redeemEnd`, and a minimum claim window
`redeemEnd ≥ obsEnd + 7 days`, `CoverPool.MIN_REDEEM_WINDOW`): sales close no later than the
moment the observation window opens. The old PROTOCOL text carried this as a production
*recommendation* with a documented demo-series caveat; the chain now enforces the rule.

The precise guarantee is narrower than "no qualifying observation can exist while sales are
open", because the oracle accepts a signed `t` up to **one day in the future** of block time
(acceptance rule 5). So whenever `obsStart − saleEnd < 1 day` — including the common
`saleEnd == obsStart` configuration — an observation whose `t` lies inside
`[obsStart, obsEnd]` can already be recorded on-chain during the final
`1 day − (obsStart − saleEnd)` of the sale, and purchases stay open until someone calls
`settle` (a settled series rejects all buys). What the chain guarantees exactly: **while
sales are open, no qualifying observation with an honest signed time — one at least
`obsStart − saleEnd` short of a day old relative to block time — can exist.** Exploiting the
residual requires either the trusted mailer (CRE Daily / SendGrid) to future-date the DKIM
`t=` tag — inside the already-documented SendGrid trust boundary — or a same-second boundary
race at `block.timestamp == saleEnd == obsStart == t`. Anyone can close the residual window
immediately by calling `settle` on the recorded observation (a settle-fast keeper makes this
routine), and production series that want the retirement to be absolute should simply set
`obsStart ≥ saleEnd + 1 day`.

**Soulbound rationale, unchanged:** the `recipient` of `buyProtectionFor` is a mint destination
only. Cover cannot change hands after minting and only the recipient can redeem, so cover
cannot be resold to someone with better information mid-window (see also
[UNISWAP.md](UNISWAP.md) on why claim units are never pooled).

## Market structure

Anyone underwrites, and buyers pick any series: two creators can run competing series over the
same observation window with different strikes, premium rates and capacities, and the contract
holds each to the same 1:1 escrow rule — price competition without shared-pot contagion. The
reference rent-scout agent (`agent/`) is just one such underwriter with no special powers: it
prices standard monthly series from live data (CRE Daily archive, Kalshi, the on-chain oracle),
escrows its own capital through the same `createSeries` everyone else calls, and — where an
existing series is mispriced against its model — buys that cover instead of underwriting,
arbitraging bad quotes rather than letting them set the market. Architecture and policy
constants: [`agent/README.md`](../agent/README.md).

## Why direct on-chain DKIM instead of issue.fund's Groth16 circuit

This protocol mirrors `ronturetzky/issue.fund`'s discipline exactly — immutable pinned key, strict
template policy parsed in Solidity, no trusted server, timestamp windows, `l=` rejected, one-shot
settlement, local preflight in the app — but replaces its Groth16 proof layer with **direct
on-chain verification** of the RSA signature, body hash and template. Reasons:

- **Body size.** issue.fund's circuit pins the body SHA-256 from the standard IV with a ~4 KB
  maximum canonical body. The CRE Daily newsletter body is 102,197 canonical bytes — far beyond
  any feasible circuit of that construction.
- **No privacy requirement.** issue.fund hides the private parts of a personal notification email.
  A mass-distributed newsletter has no secrets worth a ZK layer; the only personal field, the
  signed `to:` recipient (a throwaway address, `ron.t1234@gmail.com`), is documented and accepted
  as public at settlement.
- **Cheap calldata venue.** On Gnosis, submitting ~104 KB of calldata plus SHA-256/modexp work is
  a few million gas (measured in `RealEmail.t.sol` with `--gas-report`), which is cents — an
  acceptable one-time cost per recorded email.

What is *lost* relative to the circuit approach: nothing cryptographic. The same RSA-SHA256
signature over the same relaxed-canonicalized bytes is checked; the check simply happens in the
EVM where anyone can re-execute it, instead of inside a proof whose soundness also depends on a
ceremony. The trusted-setup assumption disappears entirely.

## What is trusted

**CRE Daily / CompStak and the template.** The DKIM key authenticates that CRE Daily's mailer sent
these bytes; it does not make the rent figure true. CRE Daily's editorial pipeline and CompStak's
underlying data decide the number. The exact snapshot template (`Manhattan Office Rent` /
`Avg Effective` / `$NN.NN / SF`) is a security boundary: parsing is deliberately narrow and fails
closed.

**SendGrid key custody for the `d=newyork.credaily.com` domain.** The selector
`b37._domainkey.newyork.credaily.com` is a CNAME into SendGrid (`u58081633.wl134.sendgrid.net`).
Whoever can sign with that key — CRE Daily's ESP account, or SendGrid itself — can mint an email
the oracle accepts, including one with a fabricated rent figure that matches the template. This is
the protocol's strongest trust assumption. Buyers and series creators accept CRE Daily +
SendGrid operational security as the oracle's authority.

**DNS at pin time.** The modulus was pinned after retrieving the DNS TXT record and verifying a
delivered message against it locally and via Gmail's `dkim=pass` (see
[VERIFICATION.md](VERIFICATION.md)). After deployment DNS is irrelevant to settlement: a malicious
resolver answer cannot change the immutable pinned key, only inconvenience local preflight.

**The contracts.** Solidity implementations of RSA-PKCS#1 v1.5 (via the modexp precompile),
relaxed-canonicalization policy, quoted-printable decoding and the pool's per-series escrow
accounting. They are unaudited; the test suite ([TESTING.md](TESTING.md)) is the current
evidence.

**The pool currency is a standard ERC-20.** Escrow, premium and payout accounting assumes
the currency transfers exactly the requested amount: no fee-on-transfer, no rebasing, no
state-changing transfer hooks (reentry is blocked contract-wide either way). A deviating
token would record more escrow/premium than the pool actually received, and the shortfall
would bleed across series until the last withdrawer reverts. The currency is immutable and
fixed at deploy time — WXDAI on Gnosis, native USDC on Arbitrum — both of which comply; no
other currency can ever be attached to a deployed pool.

**The local application.** The web app and `scripts/settle.mjs` only *prepare* transactions and
run a preflight of the identical checks. They hold no key and no privileged role; a dishonest
frontend cannot make an invalid email pass the contract, though it could mislead its own user.
Run reviewed local code and inspect wallet transactions.

## Explicit limitations

- **Template drift breaks settlement.** If CRE Daily reformats the snapshot block (renames the
  metric, changes `$/SF` layout, splits the anchor), new emails stop parsing and the oracle
  records nothing. Open series then expire with no qualifying observation in the window — each
  creator's escrow plus premiums release after `redeemEnd` via `withdrawResidual` and buyers'
  premiums are not returned. Buying protection includes this failure mode. A new template
  requires a reviewed new deployment.
- **Key rotation strands future emails.** The modulus is immutable. If SendGrid rotates the `b37`
  key, emails signed with the new key are unverifiable by this oracle forever. The re-pin path is
  a **new oracle deployment** (and new pool series pointing at it); the old deployment keeps its
  recorded history. There is no key registry, no rotation admin, no revocation.
- **One newsletter, monthly-ish cadence.** Settlement can only happen when an authentic snapshot
  email whose signed `t` falls inside `[obsStart, obsEnd]` exists. No email in the window means no
  settlement, ratio never set, and the series escrow releases to its creator after `redeemEnd`
  (rule 14).
- **First-qualifying-email-wins.** Rule 10 means when two different snapshot emails both fall in
  the window with different values, whichever `settle` lands first fixes the ratio. Windows should
  be sized so this ambiguity is unlikely (one issue per window).
- **Series quality is caveat emptor.** Underwriting is permissionless: anyone can open a series
  with unattractive strikes, an excessive premium rate (capped at 100%), or a strange window.
  The contract guarantees only collateralization and mechanics — 1:1 escrow backing,
  `saleEnd ≤ obsStart` (enforced on-chain since Option B; see the informed-trading section for
  the precise guarantee and the one-day oracle-tolerance residual), a claim window of at least
  7 days past `obsEnd` (`MIN_REDEEM_WINDOW`, so redemption can never be made near-impossible by
  construction), immutable terms — never that a series is fairly priced. Read the terms;
  compare series; the reference agent's quotes are one benchmark, not an endorsement.
- **A purchase binds the series id, not the terms.** `buyProtectionFor` pins `seriesId` and
  `maxPremium` only — not the strikes, windows or creator behind that id. Ids are append-only
  (`seriesId == seriesCount()` at creation), so this only matters to a buyer acting on an
  UNCONFIRMED `SeriesCreated` event: a racing `createSeries` (or a reorg) can change which
  series id N resolves to, including one with the same premium rate but hostile strikes.
  `maxPremium` bounds the price paid either way; the reference app resolves the id and
  simulates the purchase against it before sending. Buy against confirmed events. The 4-arg
  signature stays frozen — the [SwapAndBuyRouter](UNISWAP.md) pins it — so the hardening here
  is operational, not a contract change.
- **Recipient disclosure.** The signed `to:` header (`ron.t1234@gmail.com`, a throwaway) becomes
  public calldata at settlement. Anyone replicating this system with a personal mailbox should use
  a dedicated address.
- **Index semantics.** The figure is CRE Daily's *Manhattan office average effective rent* per
  square foot (CompStak data, commercial office — not residential apartment rent), rounded to
  cents. The protocol pays on the printed number, including any upstream revision or error.
