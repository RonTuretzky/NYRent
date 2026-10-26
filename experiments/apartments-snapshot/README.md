# Apartments.com snapshot pilot

Status: research prototype, 2026-10-26. **Zero settlement-enabled markets.**

The proposed product tracks a specified Apartments.com page's published headline
rent, relayed in a Google-signed result block. It is a rolling snapshot index, not
the rent paid by all residents or a completed calendar-month average. Existing
RentSafe office markets keep their immutable source and terms.

## Pilot and expansion rule

The initial controlled pilot uses East Harlem, Rego Park and Mott Haven. Six Google Alerts compare
one exact-path evergreen query with one November 2026 query per area. Settings:
As-it-happens, Automatic, All results, English, Any Region. The private execution
ledger records dashboard verification. A configured alert is not delivered data.
The registry includes 26 previously observed areas and two additional public-page
verified areas (Financial District and Downtown Brooklyn); only the original three
are controlled pilot areas. Public-page verification is not received-email evidence.
No dollar amounts appear in queries. A query's month never supplies a result's month.

Observe November and December separately. For each area record all received
original hashes, result locations, explicit periods, values, revisions, signing
identity and verification result, arrival latency and missed months. Compare
evergreen versus month-specific delivery without counting duplicates as independent
measurements. Two more months are a minimum experiment, not a reliability guarantee.
Do not auto-create another month's alerts: propose the next bounded batch based on
received results. Keep the existing broad discovery alerts unchanged.

Promote additional areas to settlement validation only after coherent metric definitions, successful
authentication tests, repeated received periods, acceptable observed delivery delay,
and a reviewed conflict/no-data policy. If rolling page edits do not generate mail,
Google Alerts cannot be the sole periodic transport: evaluate a licensed feed or an
explicitly designed authenticated web-snapshot route as a separate source version.

### User-authorized neighborhood discovery expansion

On October 26 the user requested Brooklyn, FiDi and broad popular-neighborhood
coverage with increasing rents. Added and dashboard-verified 34 evergreen alerts:
18 Brooklyn, 10 Manhattan and six Queens. Together with the original pilot this is
37 dedicated neighborhoods and 40 alerts. See [the exact catalog](neighborhood-coverage.json).
This broadens discovery immediately; it does not promote any market to settlement.

Brooklyn: Williamsburg, Greenpoint, Bushwick, Bedford-Stuyvesant, Crown Heights,
Prospect Heights, Fort Greene, Clinton Hill, Downtown Brooklyn, DUMBO, Brooklyn
Heights, Boerum Hill, Cobble Hill, Carroll Gardens, Gowanus, Park Slope, Sunset Park,
and Flatbush.

Manhattan: Financial District (FiDi), Battery Park City, Tribeca, SoHo, West Village,
East Village, Lower East Side, Chelsea, Upper West Side and Upper East Side.

Queens: Long Island City, Astoria, Sunnyside, Ridgewood, Jackson Heights and Woodside.

Each new query restricts discovery to Apartments.com's rent-market-trends section
and names the neighborhood plus city/borough. It may match nearby comparison tables;
query identity never establishes the result geography. Review and admit each exact
publisher path before parser acceptance. No guessed URLs are added to the allowlist.
All use As-it-happens, Automatic, All results, English and Any Region.

This is broad coverage, not an exhaustive or statistically ranked popularity list.
The public October pages report annual growth of 3.7% for FiDi and 2.6% for Downtown
Brooklyn (URLs above and in the catalog). These are discovery signals, not signed
email observations. For every area, growth from received evidence remains unknown
until comparable observations exist. Match publisher, path, metric, cohort and
period convention; compare explicit periods, keep same-month revisions as conflicts,
and do not drop an area if rents subsequently fall. The watchlist records this rule.

## Proposed architecture

```text
Private original .eml archive
  -> independent full-message authentication verifier
  -> strict Google result-block extractor
  -> versioned series registry and append-only candidate ledger
  -> epoch close / conflict and availability checks
  -> one finalized value for one series and epoch
  -> new per-series oracle adapter -> new market terms
```

