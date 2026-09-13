# Rent Ledger — signed-email rent feed

**Current work: actual archive wording + pinned DKIM keys.** Run `npm run archives` and open **http://127.0.0.1:8766/archives.html**. The new parser tests fourteen real archive excerpts, extracts eight Manhattan median observations, and rejects six out-of-scope or ambiguous entries. Its separate pinned-key feed needs no DNSSEC upload. See [ARCHIVE_PARSER.md](ARCHIVE_PARSER.md) for the rules, evidence and remaining assumptions. Real publisher keys and original signed emails are still pending; the optional transaction harness uses test signatures around real archive wording.

The sections below document the **earlier DNSSEC demonstration**, which remains available unchanged at `/`.

This is a running local application that accepts original-format email files, constructs a DKIM witness in the browser, verifies DNSSEC and DKIM **inside Solidity**, parses a monthly rent observation **inside Solidity**, records one contribution per configured publication, and finalizes a monthly value after exact agreement and a fixed deadline.

It replaces the earlier PoC's authorized reporter signatures. There is **no price oracle service, reporter committee, off-chain verification verdict, owner price setter, upgrade mechanism, or key override** in the new feed. The frontend and static server cannot authorize a price. Anyone can call the contracts directly.

**It is not a live feed from the real newsletters yet.** The deployed application uses three explicitly synthetic `.test` publications and a synthetic DNS root. Their signatures are real RSA/DNSSEC signatures, checked by the actual verification contracts; the publisher identities and rent inputs are test data. The historical corpus contains no original DKIM-verifiable emails, and none of its real publishers has an enabled production profile. See `data/production-status.json`.

## Run the application

```sh
cd /Users/wk/rent-email-feed
npm ci
npm run local
```

Requires Node 22+, Foundry (`forge`, `anvil`) and Solidity 0.8.30. The launcher uses a locally installed `solc` if available, otherwise Foundry resolves the configured compiler. It starts or reuses a loopback Anvil chain at `127.0.0.1:18545`, chain ID **31338**, and serves the static frontend at **http://127.0.0.1:8766**. Newly started chains persist to `.local/anvil-state.json`; reusing a chain preserves existing monthly records. Test transactions use Anvil's public, valueless local accounts. Never send funds to those accounts.

Open `http://127.0.0.1:8766/slideshow.html` for the presentation. The presentation is self-contained; the running application requires the local chain. No public network was deployed or funded.

## Browser walkthrough

1. Select August 2026, or inspect its finalized result if the walkthrough has already run.
2. Choose **Publication A**. This loads a synthetic original `.eml` and a full signed DNSSEC proof chain.
3. Click **Verify email on contract**. The returned month and amount come from `RentEmailFeed.preview()`; the JavaScript email adapter has no price parser.
4. Click **Submit verified email**. The contract repeats every check in the transaction. The default local signer is account 1, not the deployer. A browser wallet on chain 31338 also works.
5. Repeat for B and C. Different publications each count once even though the configured dataset is the same.
6. Click **Advance local test clock to deadline**, then **Finalize month**. This affects only Anvil. The live protocol has no clock-advance function.
7. `rate(202608)` now returns the finalized integer cents. The demo value is **540800**, or **$5,408.00/month**. It is not a claim about actual August rent.

To continue after August, select **September 2026**. Additional signed samples exist for September and October, with signing times October 10 and November 10 respectively. Their timestamps must be reached on the local chain before verification can succeed. There is no privileged feed reset or overwrite.

The file inputs accept your own `.eml` and DNSSEC proof JSON. A real newsletter will remain unsupported until its immutable identity and template are configured in a separate feed. Uploading a self-chosen public key does not authenticate a publisher.

## Contract pipeline

```text
Original .eml file
  → browser prepares canonical signed headers/body and DKIM signature
  → DNSSEC proof binds selector._domainkey.domain to an RSA public key
  → Solidity verifies RSA-SHA256 over signed headers
  → Solidity checks signed bh= against the complete canonical body
  → Solidity decodes supported MIME and matches the fixed rent template
  → Solidity extracts YYYY-MM and USD cents, checks the observation window
  → one authenticated contribution per publication/month
  → exact agreement + fixed deadline → permissionless monthly finalization
```

Canonicalization in the browser is **untrusted witness preparation**, not an assertion the contract accepts. Altering the price in the prepared body breaks `bh=`; altering `bh=` breaks the RSA signature. A replacement RSA key must itself be authorized through a valid DNSSEC proof rooted in the deployment's immutable anchor. Signed identities, signed MIME headers, timestamp, source template and period are checked on-chain.

