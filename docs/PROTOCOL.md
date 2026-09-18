# Protocol and trust boundaries

NY Rent Cover sells fully collateralized protection against Manhattan office rent staying high,
settled by an on-chain DKIM verification of a CRE Daily "Market Snapshot" newsletter
(`d=newyork.credaily.com`). There is no committee, no multisig, no trusted server and no price
feed: the settlement input is one authentic email, verified byte-for-byte inside the EVM.

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
    successful `settle` call wins and no later call can change the ratio. Buyers and sponsors who
    care about which qualifying email settles the series must race to call `settle`; both roles
    are permissionless callers.

### Redemption and reserves (`CoverPool.redeem`, sponsor accounting)

11. `redeem(seriesId, amount)` requires the series settled and `block.timestamp <= redeemEnd`;
    it burns `amount` cover units (1 unit = 1 currency-wei of max claim) and pays
    `amount × ratio / 1e18` in the pool currency (WXDAI). **Pause never blocks redeem.**
12. Solvency invariant: at all times `Σ reservedOf(series) <= currency.balanceOf(pool)`, where
    reserved is `sold` before settlement, `sold × ratio − redeemed` after settlement until
    `redeemEnd`, and `0` after `redeemEnd`. `buyProtection` reverts rather than let issuance break
    the bound; `withdrawExcess` can only take `freeCapital = balance − Σ reserved`.
13. Series terms are immutable after creation — no setter exists at all. The sponsor's only powers
    are `createSeries`, pause/unpause of **sales**, `fundPool` and `withdrawExcess`. There is no
    fee sink, no upgrade path and no admin over the oracle.

Cover tokens are ERC-1155 positions (`id = seriesId`) minted only by the pool; transfers revert
`TransfersDisabled` (demo rule, see PRD) so positions stay with their buyer until burn.

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
the protocol's strongest trust assumption. Buyers and sponsors accept CRE Daily + SendGrid
operational security as the oracle's authority.

**DNS at pin time.** The modulus was pinned after retrieving the DNS TXT record and verifying a
delivered message against it locally and via Gmail's `dkim=pass` (see
[VERIFICATION.md](VERIFICATION.md)). After deployment DNS is irrelevant to settlement: a malicious
resolver answer cannot change the immutable pinned key, only inconvenience local preflight.

**The contracts.** Solidity implementations of RSA-PKCS#1 v1.5 (via the modexp precompile),
relaxed-canonicalization policy, quoted-printable decoding and the pool's reserve accounting. They
are unaudited; the test suite ([TESTING.md](TESTING.md)) is the current evidence.

**The local application.** The web app and `scripts/settle.mjs` only *prepare* transactions and
run a preflight of the identical checks. They hold no key and no privileged role; a dishonest
frontend cannot make an invalid email pass the contract, though it could mislead its own user.
Run reviewed local code and inspect wallet transactions.

## Explicit limitations

- **Template drift breaks settlement.** If CRE Daily reformats the snapshot block (renames the
  metric, changes `$/SF` layout, splits the anchor), new emails stop parsing and the oracle
  records nothing. Open series then expire with no qualifying observation in the window — the
  sponsor's collateral releases after `redeemEnd` and buyers' premiums are not returned. Buying
  protection includes this failure mode. A new template requires a reviewed new deployment.
- **Key rotation strands future emails.** The modulus is immutable. If SendGrid rotates the `b37`
  key, emails signed with the new key are unverifiable by this oracle forever. The re-pin path is
  a **new oracle deployment** (and new pool series pointing at it); the old deployment keeps its
  recorded history. There is no key registry, no rotation admin, no revocation.
- **One newsletter, monthly-ish cadence.** Settlement can only happen when an authentic snapshot
  email whose signed `t` falls inside `[obsStart, obsEnd]` exists. No email in the window means no
  settlement, ratio never set, and reserves release after `redeemEnd`.
- **First-qualifying-email-wins.** Rule 10 means when two different snapshot emails both fall in
  the window with different values, whichever `settle` lands first fixes the ratio. Windows should
  be sized so this ambiguity is unlikely (one issue per window).
- **Informed trading in the demo series.** Production rule is `saleEnd <= obsStart` so nobody buys
  after the outcome email may already exist. The demo series intentionally sells during the
  observation window (`saleEnd = obsEnd`); a buyer who has seen the 2026-09-17 email can buy at a
  premium that no longer reflects uncertainty. Documented, accepted for the demo only.
- **Recipient disclosure.** The signed `to:` header (`ron.t1234@gmail.com`, a throwaway) becomes
  public calldata at settlement. Anyone replicating this system with a personal mailbox should use
  a dedicated address.
- **Index semantics.** The figure is CRE Daily's *Manhattan office average effective rent* per
  square foot (CompStak data, commercial office — not residential apartment rent), rounded to
  cents. The protocol pays on the printed number, including any upstream revision or error.
