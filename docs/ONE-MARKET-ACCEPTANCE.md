# One-market specification acceptance

Source: the user's “Shaurya: RentSafe — rebuild website + demo around ONE rent market”
attachment. The newly supplied attachment on 2026-09-19 is identical to the recovered
`pasted_text_2026-09-19_15-45-53.txt`. The v4 HTML attachment is also byte-identical to the
workspace deck. This matrix tracks the actual implementation, including deliberate
accuracy corrections and the distinction between tested code and deployment.

| Requirement | Implementation / evidence |
|---|---|
| Preserve office-rent index and DKIM verification | Original `CredailyRentOracle` unchanged; new market reads it; large-email helper reconstructs original bytes before calling it |
| $92.88 Sept 2026 base; authenticated provenance | `useActiveMarket` / `useV4Market` validate baseline month and value; base provenance bound at construction. Demo badges were removed at the user's subsequent request |
| One Sep 2026 → Sep 2027 market, RENT name, 3%–8% band | Shared `lib/market.ts`, explicit active market / deployment manifest, live strike and date checks |
| Fully collateralized mint and capped linear payout | `RentV4Market`, complete lifecycle, fuzz and stateful invariants |
| Trading closes before observation | Hook gates swaps/additions at saleEnd; token + LP freeze at obsStart; chosen saleEnd equals obsStart |
| Escrow yield, or planned fallback | Dashboard yield parameter defaults to 4%, explicitly hypothetical/planned; actual escrow earns no strategy yield |
| PLATFORM / INSURER / RENTER roles | Overview diagram and three role cards; insurer/renter dashboards; source/lease-basis disclosure |
| Single market; no visible picker | Seven requested primary routes plus transaction routes; old functionality preserved through hidden legacy routes |
| No user-visible “series” | Visible route/copy/error migration and primary-route browser assertions; ABI names remain internal for compatibility |
| Persistent base/band/window strip | Removed at the user's subsequent request; terms remain on the market overview and in docs |
| Unaudited / experimental / office not residential | Persistent app disclosure and docs |
| Wallet, wrap/payment swap, settle, redeem preserved | Legacy paths retained; 16 existing/new browser journeys pass |
| Overview: base/strikes/curve/dates/price/escrow/holdings | Live shared data or labeled demo values; fixed-rate versus v4 price distinguished |
| Insurer sliders+numeric inputs C,p,y,u | `InsurerDashboard`, shared financial formulas, outcome table and chart |
| Insurer outcomes grid, claims/net/capital/return | `lib/market.ts` shared OUTCOME_GRID and insurer functions |
| Insurer break-even/worst-case/max-loss explanation | Defaults tested; zero-sales and no-loss scenarios handled; backing lock explained |
| Renter R,p; units/cost/payout/net/increase context | `RenterVisualizer`, shared formulas and grid; basis risk explicit |
| Buy N RENT prefill | Fixed checkout receives N; v4 uses exact-output quotation to estimate input budget, then displays actual executable exact-input receipt quote; never treats N RENT as N stablecoin |
| Market price → implied growth/rent | Shared transformation and qualified explanatory text |
| Swap-event price history with implied-rent axis | `V4PriceHistory` reads exact PoolId events; bounded recent history, real timestamps, no invented historical line when RPC fails |
| Shared financial formulas across pages | `lib/market.ts`; v4 bigint execution/AMM helpers in `chain/v4Math.ts` |
| Renter defaults: 3000 RENT / $855 / 4.4% / $3000 | Unit tests + browser assertions (underlying break-even 4.425%) |
| Insurer defaults: $2850 / $4000 / -$3150 | Unit tests + browser assertions; $4000 is hypothetical yield, zero-yield loss also shown |
| Price .285 → 4.4% | Unit + browser assertions |
| Two-fixture DKIM settlement demo | Dedicated local v4 browser harness uses explicit test RSA key with signed September baseline and later $97.99 observation; future fixture is never represented as a real newsletter |
| Real v4 pool, mint, LP, buy/sell, settle, redeem | Actual v4 contracts, canonical Arbitrum PoolManager fork lifecycle, isolated local browser lifecycle |
| Publish/redeploy | Website published to `rentsafe.nyc` from Pages commit `7edb994`; seven primary routes, default values, mobile layout, legacy recording and HTTPS redirects checked live. Polygon v4 mainnet is now funded and active; see the current launch record below |

## Corrections made to avoid misleading claims

1. `3% + 5% × p` is **price-equivalent growth**, not expected growth. Clipped payouts do
   not identify an entire rent-outcome distribution.
2. `N = R × 5%` covers only the five-percentage-point band, not the renter's complete
   rent increase. The office index can diverge from the renter's own lease.
