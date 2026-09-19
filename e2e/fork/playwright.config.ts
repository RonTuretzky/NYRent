// Mainnet-fork suite: proves the Uniswap swap-to-buy path against REAL Gnosis
// state (real SwapRouter02/QuoterV2/pools, the real deployed CoverPool) on an
// anvil fork — no mainnet funds are ever spent. Own stack: anvil --fork-url on
// 8549 + a production build served on 5175 (the local-chain suite owns 8547/5174).
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
    baseURL: "http://127.0.0.1:5175",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
