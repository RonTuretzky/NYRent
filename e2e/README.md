# Browser end-to-end suite

Playwright suite for the full lifecycle against real local infrastructure — no mocked chain, no
mocked crypto. The global setup owns everything:

1. **Anvil** on `127.0.0.1:8547`, chainId 31337 (fresh chain per run).
2. **Deploy**: `forge script script/Deploy.s.sol:Deploy --broadcast` with Anvil's **well-known dev
   key #0** (a public tooling constant — the real deployer key never appears anywhere in this
   repo). Foundry writes to `out-e2e/`/`cache-e2e/`, deleted again in teardown.
3. **`web/src/deployment.json`** written from the broadcast (any pre-existing copy is backed up
   to `.artifacts/` and restored in teardown).
4. **Seeding**: wraps 1 native coin into the local currency for the creator (account #0) and the
   buyer (account #1) via WETH9-style `deposit()`. The deploy script itself escrows demo
   series 0 (the pool is permissionless — the broadcaster is just its first creator).
5. **`vite build` + the web `preview` script** on `127.0.0.1:5174`.

Run it:

```sh
npm run e2e                                        # from the repo root
npm run e2e:fork                                   # Gnosis mainnet fork (USDC.e router buy)
npm run e2e:fork:arb                               # Arbitrum fork (chain switch + native-ETH buy)
npm --prefix e2e exec playwright install chromium  # first time only
```

`journey.spec.ts` walks underwrite-through-the-app → buy → settle-by-uploading-the-real-`.eml`
→ redeem (61%), re-checking every money movement over RPC with viem; `tests/residual.spec.ts`
(last file: it warps months past `redeemEnd`) closes the loop with the creator's one-shot
residual withdrawal. `failures.spec.ts` covers the tampered email (must fail exactly the
body-hash check), junk files, over-capacity buys and the wrong-network banner; it mutates no
chain state and runs first. `tests/races.spec.ts` drives mid-flow chain races into the decoded
error copy.

**Clock discipline**: anvil is pinned ~9 days in the past (the fixture email's signed `t` must
fall inside demo series 0's observation window), while the app judges every sale/claim window
by `Date.now()`. Specs therefore pin the browser clock to the chain clock with
`alignClock(page)` (Playwright fake timers, still ticking) before `page.goto`, and warp both
sides together (`warpTo` + `alignClock`/`clock.fastForward`).

## Wallet

No extension and no in-repo private key: `support/wallet-shim.js` is a ~100-line EIP-1193
provider announced via EIP-6963 as **"E2E Test Wallet"**. It answers account/chain queries
locally and forwards everything else — including `eth_sendTransaction` — to Anvil, whose
unlocked dev accounts do the signing. Specs can switch accounts (`window.__e2eWallet.setAccount`)
and simulate a wrong-chain wallet (`installWallet(page, { chainIdHex: "0x1" })`).

## Contracts this suite codes against (Integrate-phase checklist)

Written against frozen SPEC §2/§4 signatures before the other components landed. It additionally
assumes, and the Integrate phase must reconcile:

- `script/Deploy.s.sol` exposes contract `Deploy` (etherform's default target) and, on
  chainId 31337, deploys a WETH9-style local currency (payable `deposit()`) instead of pinning
  mainnet WXDAI, plus the demo series as **seriesId 0**.
- The web app reads `web/src/deployment.json` at build time and targets *its* `chainId`
  (31337 ⇒ RPC `http://127.0.0.1:8547` — already implemented in `web/src/chain/wagmi.ts`), has a
  `preview` npm script pinned to port 5174, and implements the `data-testid` contract in
  [`web/E2E.md`](../web/E2E.md).
- Broadcast output stays etherform-compatible (`broadcast/Deploy.s.sol/31337/run-latest.json`
  with `contractName`/`contractAddress` on CREATE transactions).

Suite-internal ports: 8547/5174 (local suite), 8549/5175 (Gnosis fork suite, `fork/`),
8550/5176 (Arbitrum fork suite, `fork-arb/` — builds with a temporary 42161-shaped
`deployment.json` so `VITE_RPC_URL` pins the app's Arbitrum transport to the fork, restored in
teardown). Each suite's `.artifacts/` holds pids/state/backups and is gitignored.
