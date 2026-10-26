# Market creation release — 26 October 2026

The `/create` route exposes permissionless creation through the existing Polygon and
Arbitrum v4 factories. It does not deploy a new Google Alert oracle or modify existing
markets. Live factory calls were simulated from an arbitrary address on both chains;
see `evidence/permissionless-creation-2026-10-26.json`. Those calls were not broadcast.

## Available now

- Anyone with a wallet on a supported network can choose office-market strikes and
  dates and call `createMarket`. No owner approval or allowlist is involved.
- The form reads its baseline from the selected chain and validates exact cents and
  UTC dates before simulation and signing. Factory creation receipts identify the
  new market. Creation initializes an empty 1:1 pool; funding and liquidity are
  separate, and new markets are not automatically featured on the homepage.
- Residential policy drafts bind an Apartments.com series URL and as-of month.
  They can be exported without a wallet. Original email fingerprinting happens
  locally; no email is uploaded and no authentication claim is made.

## Not available in this release

Residential Google Alert proof submission, funded residential policy creation, and
residential settlement are not implemented. A local draft is not an onchain policy.
The existing CRE Daily oracle must not accept Google messages or residential values.

Required work before residential activation:

1. Implement and adversarially test full Google DKIM authentication with immutable
   key policy, signature expiry handling, full body coverage and header policy.
2. Bind extraction to one publisher-generated result; reject reflected query text,
   cross-result joins, unrelated URLs, missing periods and ambiguous values.
3. Specify immutable series cohort/unit definitions and submission deadlines.
4. Implement finalization and conflict/no-data economics, including secondary
   holders; test withholding and replay behavior. Consensus among submitted values
   cannot establish that every Google Alert was submitted.
5. Deploy and verify the new contracts separately, then enable residential funding.

Google signs the relay, not publisher truth. Permissionless submission is an access
property; it does not remove evidence validation. The experimental Python extractor
and 28-series catalog remain research tools with settlement disabled.

## Validation

Web typecheck, lint, tests and production build passed. The v4 Solidity suite passed
35 tests, with 2 fork tests skipped because no fork URL was supplied. Live read-only
creation simulations passed on Polygon and Arbitrum. Browser checks covered both
form modes and the disconnected-wallet guard. No wallet transaction or new market
funding was performed for this release.
