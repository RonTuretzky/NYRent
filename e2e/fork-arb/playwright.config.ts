// Arbitrum-fork suite: proves the header chain switch + the one-transaction
// native-ETH SwapAndBuyRouter path against REAL Arbitrum One state (real
// SwapRouter02/QuoterV2/WETH-USDC pool, the real deployed CoverPool/router) on
// an anvil fork — no mainnet funds are ever spent. Own stack: anvil --fork-url
// on 8550 + a production build served on 5176 (the local-chain suite owns
// 8547/5174, the Gnosis fork suite 8549/5175).
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 240000, // forked state is fetched lazily from the remote RPC
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5176",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
