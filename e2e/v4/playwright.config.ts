import { defineConfig, devices } from "@playwright/test";
import { PREVIEW } from "./constants";
export default defineConfig({
  testDir: ".",
  testMatch: "lifecycle.v4.ts",
  outputDir: ".artifacts/results",
  timeout: 90000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: ".artifacts/report", open: "never" }]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: PREVIEW, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{name: "chromium-v4-local", use: {...devices["Desktop Chrome"]}}],
});
