import { defineConfig } from "@playwright/test";
import { PREVIEW } from "./constants";

export default defineConfig({
  testDir: ".", testMatch: ["mobile.v4.ts", "mobile-content.v4.ts"], outputDir: ".artifacts/mobile-results",
  timeout: 180000, expect: { timeout: 20000 }, workers: 1, retries: 0,
  reporter: [["list"]], globalSetup: "./global-setup.ts", globalTeardown: "./global-teardown.ts",
  use: { baseURL: PREVIEW, browserName: "chromium", viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, actionTimeout: 20000, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
