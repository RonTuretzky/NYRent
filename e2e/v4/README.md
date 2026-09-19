# Local Uniswap v4 browser proof

From the repository root:

```sh
./e2e/node_modules/.bin/playwright test --config e2e/v4/playwright.config.ts
```

This isolated suite starts Anvil at `127.0.0.1:8559` (chain 31337), deploys the real pinned Uniswap v4 `PoolManager`, `StateView` and `V4Quoter`, mines the real hook address, and deploys the real rent factory, market and router. The app build runs at `127.0.0.1:5199`. It refuses occupied ports and kills its own processes on completion. Only unlocked public Anvil development accounts are used.

`lifecycle.v4.ts` deliberately uses a distinct filename so the main E2E config does not discover it. The main suite, its deployment JSON and its ports remain untouched. Foundry output, local manifests, the app build, screenshots and assertion evidence are under ignored `.artifacts/`.

The production app is built with test-only aliases in this folder's Vite config. No production manifest or key source is rewritten. Six-decimal freely mintable test USDC funds the local wallets. The real `CredailyRentOracle` verifies small synthetic emails signed by the repository's deliberately public RSA test key. The isolated browser bridge uses the same parser, body hash and WebCrypto RSA verification with that test public modulus. These emails are explicitly TEST ONLY; they were never issued by CRE Daily and are not evidence of future publisher data.

The journey:

1. Through the UI, the insurer deposits 1,000 test USDC and receives exactly 1,000 RENT, with 1,000 USDC held in escrow.
2. The insurer adds a real v4 LP position with a separate RENT/USDC budget. Escrow stays unchanged.
3. A target of 3 RENT is quoted as less than 1 USDC of spend, not 3 USDC. The renter buys with 1 USDC and sells 1 RENT back. Token balances and actual stablecoin movements are checked on-chain. The history chart must show both real swap markers; both expanded table rows must match the actual Swap transaction hashes and prices derived from their event data.
4. At the September 2027 observation boundary, UI buys and LP removal are disabled; contract reads show closed trading and locked LP withdrawal. A direct token transfer simulation also reverts.
5. The browser verifies the synthetic September 2027 signature, submits it to the real DKIM oracle, and settles the real market. Base $92.88 and strikes $95.67/$100.31 with settlement $97.99 produce exactly 50% payout.
6. Settlement unlocks LP removal. The insurer and renter redeem their actual RENT holdings through the UI and receive the exact integer payout.
7. After the claim deadline, the original insurer withdraws exactly the remaining escrow; the market's currency balance and accounted escrow both reach zero.

`verified-lifecycle.json` records checked amounts, not a deployment announcement. Screenshots capture the live local trading history, signed settlement, and final residual withdrawal.
