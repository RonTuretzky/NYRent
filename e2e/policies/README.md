# Neighborhood policies: browser end-to-end suite

Drives the production build of `/policies` on a local **Arbitrum One fork** with a
headless wallet, through both journeys to completion (a **settled payout**, a void
refund, a cancel and the creator's residual withdrawal), the shared record-a-rent
step, every error path the UI can reach, and layouts at 360/390/768/1280 px.

```sh
npm --prefix e2e run e2e:policies                     # from the repo root
SHOT_DIR=/abs/path/for/screenshots npm --prefix e2e run e2e:policies
```

## What the setup owns (and restores)

1. `anvil --fork-url $ARBITRUM_FORK_URL` on **127.0.0.1:8551**, real chainId 42161
   (default upstream `https://arb1.arbitrum.io/rpc`; reads only).
2. A **test-key** `ApartmentsRentOracle` + `CoverToken` + `ApartmentsCoverPool` on the
   fork via `script/DeployApartmentsFork.s.sol`, broadcast from an impersonated fresh
   address (`--unlocked`). The live contracts on Arbitrum are never touched and no
   private key is read. The real Google key cannot sign a future month, so the suite
   records a synthetic alert signed with `fixtures/testkey`
   (`scripts/make-google-alert-eml.py`, written into `.artifacts/`).
3. Fresh code-less wallets (never anvil's dev keys) funded with fork ETH and real
   on-fork USDC transferred from a large holder (`USDC_WHALE`, overridable).
4. A production `vite build` served on **127.0.0.1:5177**. During the build two files
   are temporarily replaced and restored right after (and in teardown): the legacy
   `web/src/deployment.json` (chainId 42161, so `VITE_RPC_URL` pins the Arbitrum
   transport to the fork) and `web/src/chain/apartments-deployment.json` (fork
   addresses). `git status` must be clean after a run.

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
- `03-settle.spec.ts`: sale closes under an open page, synthetic alert recorded (and
  rejected again as already recorded), finalize + settled claim, void refund, nothing
  to claim, cancel, claims closed, creator withdraws.
- `04-responsive.spec.ts`: no horizontal scroll, 44 px tap targets, labelled inputs,
  keyboard focus, screenshots per width.

## Live contracts

`POLICIES_LIVE=1 npx playwright test -c policies/playwright.config.ts policies/01 policies/02 policies/04`
drives the deployed addresses on the fork. Spec 03 needs the test key. Settlement of the live
contracts with a real email is `test/apartments/LiveArbitrumFork.t.sol`, which needs
`ARBITRUM_FORK_RPC` and `fixtures/private`.
