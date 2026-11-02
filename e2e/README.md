# Browser end-to-end suite

The only browser suite is the neighborhood-policy suite in [`policies/`](policies/README.md):
a production build of the app driven against a local Arbitrum One fork with a test-key oracle,
a V2 pool (where every new policy goes) and a V1 pool (the earlier rules), using a headless
wallet (`web/e2e-shim/wallet-shim.ts`, no keys).

```sh
npm --prefix e2e ci
npm --prefix e2e exec playwright install chromium   # first time only
npm --prefix e2e run e2e:policies                    # from the repo root
```

The office-market suites (CoverPool on Gnosis and Arbitrum, Uniswap v4 RENT markets, the CRE
Daily journey and the walkthrough recorders) were removed with those pages; their history is in
git. The contracts and their Foundry tests remain.
