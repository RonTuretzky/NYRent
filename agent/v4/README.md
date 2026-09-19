# Opt-in Uniswap v4 quote actuator

This module uses the existing Bachelier valuation in `../policy/valuation.mjs` to place a currency-funded bid range below fair value and a RENT-funded ask range above fair value. The ask retains the existing 1.25× model loading. An inventory lean lowers quotes when RENT inventory is high and raises them when it is low. The hook's deterministic swap fee is separate and goes to LPs. Collateral earns no yield in this implementation.

`readV4State()` pins reads to one block, verifies the factory/market/router/PoolManager/oracle/StateView wiring, reads signed oracle observations, and discovers the wallet's open router positions from `LiquidityModified` events starting at the verified deployment block. It refuses more than two active positions or more than 1,000 historical events; an RPC history failure stops planning. Dropping a local position list cannot silently leave old quotes active. Only the wallet's positions in this router and market are covered.

`planV4Quotes()` is pure. Only fresh, verified oracle observations (maximum age 45 days, no future timestamps) enter this version of the signal. The planner uses exact integer TickMath and amounts for signing; floating-point calculations choose model price bands. Each plan can mint at most 0.5 currency units, commit at most 0.5 currency units to bids, acquire at most 0.5 RENT at the far edge of the bid range, and sell at most 0.5 RENT. New minting stops when this market's cumulative collateral entitlement would exceed 2 currency units. These are pilot limits, not profitability guarantees. The model can be wrong, a range can fill, and the holder can lose the premium or an underwriter can pay the full face value.

`executeV4QuotePlan()` defaults to dry run. The trusted target comes separately from the plan. The executor re-reads state, checks identity, chain, window, price drift, position ownership, replay state, balances and all amount limits. It removes old ranges with minimum receipts, optionally mints fully funded RENT, and places at most one bid and one ask using exact approvals. Each opt-in transaction is simulated and estimated immediately before sending, with a receipt wait and abort on the first failure. Limits: 1 million gas per transaction, 5 million gas per run, 1 gwei gas price, and 0.005 native coin maximum gas budget. Dry run returns reviewed calldata and bounds; it does not claim dependent transactions were simulated before their approvals existed.

The core planner and executor are signer-agnostic: they do not read private keys, `.env`, keychain, Bankr, the fixed-price executors, or a scheduler. The base CLI is read-only:

```sh
node agent/v4/run.mjs --target public-v4-target.json --rpc https://YOUR_RPC
cd agent
npm run test:v4
npm run test:v4:local
```

The public target JSON contains `chainId`, `wallet`, `market`, `currency`, `oracle`, `factory`, `hook`, `router`, `poolManager`, `stateView`, and `deploymentBlock`. Use the verified deployment manifest and add the intended wallet. Sending requires an explicitly supplied wallet client:

```js
const state = await readV4State(publicClient, trustedTarget);
const plan = planV4Quotes(state);
const result = await executeV4QuotePlan({
  plan, target: trustedTarget, publicClient, walletClient, execute: true,
});
```

The POC adds a separately gated Bankr custody adapter around that same executor;
it does not duplicate the quote logic. `--bankr-review` gathers the existing
real-estate/news collectors and asks Bankr for a qualitative risk review. The
authenticated oracle still supplies every numeric rent input, and only the
deterministic planner can choose amounts or ticks:

```sh
node agent/v4/run-bankr.mjs --target public-v4-target.json --rpc https://YOUR_RPC --bankr-review
BANKR_V4_EXECUTE=1 node agent/v4/run-bankr.mjs --target public-v4-target.json --rpc https://YOUR_RPC --bankr-review --execute
```

`settle-bankr.mjs` is a separate settlement-only inbox scan. It verifies raw
`.eml` files locally, uses the chunk helper for large canonical bodies, records
the first qualifying observation, and settles idempotently. It refuses every
chain action until trading is closed and contains no quote/swap import:

```sh
node agent/v4/settle-bankr.mjs --target public-v4-target.json --rpc https://YOUR_RPC --inbox ./raw-eml
```

Execution holds a chain+wallet lock across preflight and all transactions in this process and refuses wallets with pending transactions. A caller using multiple processes or other wallet tools must provide an exclusive external wallet lock; the library does not coordinate separate processes. There is no automatic retry or crash-resume journal. Successful receipts are returned, and partial failures expose `error.receipts`. After interruption, reconcile pending transaction hashes/receipts, wait for finality, and generate a fresh plan from live state. Never retry an uncertain mint blindly. A stale plan is rejected after collateral or LP positions change; this is not a replacement for a cross-process lock.

Near the sale cutoff the plan only unwinds tracked LP positions. During the observation lock it refuses all LP actions. Expiry/settlement makes LP recovery possible again. Removal does not withdraw collateral or automatically redeem RENT: those rights remain in `RentV4Market` and its holder/insurer flows.

The local proof starts and stops an isolated Anvil on port 8611. It deploys the upstream real PoolManager, test dollars, a mock observation oracle, and the production RentV4 contracts. It verifies zero dry-run transactions, two one-sided positions, a buyer filling the ask, remove-and-requote, cutoff unwind, replay rejection, and observation-window refusal. It uses local unlocked test accounts and sends zero production transactions. Core contract tests separately pass against the canonical Arbitrum PoolManager on a read-only fork. This quote actuator has not been enabled for unattended production trading.
