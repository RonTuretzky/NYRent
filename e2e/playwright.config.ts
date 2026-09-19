// Mirrors issue.fund's playwright.config.ts style; the global setup additionally
// owns the whole stack (Anvil → forge deploy → seed → vite build/preview).
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  // The mainnet-fork suite has its own config/stack (fork/playwright.config.ts,
  // anvil on 8549); never run it as part of the local-chain suite.
  testIgnore: "**/fork/**",
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
