// The full user journey against real infrastructure (SPEC §7): Anvil + the actual
// deploy script + the built app, settled by uploading the REAL CRE Daily .eml.
// UI reachability is asserted through the testid contract in web/E2E.md; the money
// math is re-checked directly over RPC so a lying frontend cannot pass.
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import {
  ACCOUNTS,
  FIXTURE_EML,
  approveThen,
  connectWallet,
  coverBalance,
  currencyBalance,
  installWallet,
  observation,
  observationCount,
  poolBalance,
  setAccount,
} from "./support/helpers";

const SPONSOR = ACCOUNTS[0];
const BUYER = ACCOUNTS[1];
const SERIES = 0n;
const FUND = parseEther("0.02"); // demo series capacity (SPEC §2.5)
const MAX_CLAIM = parseEther("0.01");
const PREMIUM = parseEther("0.00285"); // 2850 bps of 0.01
const PAYOUT = parseEther("0.0061"); // 61% of 0.01
// Ground truth of the fixture email (SPEC §0 / meta.json).
const OBS_T = 1789642464n;
const OBS_CENTS = 9288;
const EMAIL_ID = "0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1";

test.describe.configure({ mode: "serial" });

test("sponsor funds the pool with the series capacity", async ({ page }) => {
  await installWallet(page, { accountIndex: 0 });
  await page.goto("/#/sponsor");
  await connectWallet(page);
  await page.getByTestId("fund-amount").fill("0.02");
  await approveThen(page, "fund-button");
  await expect.poll(poolBalance, { timeout: 30000 }).toBe(FUND);
});

test("buyer pays the premium and mints cover units", async ({ page }) => {
  await installWallet(page, { accountIndex: 1 });
  await page.goto("/#/buy/0");
  await connectWallet(page);
  await page.getByTestId("buy-amount").fill("0.01");
  // Quoted premium: 0.01 at 2850 bps.
  await expect(page.getByText(/0\.00285/).first()).toBeVisible();
  await approveThen(page, "buy-button");
  await expect.poll(() => coverBalance(BUYER, SERIES), { timeout: 45000 }).toBe(MAX_CLAIM);
  expect(await poolBalance()).toBe(FUND + PREMIUM);
});

test("anyone settles by uploading the real newsletter email", async ({ page }) => {
  await installWallet(page, { accountIndex: 1 });
  await page.goto("/#/settle/0");
  await connectWallet(page);
  await page.getByTestId("eml-input").setInputFiles(FIXTURE_EML);

  // Preflight (emailkit in-browser) must be all green on the authentic email.
  const checks = page.locator("[data-testid^=preflight-check-]");
  await expect.poll(() => checks.count(), { timeout: 30000 }).toBeGreaterThanOrEqual(8);
  await expect(page.locator("[data-testid^=preflight-check-][data-pass=false]")).toHaveCount(0);

  await page.getByTestId("record-button").click();
  await expect.poll(observationCount, { timeout: 45000 }).toBe(1n);
  const [t, cents, emailId] = await observation(0n);
  expect(t).toBe(OBS_T);
  expect(cents).toBe(OBS_CENTS);
  expect(emailId).toBe(EMAIL_ID);

  await page.getByTestId("settle-button").click();
  // (9288 - 8800) / (9600 - 8800) = 61%
  await expect(page.getByTestId("settle-ratio")).toContainText("61", { timeout: 30000 });
});

test("buyer redeems 61 percent of max claim", async ({ page }) => {
  await installWallet(page, { accountIndex: 1 });
  const before = await currencyBalance(BUYER);
  await page.goto("/#/redeem/0");
  await connectWallet(page);
  await page.getByTestId("redeem-amount").fill("0.01");
  await page.getByTestId("redeem-button").click();
  await expect.poll(() => coverBalance(BUYER, SERIES), { timeout: 30000 }).toBe(0n);
  expect(await currencyBalance(BUYER)).toBe(before + PAYOUT);
});

test("sponsor withdraws free capital after redemption", async ({ page }) => {
  await installWallet(page, { accountIndex: 0 });
  const sponsorBefore = await currencyBalance(SPONSOR);
  const poolBefore = await poolBalance();
  await page.goto("/#/sponsor");
  await connectWallet(page);
  await page.getByTestId("withdraw-amount").fill("0.001");
  await page.getByTestId("withdraw-button").click();
  await expect.poll(poolBalance, { timeout: 30000 }).toBe(poolBefore - parseEther("0.001"));
  expect(await currencyBalance(SPONSOR)).toBe(sponsorBefore + parseEther("0.001"));

  // Journey bookkeeping: pool retained fund + premium − payout − withdrawal.
  expect(await poolBalance()).toBe(FUND + PREMIUM - PAYOUT - parseEther("0.001"));

  // Account switching still works on the same page (regression for the shim).
  await setAccount(page, 1);
});
