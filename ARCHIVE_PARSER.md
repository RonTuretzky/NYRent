# Archive-derived parsing and pinned DKIM keys

The new implementation uses actual wording from the fourteen previously collected archive entries. It has eight fixed grammar rules for **Manhattan median monthly rent, all apartment sizes, USD**. This version does not mix arithmetic means, one-bedroom averages, office rents or other boroughs into that series.

Run `npm run archives`, then open **http://127.0.0.1:8766/archives.html**. The earlier DNSSEC/synthetic-template app remains available at `/`. The archive app uses its own loopback chain at port 18547, chain ID 31339, and does not reset the earlier demonstration.

## What the evidence actually is

`data/archive-research-corpus.json` preserves the original research corpus. `scripts/archive-data.mjs` creates the reproducible `web/archive/corpus.json` baseline. The baseline includes the quoted rent passage, source URL, publication date, observed section headings where needed, text checksum and expected result. Intervening prose is omitted and line breaks are normalized. These are **curated public-archive excerpts, not original `.eml` messages or exact publisher HTML/MIME**. No human-reviewed geography or period flag is accepted by the contract as proof.

For direct parser calls, the archive publication date is supplied as **unauthenticated test metadata**. In `PinnedRentFeed`, the same argument comes exclusively from the verified DKIM `t=` value. An uploader cannot supply a separate reporting month or amount to that feed. Whether each real publication's signing timestamp reliably identifies its edition month still needs validation against original emails.

## Fixed rules

| Rule | Publication      | Accepted structure                                                     | Period                                         |
| ---- | ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | Pinpointe        | Market Pulse → Rental Rundown → `Manhattan: Median rent hit $…`        | Month/year in Market Pulse heading             |
| 2    | Pinpointe        | Same section → `Manhattan rents climbed to a median of $…`             | Month/year in heading                          |
| 3    | Pinpointe        | Same section → `Manhattan median rent hit $…/month`                    | Month/year in heading                          |
| 4    | Pinpointe        | `Manhattan Hits All-Time Rental High: $… Median in …`                  | Named month, year derived from issue timestamp |
| 5    | The Bigger Apple | `The median rent in Manhattan was $… last month.`                      | Previous UTC calendar month of issue timestamp |
| 6    | Hemlane          | `median rent price in Manhattan hitting a record of $… in …`           | Named month, year derived from issue timestamp |
| 7    | CRE Daily NY     | `Median Manhattan rent reached $… in …`                                | Named month, year derived from issue timestamp |
| 8    | Finding Space    | `In …, renters in Manhattan met record-highs with a median rent of $…` | Named month, year derived from issue timestamp |

Matching is ASCII case-insensitive after bounded MIME decoding and whitespace normalization. It uses explicit byte scans and finite grammar branches in Solidity, not JavaScript price extraction or an LLM. Dollar amounts are checked for comma grouping, exactly two fractional digits when decimals are present, permitted trailing syntax and range ($100–$100,000). A new wording or metric is not inferred from surrounding prose.

Pinpointe's Market Pulse heading must refer to the previous completed month. Rental matching is confined between Rental Rundown and Sales Snapshot, with bounded section lengths. If both the section and a recognized news headline provide a value, they must agree. Repeated matching phrases within one text part are rejected, even when they repeat a value. Recognized observations in plain/HTML alternatives must agree; a MIME alternative containing no recognized observation contributes no value.

Named months without a year mean their latest occurrence before the issue month. The signing date must be within **90 days after the reporting month's end**. Pinpointe's monthly format uses the stricter previous-month constraint. This is a fixed policy assumption, not an economic inference. An explicit historical year is not silently replaced with the recent year. UTC month boundaries apply. Delivery or signing delays around a month boundary can therefore cause rejection or, for relative wording, a wrong period if the publisher's signed timestamp does not identify the edition; original emails must establish that convention before real deployment.

## Baseline decisions

| Edition                     | Result                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| Pinpointe 2025-05-13        | Reject: arithmetic mean, not median                              |
| Pinpointe 2025-06-17        | May 2025 · $4,571                                                |
| Pinpointe 2025-07-15        | Reject: stale April heading in a July issue                      |
| Pinpointe 2026-02-17        | January 2026 · $4,695                                            |
| Pinpointe 2026-04-21        | March 2026 · $5,000; separate $5,206 one-bedroom mean is ignored |
| Pinpointe 2026-05-26        | April 2026 · $5,099                                              |
| CRE Daily NY 2026-03-18     | Reject: NYC-wide median                                          |
| CRE Daily NY 2026-08-18     | July 2026 · $5,000                                               |
| The Bigger Apple 2026-02-13 | January 2026 · $4,695                                            |
| The Bigger Apple 2026-03-20 | Reject: quoted statistic is Brooklyn median                      |
| Hallmark 2026-07-13         | Reject: unsupported mean/studio/one-bedroom series               |
| Finding Space 2025-04-23    | February 2025 · $4,500                                           |
| Hemlane 2025-07-18          | May 2025 · $4,571                                                |
| Broadsheet 2024-09          | Reject: mean series and insufficient period specificity          |

