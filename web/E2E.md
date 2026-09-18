# E2E notes — the contract between `web/` and `e2e/`

The Playwright suite (`e2e/journey.spec.ts`, `e2e/failures.spec.ts`) drives the **built** app
(`vite build` + the `preview` script, port **5174**) with a headless EIP-1193/EIP-6963 wallet
("E2E Test Wallet", `e2e/support/wallet-shim.js`) whose transactions are signed by Anvil's
unlocked dev accounts. For the suite to pass, the app must honor the following. Everything here
is sensible production behavior, not test-only code — the only test-specific artifacts are the
`data-testid` attributes.

## Environment behavior (already implemented)

- **Chain comes from `src/deployment.json`** (`src/chain/wagmi.ts`): `chainId: 100` ⇒ Gnosis;
  anything else ⇒ local chain with RPC `http://127.0.0.1:8547` (the e2e Anvil port). The e2e
  setup rewrites `deployment.json` with the local addresses before building and restores it
  afterwards.
- **Injected-only connectors, no WalletConnect projectId.** The suite clicks the RainbowKit
  ConnectButton (accessible name `Connect Wallet`) and then the wallet option matching
  `/E2E Test Wallet|Injected|Browser/i`.
- The app reacts to `accountsChanged`/`chainChanged` provider events (wagmi default); the suite
  switches between Anvil accounts #0 (deployer = sponsor) and #1 (buyer).
- Pool flows submit an ERC-20 `approve` first when allowance is insufficient
  (`approve-button`, then the main action button becomes enabled) — the suite drives both.

## `data-testid` contract

Amount inputs take whole-WXDAI decimal strings (e.g. `0.01`); the app converts to wei. Action
"buttons" must expose a real `disabled` state (`toBeDisabled()`); the kit `Button` does.

Already present in `src/`:

| Testid | Where | Meaning |
|---|---|---|
| `wrong-network-banner` | global | Visible when the connected wallet's chain ≠ deployment chain. Contains a button whose name matches `/switch/i` triggering `wallet_switchEthereumChain`; banner hides on success. |
| `not-deployed-banner` | global | Zero addresses in deployment.json (never visible during e2e). |
| `buy-amount` | `/buy/:id` | Max-claim input. |
| `buy-validation` | `/buy/:id` | Visible when client-side validation fails (over capacity/solvency/balance, bad slippage). Filling `0.05` against the 0.02-capacity demo series must show it and disable `buy-button`. |
| `approve-button` | `/buy/:id` (and any flow pulling currency) | Conditional approval step. |
| `buy-button` | `/buy/:id` | Disabled while validation fails or approval is pending. |
| `tx-pending` / `tx-confirmed` / `tx-reverted` | tx status | Informational; the suite judges outcomes by chain state. |

Required on the remaining pages (same naming style):

| Testid | Where | Meaning |
|---|---|---|
| `fund-amount`, `fund-button` | `/sponsor` | Sponsor deposit into the pool (with `approve-button` when needed). |
| `withdraw-amount`, `withdraw-button` | `/sponsor` | Withdraw free capital. |
| `eml-input` | `/settle/:id` | The `<input type="file">` behind the drag-drop zone — keep it in the DOM (visually hidden is fine) so `setInputFiles` works. |
| `preflight-check-<CheckId>` | `/settle/:id` | One element per emailkit preflight check with attribute `data-pass="true"/"false"`. `<CheckId>` values from `src/lib/emailkit.ts` `CHECK_IDS`: `eml-parse`, `dkim-found`, `tag-policy`, `structure`, `from-domain`, `bh-match`, `rsa-verify`, `timestamp`, `extraction`. The suite requires ≥ 8 rendered checks and asserts `bh-match`/`rsa-verify` individually. |
| `preflight-error` | `/settle/:id` | Friendly error when the file isn't parseable as a signed email at all (e.g. a `.txt`). |
| `record-button` | `/settle/:id` | Sends `submitObservation`; disabled unless every preflight check passes. On `AlreadyRecorded`, skip ahead and enable settling. |
| `settle-button` | `/settle/:id` | Sends `settle(seriesId, obsIndex)`. |
| `settle-ratio` | `/settle/:id` | Shows the settled payout ratio; must contain `61` for the demo fixture (9288 between 8800/9600). |
| `redeem-amount`, `redeem-button` | `/redeem/:id` | Burn cover units for payout. |

## Scenarios exercised

- **Journey** (serial): fund `0.02` → buy `0.01` (premium `0.00285`, quoted premium text visible)
  → upload the real `fixtures/credaily-2026-09-17/credaily-cpace-2026-09-17.eml`, all checks
  green, record + settle (ratio 61%) → redeem `0.01` pays `0.0061` → withdraw `0.001`. Chain
  state (ERC-1155 balance, currency balances, oracle observation `t`/`cents`/`emailId`) is
  verified over RPC, not just via the UI.
- **Failures** (run first, chain-state-neutral): fixture with `$92.88`→`$99.99` edited in the
  body ⇒ `preflight-check-bh-match` `data-pass="false"` while `preflight-check-rsa-verify` stays
  `"true"`, `record-button` disabled; a `.txt` file ⇒ `preflight-error`; `0.05` into `buy-amount`
  ⇒ `buy-validation` + disabled `buy-button`; wallet on chain `0x1` ⇒ banner, recovery via its
  switch button.
