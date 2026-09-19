import { defineConfig } from "@playwright/test";

// Read-only capture of the production-configured UI. No wallet is installed.
export default defineConfig({
  testDir: ".", testMatch: "record.live.ts", timeout: 240000,
  expect: { timeout: 45000 }, workers: 1, retries: 0, reporter: [["list"]],
  use: { baseURL: process.env.RECORD_LIVE_URL ?? "http://127.0.0.1:5205", browserName: "chromium" },
});