3. At defaults the insurer break-even is 6.425%, versus renter 4.425%. The difference
   is modeled yield per sold claim (`5% × y/u`), not an independently measured loading.
4. Transferable RENT in insurer wallets or AMM positions still has a redemption right.
   The live v4 overview labels total outstanding RENT rather than pretending supply equals
   “RENT sold.” The insurer calculator retains the specified sold-fraction scenario.
5. The first successful qualifying settlement call wins. The immutable oracle cannot prove
   that no earlier authentic email was withheld. Cent-rounded strike payouts differ slightly
   from the ideal percentage equation; actual contract strikes control redemption.
6. A liquidity withdrawal returns the LP's current inventory; backing stays escrowed until
   claim payouts or post-deadline residual recovery. Selling RENT requires available liquidity.

## Verification record

The completed fixed-price/one-market pass: 16 Playwright tests, 108 web unit tests after
adding v4 amount/price helpers, TypeScript and lint. Contract pass: 202 tests, zero failures;
an optional v4 fork test was separately run successfully against the canonical Arbitrum
PoolManager. The isolated v4 browser suite and launch rehearsal have their own run reports;
their local addresses must not be installed as production manifests.

The isolated v4 browser lifecycle passed with actual mint, LP, buy/sell, two independently
verified swap-history rows/markers, observation freeze, test-key DKIM settlement at 50%,
LP removal, both holders' redemptions and final residual withdrawal to zero escrow.
The final canonical Arbitrum fork launch proof completed 14 successful transactions,
including the authentic production-key baseline and real USDC buy/sell. The fork proof
increased only the local native ETH balance to measure gas; it did not submit future data.

The optional direct v4 market-making integration also passes the full 237-test agent suite
(14 v4-specific tests). A separate local real-PoolManager proof posts bid/ask ranges,
fills an ask from another wallet, replaces both quotes and unwinds to zero positions before
cutoff. The executor defaults to dry run and is not scheduled or funded for production.

Funding and launch gates are recorded in [V4-ROLLOUT.md](V4-ROLLOUT.md). Bankr remains held.

## Website publication

On 2026-09-19 at 20:30 UTC, GitHub Pages completed deployment of `7edb994` from the
existing repository and custom domain. A real-browser smoke pass visited all seven
primary routes, checked the acceptance numbers, found no visible “series” strings on
those routes, checked four mobile layouts without horizontal overflow, and loaded the
preserved live Gmail recording in legacy docs. There were no uncaught page errors.
HTTP and `www` both redirect to the HTTPS apex. At that publication the one-market site
was a labeled preview and the production v4 manifest was empty. The launch below supersedes
that earlier status.


## Polygon activation and navigation update — 2026-09-19

The production v4 manifest now contains the independently verified Polygon mainnet market.
All 15 launch transactions succeeded, including authentic DKIM baseline submission, 0.50
USDC backing, liquidity provisioning, and actual buy/sell. Six application contracts are
source-verified on Sourcify. [Mainnet launch evidence](V4-ROLLOUT.md#polygon-mainnet-launch--2026-09-19)
contains addresses, costs, receipt links and the remaining future settlement boundary.

The website defaults to Polygon, supports a direct wallet-connect action and network switch
on checkout, and starts at 0.01 USDC for the small pilot. Navigation groups Renter and Insurer
under “For renters / insurers,” and Settle and Redeem under “Settle / redeem.” Dropdowns
support keyboard focus, Escape, outside click and mobile expansion. The restored animated
homepage and styled controls remain in place.

Verification for this update: 112 web unit tests, three one-market browser journeys, and
one isolated wallet-driven v4 lifecycle passed; TypeScript, lint and production build passed.
The full browser lifecycle proves the UI transaction path locally; the separate mainnet
receipts prove actual Polygon buy/sell. It does not claim a user wallet has been connected.


The live wallet check exposed a dependency incompatibility: Cuer 0.0.3 requests a zero
QR border that qr 0.7 rejects, crashing WalletConnect's QR view. A versioned patch applied
by `npm install`/`npm ci` uses the encoder's supported one-module border and removes that
ring before Cuer adds its visual padding. Regression tests render the wallet QR component
and independently decode its matrix back to a synthetic pairing URI. Mobile navigation
also waits until click to dismiss a group, avoiding layout movement before the next
trigger receives its click; the browser journey covers switching groups in one click.


## Requested UI cleanup — 2026-09-19

Removed the shared market-terms strip and all visible demo badges/copy across the primary
routes. Live metrics show an unavailable state when chain data is missing, instead of
labeling hard-coded values as current prices. Calculator inputs remain editable; transaction
availability, authenticated baseline checks, and the Polygon buy/sell flow are unchanged.
