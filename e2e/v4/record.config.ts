import { defineConfig } from "@playwright/test";
import { PREVIEW } from "./constants";

// Presentation capture uses the same isolated, real-contract stack as lifecycle.v4.ts.
// Run separately: it owns ports 8559/5199 while recording.
export default defineConfig({
  testDir: ".",
  testMatch: "record.walkthrough.ts",
  outputDir: ".artifacts/recording-results",
  timeout: 600000,
  expect: { timeout: 30000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: PREVIEW, browserName: "chromium" },
});
