import { defineConfig } from "@playwright/test";
import { PREVIEW } from "./constants";

export default defineConfig({
  testDir: ".", testMatch: "story.v4.ts", outputDir: ".artifacts/story-results",
  timeout: 180000, expect: { timeout: 20000 }, workers: 1, retries: 0,
  reporter: [["list"]], globalSetup: "./story.global-setup.ts", globalTeardown: "./global-teardown.ts",
  use: { baseURL: PREVIEW, browserName: "chromium", viewport: { width: 1366, height: 768 }, actionTimeout: 15000, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
