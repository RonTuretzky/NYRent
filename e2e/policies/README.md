# Neighborhood policies: browser end-to-end suite

Drives the production build (home page and every `/policies` route) on a local
**Arbitrum One fork** with a headless wallet, through both journeys to completion (a
**settled payout**, a void refund, a cancel and the creator's residual withdrawal), the
shared record-a-rent step, every error path the UI can reach, both pools (V2 for new
policies, V1 at `/policies/v1/:id`), the nav and old-route redirects, and layouts at
360/390/768/1280 px.

```sh
npm --prefix e2e run e2e:policies                     # from the repo root
SHOT_DIR=/abs/path/for/screenshots npm --prefix e2e run e2e:policies
```

## What the setup owns (and restores)

1. `anvil --fork-url $ARBITRUM_FORK_URL` on **127.0.0.1:8551**, real chainId 42161
   (default upstream `https://arb1.arbitrum.io/rpc`; reads only).
2. A **test-key** `ApartmentsRentOracle` + V1 `CoverToken` + `ApartmentsCoverPool` on the
   fork via `script/DeployApartmentsFork.s.sol`, broadcast from an impersonated fresh
   address (`--unlocked`), then a V2 `CoverToken` + `ApartmentsCoverPoolV2` on the same
   oracle, created by the setup from forge artifacts (`script/DeployApartmentsV2.s.sol`
   needs a key and the real Google modulus). The live contracts on Arbitrum are never touched and no
   private key is read. The real Google key cannot sign a future month, so the suite
   records a synthetic alert signed with `fixtures/testkey`
   (`scripts/make-google-alert-eml.py`, written into `.artifacts/`).
3. Fresh code-less wallets (never anvil's dev keys) funded with fork ETH and real
   on-fork USDC transferred from a large holder (`USDC_WHALE`, overridable).
4. A production `vite build` served on **127.0.0.1:5177**, with `VITE_RPC_URL` pinning
   the app's only (Arbitrum) transport to the fork. During the build
   `web/src/chain/apartments-deployment.json` is temporarily replaced with the fork
   addresses and restored right after (and in teardown). `git status` must be clean
   after a run.

Teardown kills only the anvil and preview it spawned and deletes `out-policies/` and
`cache-policies/`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARBITRUM_FORK_URL` | `https://arb1.arbitrum.io/rpc` | upstream RPC the fork reads from |
| `USDC_WHALE` | Hyperliquid bridge | on-fork USDC holder impersonated as the faucet |
| `SHOT_DIR` | unset | absolute directory for full-page screenshots |
| `REAL_ALERT_EML` | unset | a real Google Alert `.eml` to upload for the browser-side preview (never published: the fork is local) |

The wallet shim (`web/e2e-shim/wallet-shim.ts`) holds no keys; anvil signs for the
impersonated senders. Real emails live outside the repo (`fixtures/private/` is
gitignored) and no mailbox address appears in code.

## Files

- `01-journeys.spec.ts`: empty list, creator opens two policies through the UI, two
  renters buy (approve then buy, double-click sends once), list reflects both.
- `02-errors.spec.ts`: every error path while sales are open (wallet, network, funds,
  gas, inputs, allowance, rejection, pause, capacity race, sold out, bad ids, RPC down
  and stale, stuck pending, upload failures).
- `02b-two-pools.spec.ts`: V2 rules (the current month is offered, sale-close options
  never pass month end, create and buy within the month, a recorded rent stops sales with
  the `RentAlreadyRecorded` copy) and a V1 policy working at `/policies/v1/:id`.
- `03-settle.spec.ts`: sale closes under an open page, synthetic alert recorded (and
  rejected again as already recorded), claims shut until month end + 2 days (V2) while the
  V1 policy waits seven, finalize + settled claim on both pools, void refund, nothing to
  claim, cancel, claims closed, both creators withdraw.
- `04-responsive.spec.ts`: no horizontal scroll, 44 px tap targets, labelled inputs,
  keyboard focus, screenshots per width (home, list, details incl. V1, create, submit, guide).
- `05-home-nav.spec.ts`: the home page, the nav reaching every policy route on desktop and
  mobile, retired routes redirecting home, no horizontal scroll on home.

## Live contracts

`POLICIES_LIVE=1 npx playwright test -c policies/playwright.config.ts policies/01 policies/02 policies/04`
drives the deployed addresses of both pools on the fork. Spec 03 needs the test key. Settlement of the live
contracts with a real email is `test/apartments/LiveArbitrumFork.t.sol`, which needs
`ARBITRUM_FORK_RPC` and `fixtures/private`.