`FrozenDNSSEC` uses the [ENS DNSSEC verifier](https://github.com/ensdomains/ens-contracts/tree/staging/contracts/dnssec-oracle). The upstream name includes “oracle,” but this component verifies supplied cryptographic DNS records; it does not fetch the web, report a price, or accept an operator's opinion. Its algorithm configuration is installed and ownership is set to the zero address during construction. DNSSEC algorithms 8 (RSA/SHA-256) and 13 (ECDSA P-256/SHA-256), DS digest 2 and bounded signed CNAME chains are implemented. P-256 has a Solidity verification path, so it does not depend on a particular chain having a P-256 precompile.

## Fixed agreement policy

- One feed has one precise measurement: the local demonstration uses Manhattan, one bedroom, arithmetic mean, Corcoran-attributed sample, USD per month.
- Three configured publication identities; **at least two** must submit. Same-corpus publication redundancy is explicitly allowed.
- **All received values must match exactly.** No median of mismatched measurements, majority price, interpolation or reviewer override is used.
- Repeated copies of one publication's email cannot add votes. A source that signs a different value for the same month marks that month conflicted without gaining a second vote.
- Submissions must arrive within **45 days after month end**. The signed DKIM timestamp must fall after the measured month and within its submission window; the timestamp cannot be in the future.
- Anyone can finalize after the deadline. A conflict or missing quorum leaves that month unfinalized. Same-month correction and administrative recovery are deliberately absent.
- Later finalization of an older month cannot move `latestMonth` backward. Consumers can require an explicit maximum age when reading `latest()`.

This policy is neutral **with respect to submitters and the published rules**. Selecting the publisher set, statistic, quorum and deadline is still a policy choice. A configured publisher can veto a month by supplying contradictory signed evidence. A submission deadline bounds how long later evidence can be considered; after it, late corrections do not change the finalized rate. Missing emails and censorship can affect liveness. These are explicit consequences of the rule, not eliminated risks.

## What “no additional oracle trust” can mean

The implementation removes a trusted intermediary's verdict. It cannot remove these underlying dependencies:

| Dependency | What it determines |
|---|---|
| Publisher and its email signing service | The assertion being signed, and control of the DKIM private key |
| DNSSEC root/delegation operators | Which keys belong to a DNS name |
| Cryptography, contract code and chain consensus | Whether the proof and state transition are valid |
| Immutable source/series policy | Which publications and rent measurement consumers choose to accept |

DKIM authenticates an assertion from a signing domain; it does not prove that the market statistic is economically true, that a signing service never signs unauthorized content, or that two publishers measured independent data. Multiple publications can corroborate an assertion from the same dataset, as requested, without removing common failures at the dataset origin or signing infrastructure. The [DKIM specification](https://www.rfc-editor.org/rfc/rfc6376) and [ZK Email's trust-assumption documentation](https://docs.zk.email/architecture/security-considerations) describe these boundaries.

An unsigned DNS record **cannot** be authenticated from an email alone. If a real newsletter's DKIM key lacks a supported DNSSEC chain, it is ineligible under this implementation's no-intermediary rule. There is no fallback to DNS-over-HTTPS trust, a committee, a key registry owner or manually pinned newsletter keys. DNS packet delivery may use any transport; the contract checks the signatures rather than trusting the transport.

Production root-anchor material is saved separately in `data/iana-root-anchors.xml`, retrieved from [IANA](https://data.iana.org/root-anchors/root-anchors.xml). **It is not the anchor used by the local test deployment.** A public-root deployment would still rely on the root's identity and key control. Future unsupported key/algorithm changes require a new deployment and explicit consumer adoption.

## Format and resource limits

The current profile supports RSA-SHA256 DKIM with a 2048–4096-bit key, exponent 65537 and `relaxed/relaxed` canonicalization. It requires `t=` and signed `From`, `Content-Type`, and `Content-Transfer-Encoding`. Optional configured `List-ID` must also appear in the signed headers. Partial-body `l=` signatures, expired `x=`, duplicate relevant signed headers and ambiguous records fail closed.

The parser supports plain text and a deliberately limited HTML-to-text transform, quoted-printable, base64, and bounded multipart/alternative or multipart/mixed messages. It ignores attachments, HTML comments and script/style/head blocks; it is not a complete browser renderer. Unsupported folded MIME part headers, transfer encodings, HTML entities, key restrictions or template variations are rejected. The signed body limit is 64 KiB, header limit 16 KiB, eight parsed text parts and two nested multipart levels. Those size limits are not a guarantee that a particular target chain's gas limit can accommodate a large message.

The three test publications have distinct exact literal templates with a `YYYY-MM` token and an integer-cent USD token. **These are synthetic template fixtures, not proven stable formats for Pinpointe, Hallmark or other real newsletters.** The public corpus contains wording/statistic changes and reviewed context; it does not establish a constant source format. Genuine unmodified emails over multiple periods are necessary to author and validate each real template. Unknown or ambiguous messages remain rejected; there is no LLM fallback.

The measured local sample submissions use about **4.6–5.3 million gas each**; this is a functional demonstration, not an economical production claim. Longer messages and proof chains cost more. Direct verification also discloses the signed headers and body in calldata. Even an `eth_call` sends that data to the chosen RPC. A separate ZK implementation would be needed for private disclosure and substantially cheaper proof checking; no ZK circuit or trusted-setup claim is made here. [OpenZeppelin's RSA verifier](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography#RSA) provides the PKCS#1 validation primitive used by the DKIM contract.

## Tests and reproducibility

```sh
npm test
forge test --use /opt/homebrew/bin/solc -vv
```

`npm test` starts isolated ephemeral Anvil chains for both the earlier DNSSEC suite and the new archive/pinned-key suite, then stops them. It does not change either interactive app's chain. The earlier suite covers actual proof verification, RSA and P-256 DNSSEC, CNAME identity binding, MIME variants, key/header/body tampering, duplicates, source substitution, equivocation, deadline behavior, stale reads and month ordering. Solidity property tests exercise money/month extraction, base64, canonicalization and the new archive parser's cents/calendar behavior.

Independent validation:

```sh
python3 -m venv .local/verify-venv
.local/verify-venv/bin/pip install dkimpy==1.1.8 'dnspython[dnssec]==2.8.0'
.local/verify-venv/bin/python scripts/verify-independent.py
```

`dkimpy` checks the three original test emails independently of our browser adapter and rejects altered bodies. `dnspython` verifies the DNSSEC signatures and delegation links. These functional and adversarial tests are **not an independent security audit**.

Chrome's live sample workflow was used for contract verification, transaction submission, receipt display and finalization. Automated selection through the native file chooser was blocked by the extension's local-file permission, so the automated browser walkthrough used the sample loader, which reads the same `.eml` bytes through the same adapter. The file input itself has not been automated end-to-end.

For Solidity formatting, `[fmt] single_line_statement_blocks = "multi"` is intentional. This installed Foundry formatter's default preserve mode changed control-flow blocks. The source was restored and the formatted result was checked to produce **identical metadata-free bytecode** before being retained.

## Collecting a real DNSSEC proof

After obtaining an original email, read its actual `d=` and `s=` values. Do not substitute the newsletter website domain. With the verification dependencies above installed:

```sh
.local/verify-venv/bin/python scripts/collect-dnssec.py \
  --domain ACTUAL_DKIM_DOMAIN --selector ACTUAL_SELECTOR --output private-emails/proof.json
```

The collector packages untrusted signed DNS records; the contract remains authoritative. Missing signatures, unsupported algorithms or delegation gaps cannot be papered over by a successful ordinary DNS lookup. Current proof validity is required; the implementation does not accept an expired historical DNSSEC proof merely because the email is old.

## Real source activation remains blocked

No production price feed can be truthfully enabled from the files currently available. Required next evidence is:

1. Original signed `.eml` messages from multiple real publications, ideally reporting the same series/month, plus multiple editions to validate the exact formats.
2. The corresponding currently valid DNSSEC chains and stable signed publication identities. A shared sending domain alone is not a distinct publication identity.
3. A frozen real source/template policy, target chain and a deployment/security review appropriate to the intended value at risk.

An actual historical redundancy candidate already exists in the public corpus: Pinpointe's February 17, 2026 edition and The Bigger Apple's February 13 edition both report **$4,695 Manhattan median rent for January 2026**. That is a distinct candidate median series, not the demonstration's one-bedroom arithmetic mean. Neither excerpt authenticates an email or enables a rate update. [Pinpointe](https://newsletter.pinpointe.nyc/p/the-pinpointe-post-c440aefcabbd2af9), [The Bigger Apple](https://thebiggerapple.manhattan.institute/p/friday-newsletter-how-rich-do-you).

The earlier archival parser and its fourteen-source-edition corpus remain at `/Users/wk/nyc-rent-oracle-poc`; they are not silently promoted into authenticated observations.

## Files

- `contracts/KeyProof.sol`: frozen DNSSEC verifier, CNAME/TXT binding and RSA key parsing.
- `contracts/DkimVerifier.sol`: signed header structure, full-body hash, canonicalization and RSA verification.
- `contracts/RentParser.sol`: MIME decoding, deterministic template matching, month and money extraction.
- `contracts/RentEmailFeed.sol`: source identity, per-source monthly receipts, agreement and finalization.
- `web/email.mjs`: browser witness preparation; no price extraction.
- `web/app.mjs`: static frontend calling the contracts directly.
- `scripts/fixtures.mjs`: clearly synthetic signed test messages and full DNSSEC chains.
- `scripts/collect-dnssec.py`: optional untrusted proof collector.
- `scripts/local.mjs`: local chain and static-server launcher.
- `test/`: real EVM integration tests and Solidity property tests.

Test private keys are confined to `.local/test-keys.json`, ignored by Git and excluded from deliverable archives. Original personal emails belong in the ignored `private-emails/` directory; none has been collected.
