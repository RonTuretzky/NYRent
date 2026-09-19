import { test, expect } from "@playwright/test";
import { alignClock } from "./support/helpers";

// The historical local market must never be relabeled as the new one.
test("primary routes expose one consistent market and no market picker", async ({ page }) => {
  await alignClock(page);
  for (const route of ["/", "/insurer", "/renter", "/market-view", "/settle", "/redeem", "/docs"]) {
    await page.goto(`/#${route}`);
    await expect(page.getByTestId("market-strip")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/\bdemo\b/i);
    await expect(page.locator("main")).not.toContainText(/\bseries\b/i);
    await expect(page.getByRole("navigation", {name: "Main navigation"})).not.toContainText(/Markets|Underwrite|Help me choose/);
    await expect(page.locator("h1, [data-testid=empty-state]").first()).toBeVisible();
  }
  await expect(page.getByText("Bankr automation is dormant.", {exact: false})).toBeVisible();
});

test("renter and insurer calculators meet acceptance numbers and move consistently", async ({ page }) => {
  await alignClock(page);
  await page.goto("/#/renter");
  await expect(page.getByTestId("renter-price")).toHaveValue("0.285");
  await expect(page.getByTestId("renter-buy")).toHaveText("Buy & Sell");
  await expect(page.locator("main")).toContainText("$855");
  await expect(page.locator("main")).toContainText("+4.4%");
  await expect(page.getByTestId("basis-risk")).toContainText("not your own lease");
  await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$1,200");
  await page.getByRole("button", { name: "+3%", exact: true }).click();
  await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$0");
  await page.getByRole("button", { name: "+8%", exact: true }).click();
  await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$3,000");
  await page.getByTestId("renter-growth").fill("5");
  await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$1,200");
  await page.screenshot({path: ".artifacts/one-market-renter-desktop.png", fullPage: true});
  await page.getByTestId("renter-price").fill("0.5");
  await expect(page.locator("main")).toContainText("+5.5%");
  await page.getByTestId("renter-buy").click();
  await expect(page).toHaveURL(/#\/buy\?amount=3000$/);
  await expect(page.getByTestId("empty-state")).toContainText("not configured for transactions");
  await page.goto("/#/insurer");
  await expect(page.locator("main")).toContainText("$2,850");
  await expect(page.locator("main")).not.toContainText(/yield/i);
  await expect(page.locator("main")).toContainText("$7,150");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("+4.4%");
  await page.getByTestId("insurer-price").fill("0.5");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("+5.5%");
  await page.getByTestId("insurer-sold").fill("0");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("nothing sold");
  await page.getByTestId("insurer-sold").fill("1");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("+5.5%");
  await page.getByTestId("insurer-price").fill("1");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("does not create a net loss");
});

test("forecast discloses clipped payout and mobile views fit", async ({ page }) => {
  await alignClock(page);
  await page.goto("/#/market-view");
  await expect(page.locator("main")).toContainText("Price unavailable");
  await expect(page.locator("main")).toContainText("not E[g]");
  await expect(page.locator("main")).toContainText("Price history is unavailable");
  await page.screenshot({path: ".artifacts/one-market-forecast-desktop.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  for (const route of ["/", "/renter", "/insurer", "/market-view"]) {
    await page.goto(`/#${route}`);
    await expect(page.getByTestId("market-strip")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({path: ".artifacts/one-market-forecast-mobile.png", fullPage: true});
  await page.getByRole("button", {name: "Open menu"}).click();
  await expect(page.getByRole("dialog", {name: "Navigation menu"})).toBeVisible();
  await page.getByRole("button", {name: "For renters / insurers", exact: true}).click();
  await expect(page.getByRole("link", {name: "Renter", exact: true})).toBeVisible();
  await expect(page.getByRole("link", {name: "Buy & Sell", exact: true})).toBeVisible();
  await page.getByRole("link", {name: "Redeem RENT", exact: true}).click();
  await expect(page).toHaveURL(/#\/redeem$/);
  await expect(page.getByRole("dialog", {name: "Navigation menu"})).not.toBeVisible();
});
