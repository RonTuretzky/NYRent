# e2e-shim — EIP-1193 test wallet for Playwright

`wallet-shim.ts` exports `installTestWallet(options)`, a fully self-contained
function meant to be passed to Playwright's `page.addInitScript` **with its
options object** (Playwright serializes the function into the page, so it must
not close over imports — and it doesn't):

```ts
import { installTestWallet } from "../web/e2e-shim/wallet-shim";

await page.addInitScript(installTestWallet, {
  rpcUrl: "http://127.0.0.1:8547",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // anvil account 0
  chainId: 100, // what the wallet reports; use e.g. 1 to test the wrong-network banner
  knownChainIds: [100], // optional: chains wallet_switchEthereumChain accepts
});
```

Design:

- **No keys anywhere.** `eth_sendTransaction` / sign methods are forwarded to
  the anvil RPC, whose *unlocked* accounts sign node-side.
- Handles the wallet-side surface wagmi's injected connector needs:
  `eth_requestAccounts`, `eth_accounts`, `eth_chainId`,
  `wallet_switchEthereumChain` (updates chain + emits `chainChanged`, throws
  4902 for unknown chains), `on`/`removeListener` events, EIP-6963
  announcement. Everything else proxies to the node.
- **Never in production builds:** nothing under `web/src` imports this
  directory; vite bundles only from the `src` entry graph. Keep it that way.
