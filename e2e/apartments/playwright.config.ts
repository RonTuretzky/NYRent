// Full policy journey against a local Gnosis fork. Expects anvil on 8599 with the
// contracts deployed and the app previewing on 5176; see e2e/apartments/README.md.
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 180000,
  expect: { timeout: 20000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5176", screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
