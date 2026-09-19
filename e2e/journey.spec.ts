// The full user journey against real infrastructure (SPEC §7), on the
// PERMISSIONLESS pool (no roles): a creator underwrites a series through the
// app by escrowing their own capacity, a buyer pays the premium (currency-
// direct — the local chain deploys no SwapAndBuyRouter), anyone settles by
// uploading the REAL CRE Daily .eml, and the buyer redeems 61%. The creator's
// residual withdrawal lives in tests/residual.spec.ts (it must warp past
// redeemEnd, which the races suite has to run before).
// UI reachability is asserted through the testid contract in web/E2E.md; the
// money math is re-checked directly over RPC so a lying frontend cannot pass.
//
// TIME BASE: anvil is pinned to 2026-09-10 (~7.4 days BEFORE the fixture
// email's signed t) and demo series 0 sells until obsStart = start + 36h, so
// buys run at start time and the journey warps to SETTLE_WARP_TS before
// settling. Every test aligns the BROWSER clock to the chain clock
// (support/helpers.ts `alignClock`) — the app gates windows on Date.now().
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import {
  ACCOUNTS,
  FIXTURE_EML,
  SETTLE_WARP_TS,
  alignClock,
  approveThen,
  chainNow,
  connectWallet,
  coverBalance,
  currencyBalance,
  installWallet,
  observation,
  observationCount,
  poolBalance,
  readSeries,
  seriesCount,
  setAccount,
  warpTo,
} from "./support/helpers";

const CREATOR = ACCOUNTS[0]; // deployed the stack + escrowed demo series 0
const BUYER = ACCOUNTS[1];
const SERIES = 0n;
const ESCROW_0 = parseEther("0.02"); // demo series 0 escrow (deploy script)
const ESCROW_1 = parseEther("0.005"); // series 1, created through the UI below
const MAX_CLAIM = parseEther("0.01");
const PREMIUM = parseEther("0.00285"); // 2850 bps of 0.01
const REDEEM_AMOUNT = parseEther("0.006"); // partial redeem; races uses the rest
const PAYOUT = parseEther("0.00366"); // 61% of 0.006
// Ground truth of the fixture email (SPEC §0 / meta.json).
const OBS_T = 1789642464n;
const OBS_CENTS = 9288;
const EMAIL_ID = "0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1";

/** Chain timestamp → the browser's datetime-local input value (local tz,
 * minute precision — both sides of the round-trip use the machine's tz). */
function toLocalInput(ts: bigint): string {
  const d = new Date(Number(ts) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

test.describe.configure({ mode: "serial" });

test("anyone underwrites: the creator escrows a new series through the app", async ({
  page,
}) => {
  const base = await chainNow();
  await alignClock(page, base);
  await installWallet(page, { accountIndex: 0 });
  await page.goto("/#/underwrite");
  await connectWallet(page);

  // Windows honouring every on-chain rule (saleEnd ≤ obsStart < obsEnd <
  // redeemEnd, redeemEnd ≥ obsEnd + 7d), minute-floored by the inputs.
  const saleEnd = base + 7200n;
  const obsEnd = base + 86400n;
  const redeemEnd = obsEnd + 8n * 86400n;
  await page.getByTestId("create-strike-low").fill("88.00");
  await page.getByTestId("create-strike-high").fill("96.00");
  await page.getByTestId("create-rate").fill("28.50");
  await page.getByTestId("create-capacity").fill("0.005");
  await page.getByTestId("create-sale-end").fill(toLocalInput(saleEnd));
  await page.getByTestId("create-obs-start").fill(toLocalInput(saleEnd));
  await page.getByTestId("create-obs-end").fill(toLocalInput(obsEnd));
  await page.getByTestId("create-redeem-end").fill(toLocalInput(redeemEnd));

  // The form tells the creator plainly that THEY deposit the escrow.
  await expect(page.getByTestId("create-escrow-note")).toContainText(
    "You deposit",
  );

  // approve escrow (allowance was consumed by the deploy) → createSeries.
  await approveThen(page, "create-series-button");
  await expect(page.getByText(/Market #1 created/)).toBeVisible({
    timeout: 30000,
  });

  // On-chain truth: the pool now holds BOTH escrows; series 1 belongs to the
  // creator with exactly the entered terms.
  await expect.poll(seriesCount, { timeout: 30000 }).toBe(2n);
  const s1 = await readSeries(1n);
  expect(s1.creator).toBe(CREATOR);
  expect(s1.escrow).toBe(ESCROW_1);
  expect(s1.strikeLowCents).toBe(8800);
  expect(s1.strikeHighCents).toBe(9600);
  expect(s1.premiumRateBps).toBe(2850);
  expect(s1.saleEnd).toBeLessThanOrEqual(s1.obsStart);
  expect(await poolBalance()).toBe(ESCROW_0 + ESCROW_1);
});

test("buyer pays the premium and mints cover units", async ({ page }) => {
  await alignClock(page);
  await installWallet(page, { accountIndex: 1 });
  await page.goto("/#/buy/0");
  await connectWallet(page);
  await page.getByTestId("buy-amount").fill("0.01");
  // Quoted premium: 0.01 at 2850 bps.
  await expect(page.getByText(/0\.00285/).first()).toBeVisible();
  await approveThen(page, "buy-button");
  await expect(page.getByText("Cover minted.")).toBeVisible({ timeout: 45000 });
  await expect.poll(() => coverBalance(BUYER, SERIES), { timeout: 45000 }).toBe(MAX_CLAIM);
  expect(await poolBalance()).toBe(ESCROW_0 + ESCROW_1 + PREMIUM);
});

test("anyone settles by uploading the real newsletter email", async ({ page }) => {
  // Warp past demo series 0's obsStart AND the fixture's signed t: the sale
  // has closed (saleEnd = obsStart on-chain) and the oracle's `t ≤ now + 1d`
  // rule is satisfied. The browser clock follows the warp.
  await warpTo(SETTLE_WARP_TS);
  await alignClock(page, SETTLE_WARP_TS);
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

test("buyer redeems at the 61 percent ratio", async ({ page }) => {
  await alignClock(page);
  await installWallet(page, { accountIndex: 1 });
  const before = await currencyBalance(BUYER);
  await page.goto("/#/redeem/0");
  await connectWallet(page);
  // Partial redeem: 0.006 of the 0.01 held. The remaining 0.004 stays live
  // for the races suite's balance-changed test; whatever is never redeemed
  // returns to the creator in tests/residual.spec.ts — both re-assert this
  // journey's exact numbers.
  await page.getByTestId("redeem-amount").fill("0.006");
  await page.getByTestId("redeem-button").click();
  await expect
    .poll(() => coverBalance(BUYER, SERIES), { timeout: 30000 })
    .toBe(MAX_CLAIM - REDEEM_AMOUNT);
  expect(await currencyBalance(BUYER)).toBe(before + PAYOUT);
  expect(await poolBalance()).toBe(ESCROW_0 + ESCROW_1 + PREMIUM - PAYOUT);

  // Account switching still works on the same page (regression for the shim).
  await setAccount(page, 0);
});
