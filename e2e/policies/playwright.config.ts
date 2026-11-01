// Neighborhood-policy suite on an Arbitrum fork: own stack (anvil 8551,
// preview 5177) so it never collides with the other suites or with anvils
// other projects run on this machine. Files run in name order on one worker:
// 01 creates and buys, 02 drives error paths while sales are open, 03 warps
// time to record, settle, claim and withdraw, 04 checks layouts.
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 240000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: "http://127.0.0.1:5177", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
