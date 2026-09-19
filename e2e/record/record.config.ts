// Guide-GIF recorder on the LOCAL stack: reuses the main suite's global setup
// (anvil 8547 → forge deploy → seed → vite build/preview 5174) untouched. The
// *.guide.ts suffix keeps recorder specs out of `npm run e2e` (the main config's
// default testMatch only picks *.spec.ts), and this config only ever matches
// the journey recorder. 1280×720 at deviceScaleFactor 2 gives the CDP screencast
// ~1800px frames — 2× supersampling for crisp 900px GIFs.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "**/journey.guide.ts",
  timeout: 420000, // shots pace themselves for the camera; settle drives 2 txs
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "../global-setup.ts",
  globalTeardown: "../global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium-record" }],
});