Eight excerpts parse; six are deliberately rejected. Two matching publication pairs exist: January 2026 at $4,695 (Pinpointe / Bigger Apple), and May 2025 at $4,571 (Pinpointe / Hemlane). These corroborate the publications' reported numbers; matching values do not establish identical sample definitions or independent measurement.

Pinpointe has six editions in the evidence, four eligible. Bigger Apple and CRE Daily each have two editions with only one eligible. Hemlane and Finding Space each have one relevant example. That is a baseline for supported wording, **not evidence that these publishers promise a permanent format or a rent figure every month**.

## Pinned-key feed

`PinnedRentFeed.Source` fixes `domain`, canonical signed `from`, optional signed `listId`, `selector`, RSA `modulus`, and the publication grammar ID at construction. RSA exponent is 65537. Supported modulus lengths are 2048, 3072 or 4096 bits. The contract accepts only signed header/body bytes and the DKIM signature. There is no DNSSEC input, caller-selected public key, caller-selected grammar, owner, key updater, price setter or upgrade path.

The feed checks the configured identity, verifies RSA/DKIM and complete body coverage, then calls the archive parser with the signed timestamp. Distinct configured publications count separately, including those repeating the same corpus. Each contributes once per month. A conflicting signed value blocks finalization; there is no majority-price override. Any caller can finalize after the 90-day window when quorum exists and all received values agree. `latest(maxAge)` permits explicit freshness checks. Late corrections do not change a closed rate.

The 90-day window accommodates Hemlane's May figure published in July. It also delays finalization compared with the earlier 45-day demo. Consumers must explicitly accept that latency. A configured source can block a month by signing contradictory evidence. The contract cannot require every possible contradictory email to be submitted before the deadline.

**Assumption accepted for this implementation:** verified DKIM public keys will be supplied later. A pinned key is the trust anchor; its initial association with the publisher must be established and reviewed at deployment. DNSSEC is optional for that one-time establishment, not required by this feed. Pinning does not track DNS key rotation/revocation automatically. A removed or compromised key remains authorized in this deployment. There is no hidden administrator who can resolve that; a key transition needs a new deployment or a separately designed authenticated transition protocol.

The two downloadable `.eml` integration samples place real January archive wording inside new, explicitly synthetic signed envelopes from `.test` identities. Their purpose is to exercise the contract path using test keys; they are **not reconstructed original emails and do not authenticate the real publishers**.

## Validation and remaining limits

`npm run test:archives` launches an isolated ephemeral Anvil chain on port 18549, tests all fourteen archive decisions plus adversarial input and the pinned-key submission/finalization path, then stops that test process. `forge test --use /opt/homebrew/bin/solc` includes cents and calendar property tests. Tests do not mutate either interactive app's chain.

The shared MIME decoder remains deliberately limited. Curated plain-text snippets and generated HTML/base64/multipart variants have been exercised. Full untouched publisher email bodies, their transfer encodings, signed header coverage, key rotation and recipient-specific differences have not. The implementation requires RSA-SHA256, relaxed/relaxed DKIM, `t=`, and signed From/Content-Type/Content-Transfer-Encoding. Missing or unsupported forms fail closed. The parser does not understand arbitrary negation, quotations, CSS visibility, qualification or editorial correction outside its recognized grammar. Broad keyword extraction would not solve that. Source selection and validation against full real editions are essential before enabling a live feed.

The browser's editable text panel is an unverified parsing tool. Only the pinned-key feed can create authenticated monthly contributions, and the currently deployed keys are test keys. Direct verification discloses signed headers and body to the RPC and in transaction calldata. No independent security audit or private ZK proof path is claimed.

## Files

- `contracts/ArchiveRentParser.sol`: fixed publication grammars and reporting periods.
- `contracts/PinnedRentFeed.sol`: fixed keys, DKIM verification, aggregation and finalization.
- `contracts/RentParser.sol`: shared bounded MIME decoder; earlier literal parser preserved.
- `web/archives.html` / `web/archives.mjs`: interactive corpus results and pinned-key test flow.
- `web/archive/corpus.json`: exact baseline excerpts, provenance and expected decisions.
- `test/archives.test.mjs` / `test/ArchiveProperties.t.sol`: regression, adversarial and property tests.
- `scripts/archives-local.mjs`: reproducible local launcher with separate persisted chain state.

The earlier slideshow describes the earlier DNSSEC implementation. This document and the archive app describe the new pinned-key branch of the implementation.