Authentication and extraction are separate. Google DKIM authenticates Google's
message, not Apartments.com's own signature or the truth of its report. Require
full body coverage (reject l=), a reviewed header policy, key provenance/rotation,
signed-time and expiration handling, replay protection, and adversarial tests.
A saved DNS key without DNSSEC is not a timeless trust anchor. The collector here
does none of that cryptographic verification and always emits settlementEnabled=false.

The production observation schema needs seriesId, immutable profile hash,
periodKind, asOfMonth, exact cents, currency/unit, source URL, signed message time,
public commitment time, raw hash, result location and authentication proof reference.
The profile must define geography boundary, statistic, property/bedroom cohort,
gross/net and asking/achieved treatment, publisher and intermediary. Unresolved
fields block launch; they are not silently defaulted by this prototype.

## Metric definition must precede money

On the October 26 public check, the generic headline matched the one-bedroom row
on [East Harlem](https://www.apartments.com/rent-market-trends/east-harlem-new-york-ny/)
and [Rego Park](https://www.apartments.com/rent-market-trends/rego-park-queens-ny/).
The saved email snippets only say average rent. Do not retroactively claim a
one-bedroom or all-bedroom measure. A future approved profile can explicitly sell
exposure to the publisher headline, with its limitations, or require explicit
one-bedroom wording in each result. Those are different series versions.

Public-page, preview and received-email prices can differ within one labeled month.
That is why the proposed name is an as-of snapshot. Website prices do not repair
missing or stale fields in an authenticated email.

## Finalization proposal (not implemented)

For a new experimental epoch, fix the series/profile, as-of month, public submission
deadline and challenge deadline before trading. Trading must close before any
eligible observation window. Publish body-hash commitments before the submission
deadline; retain originals privately and a verifiable proof for public acceptance.
Deduplicate by raw hash and result identity; multiple alerts relaying one value
do not increase confidence.

Conservative initial rule: finalize only if all accepted observations for that
series/epoch agree on one value after the challenge window. Different values ->
CONFLICT; none -> NO_DATA. No last-submitter choice, averaging, inferred month,
previous-month carry-forward, or conversion of no data to zero rent. A later rule
such as latest signed snapshot would need a new profile and withholding analysis.

This agreement rule is deterministic over the submitted evidence set, not proof
that every Google message was submitted. A designated collector can withhold mail;
multiple collectors improve availability but do not remove Google's shared
dependency. A permissionless proof/commitment mechanism and an explicit availability
assumption are production gates.

## Current-contract incompatibility

IObservationOracle exposes only timestamp, cents and emailId. RentV4Market.settle
accepts the first qualifying submitted observation, without series or epoch checks.
Do not feed heterogeneous or revisable residential candidates into that interface.
A future adapter must expose only a finalized value for its immutable series/epoch,
or a new market interface must bind these fields directly.

Current RentV4Market returns unspent escrow to original collateral depositors after
redeemEnd; absent data is not a buyer refund. That outcome is unsuitable to silently
inherit for a Google Alerts experiment. Before launch, design and test explicit
CONFLICT/NO_DATA economics for token holders, collateral depositors and LPs, including
secondary transfers. A naive return of deposits cannot refund later token buyers.
Do not deploy or take deposits until that design and security review are complete.

## Run the offline prototype

```sh
cd experiments/apartments-snapshot
python3 -m unittest -v
python3 collector.py /private/path/to/original.eml
```

The extractor recognizes one deliberately narrow received template. It ignores
Subject, entity/title and card heading; uses only the same LINK widget's exact
allowlisted URL and description; requires explicit month/year and geography;
rejects ambiguous JSON/MIME, extra prices and cross-result joins. It may reject
valid new templates until reviewed. Raw hashes support deduplication, not authenticity.
Never commit private originals, mailbox IDs or delivery tokens into this repository.

## Validation on October 26

Nine synthetic boundary tests pass. Replay against 26 privately saved received
observations recovered 23 exact values, including all three pilot areas. Bayside,
Harlem and Gowanus were conservatively held because their snippets include additional
dollar amounts. This is extraction coverage, not a cryptographic success rate.
No independent DKIM verification was performed by this replay. No live mailbox scan
or monitoring checkpoint advancement occurred. The existing monitoring watchlist
now references the six exact pilot queries and the private execution ledger.
