# Browser end-to-end suite

Playwright suite for the full lifecycle against real local infrastructure — no mocked chain, no
mocked crypto. The global setup owns everything:

1. **Anvil** on `127.0.0.1:8547`, chainId 31337 (fresh chain per run).
2. **Deploy**: `forge script script/Deploy.s.sol:Deploy --broadcast` with Anvil's **well-known dev
   key #0** (a public tooling constant — the real deployer key never appears anywhere in this
   repo). Foundry writes to `out-e2e/`/`cache-e2e/`, deleted again in teardown.
3. **`web/src/deployment.json`** written from the broadcast (any pre-existing copy is backed up
   to `.artifacts/` and restored in teardown).
4. **Seeding**: wraps 1 native coin into the local currency for the sponsor (account #0) and the
   buyer (account #1) via WETH9-style `deposit()`.
5. **`vite build` + the web `preview` script** on `127.0.0.1:5174`.

Run it:

```sh
npm run e2e                                        # from the repo root
npm --prefix e2e exec playwright install chromium  # first time only
```

`journey.spec.ts` walks sponsor-fund → buy → settle-by-uploading-the-real-`.eml` → redeem →
withdraw, re-checking every money movement over RPC with viem. `failures.spec.ts` covers the
tampered email (must fail exactly the body-hash check), junk files, over-capacity buys and the
wrong-network banner; it mutates no chain state and runs first.

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

Suite-internal ports: 8547 (Anvil), 5174 (preview). `.artifacts/` holds pids and the
`deployment.json` backup and is gitignored.
