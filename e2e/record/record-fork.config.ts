// Guide-GIF recorder on the MAINNET-FORK stack: reuses e2e/fork's global setup
// verbatim (anvil --fork-url Gnosis on 8549, impersonated real sponsor opens a
// series, buyer holds real USDC.e, production build on 5175 against the REAL
// committed deployment.json). Records the pay-with-USDC.e swap buy plus the
// deployment-truth site shots (docs page shows the real Gnosis addresses here,
// not throwaway anvil ones).
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["**/swap-buy.guide.ts", "**/site.guide.ts"],
  timeout: 420000, // forked state is fetched lazily from the remote RPC
  expect: { timeout: 45000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "../fork/global-setup.ts",
  globalTeardown: "../fork/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5175",
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-record-fork" }],
});
