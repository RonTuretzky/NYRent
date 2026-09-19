// Guide-GIF shots on the local anvil stack — the same journey the e2e suite
// proves (fund 0.02 → buy 0.01 → settle with the REAL CRE Daily .eml → redeem
// → withdraw), paced for a camera: fake cursor glides, readable beats, caption
// chips, one frames dir per GIF (assembled by scripts/gif_assemble.py).
// Chain state accumulates in journey order and the oracle accepts the fixture
// email exactly once, so the shots must stay serial.
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import {
  ACCOUNTS,
  FIXTURE_EML,
  coverBalance,
  currencyBalance,
  observationCount,
  poolBalance,
} from "../support/helpers";
import {
  awaitStat,
  caption,
  connectGuideWallet,
  glide,
  glideClick,
  installCursor,
  installGuideWallet,
  pause,
  scrollToView,
  slowType,
  startCapture,
} from "./guide.helpers";

const BUYER = ACCOUNTS[1];
const SERIES = 0n;
const FUND = parseEther("0.02");
const MAX_CLAIM = parseEther("0.01");
const PAYOUT = parseEther("0.0061"); // 61% of 0.01

test.describe.configure({ mode: "serial" });

test("landing.gif — hero + the five animated how-it-works steps", async ({ page }) => {
  await installCursor(page); // scroll-only shot; cursor stays parked off-screen
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The explainer is its own lazy chunk — have it in the DOM before rolling.
  await expect(page.getByTestId("hiw-step-fund")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);

  const stop = await startCapture(page, "landing");
  await pause(page, 2400); // hero + chips
  for (const key of ["fund", "buy", "email", "settle", "redeem"]) {
    // Center each step row and let its looping viz run ~a full cycle.
    await scrollToView(page, page.getByTestId(`hiw-step-${key}`), 1000);
    await pause(page, 4000);
  }
  await scrollToView(page, page.getByTestId("payout-curve"), 1000);
  await pause(page, 2600);
  await stop();
});

test("connect-browse.gif — browse series, open detail, connect the wallet", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 1 });
  await page.goto("/#/series");
  await expect(page.getByTestId("series-card-0")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const stop = await startCapture(page, "connect-browse");
  await caption(page, "Every series is browsable before you connect");
  await pause(page, 1600);
  await glideClick(page, page.getByTestId("series-card-0"));
  await expect(page.getByTestId("payout-curve")).toBeVisible();
  await pause(page, 1600);
  await scrollToView(page, page.getByTestId("payout-curve"));
  await pause(page, 1400);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await pause(page, 1000);
  await caption(page, "Connect only when you're ready to act");
  await connectGuideWallet(page, { animated: true });
  await pause(page, 2000); // connected account chip in the header
  await caption(page, null);
  await stop();
});

test("sponsor-fund.gif — approve, then fund the pool with 0.02", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 0 });
  await page.goto("/#/sponsor");
  await connectGuideWallet(page);
  const fundAmount = page.getByTestId("fund-amount");
  await expect(fundAmount).toBeVisible();
  await fundAmount.scrollIntoViewIfNeeded();

  const stop = await startCapture(page, "sponsor-fund");
  await caption(page, "Sponsor console — collateralize the pool");
  await pause(page, 1200);
  await slowType(page, fundAmount, "0.02");
  await pause(page, 900);
  // Fresh allowance is zero → the two-step approve-then-fund UI shows.
  await glideClick(page, page.getByTestId("approve-button"));
  const fundButton = page.getByTestId("fund-button");
  await expect(fundButton).toBeEnabled({ timeout: 60000 });
  await pause(page, 900);
  await glideClick(page, fundButton);
  await expect.poll(poolBalance, { timeout: 45000 }).toBe(FUND);
  await pause(page, 1200); // confirmed toast + tx status
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  // Hold until the Pool state row itself stably shows the new balance, so the
  // GIF's last frame teaches the change (see awaitStat on why "stably").
  await awaitStat(
    page,
    page.getByText("Pool balance", { exact: true }).locator(".."),
    "0.02 WXDAI",
  );
  await pause(page, 1200);
  await caption(page, null);
  await stop();
});

test("buy.gif — token selector, quote + pricing, approve + buy", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 1 });
  await page.goto("/#/buy/0");
  await connectGuideWallet(page);
  const amount = page.getByTestId("buy-amount");
  await expect(amount).toBeVisible();

  const stop = await startCapture(page, "buy");
  await caption(page, "Buy 0.01 of cover — premium is a fixed 28.5%");
  await pause(page, 1100);
  await slowType(page, amount, "0.01");
  // Quoted premium: 0.01 at 2850 bps.
  await expect(page.getByText(/0\.00285/).first()).toBeVisible();
  await pause(page, 1300);
  // The pricing-transparency panel is a <details>: open it on camera.
  const pricing = page.getByTestId("pricing-panel");
  await scrollToView(page, pricing);
  await glideClick(page, pricing.locator("summary"));
  await expect(page.getByTestId("pricing-breakdown")).toBeVisible();
  await pause(page, 2200); // expected claim + risk margin + implied exposure
  await scrollToView(page, page.getByTestId("token-select"));
  await caption(page, "Pay with WXDAI (or wrap xDAI 1:1)");
  await glide(page, page.getByTestId("token-option-xdai"));
  await pause(page, 900);
  await glideClick(page, page.getByTestId("token-option-wxdai"));
  await pause(page, 900);
  await caption(page, "Two steps: approve the premium, then buy");
  await glideClick(page, page.getByTestId("approve-button"));
  const buyButton = page.getByTestId("buy-button");
  await expect(buyButton).toBeEnabled({ timeout: 60000 });
  await pause(page, 900);
  await glideClick(page, buyButton);
  await expect.poll(() => coverBalance(BUYER, SERIES), { timeout: 60000 }).toBe(MAX_CLAIM);
  const holding = page.getByText(/Cover you already hold/i);
  await expect(holding).toBeVisible();
  await scrollToView(page, holding);
  await caption(page, "Cover minted — 0.01 held, claim reserved in the pool");
  await pause(page, 2400);
  await caption(page, null);
  await stop();
});

