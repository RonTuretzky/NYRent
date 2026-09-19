import { test, expect } from "@playwright/test";
import { alignClock } from "./support/helpers";

// The historical local market must never be relabeled as the new one.
test("primary routes expose one consistent market and no market picker", async ({ page }) => {
  await alignClock(page);
  for (const route of ["/", "/insurer", "/renter", "/market-view", "/settle", "/redeem", "/docs"]) {
    await page.goto(`/#${route}`);
    await expect(page.getByTestId("market-strip")).toHaveCount(1);
    await expect(page.getByTestId("market-strip")).toContainText("Manhattan Rent Cover, Sep 2026 → Sep 2027");
    await expect(page.getByTestId("market-strip")).toContainText("demo market");
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
  await expect(page.getByTestId("renter-buy")).toHaveText("Buy 3,000 RENT");
  await expect(page.locator("main")).toContainText("$855");
  await expect(page.locator("main")).toContainText("+4.4%");
  await expect(page.getByTestId("basis-risk")).toContainText("not your own lease");
  await page.screenshot({path: ".artifacts/one-market-renter-desktop.png", fullPage: true});
  await page.getByTestId("renter-price").fill("0.5");
  await expect(page.locator("main")).toContainText("+5.5%");
  await page.getByTestId("renter-buy").click();
  await expect(page).toHaveURL(/#\/buy\?amount=3000$/);
  await expect(page.getByTestId("empty-state")).toContainText("demo preview");
  await page.goto("/#/insurer");
  await expect(page.locator("main")).toContainText("$2,850");
  await expect(page.locator("main")).toContainText("$4,000");
  await expect(page.locator("main")).toContainText("$3,150");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("+6.4%");
  await page.getByTestId("insurer-price").fill("0.5");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("+7.5%");
  await page.getByTestId("insurer-sold").fill("0");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("nothing sold");
  await page.getByTestId("insurer-sold").fill("1");
  await expect(page.getByTestId("insurer-takeaway")).toContainText("does not create a net loss");
});

test("forecast discloses clipped payout and mobile views fit", async ({ page }) => {
  await alignClock(page);
  await page.goto("/#/market-view");
  await expect(page.locator("main")).toContainText("+4.4%");
  await expect(page.locator("main")).toContainText("not E[g]");
  await expect(page.getByTestId("price-history-chart")).toBeVisible();
  await page.screenshot({path: ".artifacts/one-market-forecast-desktop.png", fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  for (const route of ["/", "/renter", "/insurer", "/market-view"]) {
    await page.goto(`/#${route}`);
    await expect(page.getByTestId("market-strip")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({path: ".artifacts/one-market-forecast-mobile.png", fullPage: true});
  await page.getByRole("button", {name: "Open menu"}).click();
  await expect(page.getByRole("dialog", {name: "Navigation menu"})).toBeVisible();
  await page.getByRole("button", {name: "For renters / insurers", exact: true}).click();
  await expect(page.getByRole("link", {name: "Renter", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Settle / redeem", exact: true}).click();
  await expect(page.getByRole("button", {name: "For renters / insurers", exact: true})).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", {name: "Settle / redeem", exact: true})).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("link", {name: "Redeem", exact: true}).click();
  await expect(page).toHaveURL(/#\/redeem$/);
  await expect(page.getByRole("dialog", {name: "Navigation menu"})).not.toBeVisible();
});
