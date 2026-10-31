# Neighborhood rent policies

Permissionless rent protection on Apartments.com neighborhood pages, settled by
Google Alerts emails verified on-chain. Contracts are ownerless, unupgradeable and
**unaudited**.

| Contract | Role |
| --- | --- |
| `src/apartments/ApartmentsCoverPool.sol` | Policies: escrow, premiums, finalize, claims |
| `src/apartments/ApartmentsRentOracle.sol` | DKIM verification, earliest-signed log |
| `src/apartments/GoogleAlertParser.sol` | Strict extraction from the signed email |
| `src/CoverToken.sol` | Soulbound claim units |

## How a policy works

1. **Create.** Anyone picks a page, a month, a start strike, a full-payout strike and a
   premium, and escrows the full capacity. Sales close at or before the first second of
   the month, so nobody can buy with that month's value already published.
2. **Buy.** Anyone pays `premium% × max payout` for soulbound claim units, each backed 1:1
   by that policy's escrow.
3. **Record.** Anyone submits a Google Alert email signed during the month whose sentence
   names that month. All results in the email are logged.
4. **Finalize.** Seven days after month end anyone can finalize. Claiming also finalizes.
5. **Claim.** The window lasts at least 14 days after finalize opens; the app defaults to 30.
   Whatever remains after it closes returns to the creator.

## Which value counts

For each page and month the **earliest-signed** qualifying email wins. Submission order
does not matter and a later email cannot replace it. Different values inside a month are
expected because the page is a rolling snapshot; the first signed value is the rule, not a
conflict, so a losing side cannot force a void by submitting a second email.

With **no** qualifying email the policy voids: holders recover their premium and the
creator recovers the escrow. A lack of data is never a zero payout.

## What a qualifying email is

- `d=google.com`, selector `20251104`, `rsa-sha256`, `relaxed/relaxed`, no `l=`, the From
  line ending `<googlealerts-noreply@google.com>`.
- Inside one LINK widget of the signed inbox-markup JSON, both of:
  - the Google redirect URL for exactly
    `https://www.apartments.com/rent-market-trends/<slug>/`;
  - the sentence `As of <Month> <YYYY>, the average rent in <Name> was $<n>/mo.`, with
    `<Name>` matching the leading labels of `<slug>`.
- The signature time is inside `<Month> <YYYY>` UTC.

Other Apartments.com snippets, such as "Average Rent by Bedroom", do not qualify and are
skipped. In the October 2026 archive 30 of 40 Apartments.com results qualified.

## Trust assumptions and known limits

- **Apartments.com is the data source.** The value is its published headline, which can
  change or be wrong. The bedroom mix is not specified by the headline.
- **Google is the transport.** DKIM proves Google relayed a snippet, not that it is true.
  If Google stops sending these snippets, or the template changes, policies void.
- **Delivery is an assumption.** Alerts fire when Google sees a change. As of 2026-10-31 the
  archive holds one month of values, all received October 8–11. A November alert has not
  been observed.
- **Key rotation.** Selector `20251104` is pinned forever. After Google rotates it, new
  emails fail and policies void until a new oracle and pool are deployed.
- **Withholding.** Whoever holds an email chooses whether to submit it, so the earliest
  *submitted* email need not be the earliest *sent*. Anyone who cares should run their own
  alert for the page and submit within the seven-day window.
- **Privacy.** Verification needs the signed headers and whole body, so submitting publishes
  the recipient address, the alert query and the links in the email, including the
  unsubscribe link, permanently. Use a mailbox dedicated to these alerts.
- **Curated list.** The contract accepts any page slug. The app labels pages outside its
  catalog. Check the page before buying.

## Operations

```sh
python3 scripts/make-google-alert-fixtures.py ~/path/to/eml-archive   # private fixtures
forge test --match-path 'test/apartments/*'
forge script script/DeployApartments.s.sol --rpc-url gnosis --broadcast
```

Addresses live in `web/src/chain/apartments-deployment.json`. Real emails under
`fixtures/private/` hold a mailbox address and delivery tokens, and stay gitignored.