test("settle.gif — the hero: real .eml in, 9 green checks, ratio 61%", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 1 });
  await page.goto("/#/settle/0");
  await connectGuideWallet(page);
  const dropzone = page.getByTestId("eml-dropzone");
  await expect(dropzone).toBeVisible();

  const stop = await startCapture(page, "settle");
  await caption(page, "Drop the raw CRE Daily newsletter (.eml)");
  await pause(page, 1400);
  await glide(page, dropzone);
  await dropzone.dispatchEvent("dragover"); // the drop-target highlight
  await pause(page, 900);
  await page.getByTestId("eml-input").setInputFiles(FIXTURE_EML);
  await dropzone.dispatchEvent("dragleave").catch(() => {});

  // The in-browser DKIM preflight goes green check by check.
  const checks = page.locator("[data-testid^=preflight-check-]");
  await expect.poll(() => checks.count(), { timeout: 45000 }).toBeGreaterThanOrEqual(8);
  await expect(page.locator("[data-testid^=preflight-check-][data-pass=false]")).toHaveCount(0);
  await scrollToView(page, page.getByTestId("preflight-checklist"));
  await caption(page, "9 DKIM preflight checks — RSA-2048 verified in your browser");
  await pause(page, 2800); // linger on the all-green board + extracted $92.88
  await caption(page, "Record the observation on-chain");
  await glideClick(page, page.getByTestId("record-button"));
  await expect.poll(observationCount, { timeout: 60000 }).toBe(1n);
  const settleButton = page.getByTestId("settle-button");
  await expect(settleButton).toBeEnabled({ timeout: 45000 });
  await pause(page, 1100);
  await caption(page, "Settle: clamp $92.88 between the strikes");
  await glideClick(page, settleButton);
  const ratio = page.getByTestId("settle-ratio");
  await expect(ratio).toContainText("61", { timeout: 45000 });
  await scrollToView(page, ratio);
  await caption(page, "Settled — payout ratio 61%");
  await pause(page, 2600);
  await caption(page, null);
  await stop();
});

test("redeem.gif — max redeem pays 61% of the claim", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 1 });
  const before = await currencyBalance(BUYER);
  await page.goto("/#/redeem/0");
  await connectGuideWallet(page);
  await expect(page.getByTestId("redeem-amount")).toBeVisible();

  const stop = await startCapture(page, "redeem");
  await caption(page, "Burn cover, receive maxClaim × 61%");
  await pause(page, 1500); // ratio + cover balance stats
  await glideClick(page, page.getByRole("button", { name: /^Max$/ }));
  await expect(page.getByTestId("payout-preview")).toBeVisible();
  await pause(page, 1600); // “You will receive 0.0061”
  await glideClick(page, page.getByTestId("redeem-button"));
  await expect.poll(() => coverBalance(BUYER, SERIES), { timeout: 45000 }).toBe(0n);
  expect(await currencyBalance(BUYER)).toBe(before + PAYOUT);
  await caption(page, "Paid — 0.0061 WXDAI for 0.01 of cover");
  await pause(page, 2400);
  await caption(page, null);
  await stop();
});

test("sponsor-withdraw.gif — withdraw excess after settlement", async ({ page }) => {
  await installGuideWallet(page, { accountIndex: 0 });
  await page.goto("/#/sponsor");
  await connectGuideWallet(page);
  const withdrawAmount = page.getByTestId("withdraw-amount");
  await expect(withdrawAmount).toBeVisible();
  await withdrawAmount.scrollIntoViewIfNeeded();
  const poolBefore = await poolBalance();

  const stop = await startCapture(page, "sponsor-withdraw");
  await caption(page, "After settlement, unreserved capital is free");
  await pause(page, 1300);
  await slowType(page, withdrawAmount, "0.005");
  await pause(page, 800);
  await glideClick(page, page.getByTestId("withdraw-button"));
  await expect.poll(poolBalance, { timeout: 45000 }).toBe(poolBefore - parseEther("0.005"));
  await pause(page, 1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  // 0.02 + 0.00285 premium − 0.0061 payout − 0.005 withdrawn = 0.01175 free.
  await awaitStat(
    page,
    page.getByText("Pool balance", { exact: true }).locator(".."),
    "0.01175 WXDAI",
  );
  await pause(page, 1200);
  await caption(page, null);
  await stop();
});
