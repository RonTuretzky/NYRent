// Journey B (creator) and Journey A (renter) up to the waiting step, through the
// real UI on the fork. Later files pick these policies up by id from state.json.
import { test, type Page } from "@playwright/test";
import { parseUnits } from "viem";
import {
  BUYER, BUYER2, CREATOR, DAY, approveAs, buyAs, chainNow, claimBalance, createAs, expect, monthBounds, monthLabel, openAs, readSeries,
  readState, remember, shot, usdcBalance, yyyymm,
} from "./support";

test.describe.configure({ mode: "serial" });

async function createViaUi(page: Page, opts: { slugLabel: string; low: string; high: string; premium: string; capacity: string; shotName?: string }) {
  const { month } = readState();
  await openAs(page, CREATOR, "/policies/new");
  await expect(page.getByRole("heading", { name: "Create a rent policy" })).toBeVisible();
  await expect(page.getByTestId("step-bar")).toContainText("Step 1 of 6");
  await page.getByTestId("policy-slug").selectOption({ label: opts.slugLabel });
  await page.getByTestId("policy-month").selectOption(month);
  await page.getByTestId("policy-low").fill(opts.low);
  await page.getByTestId("policy-high").fill(opts.high);
  await page.getByTestId("policy-premium").fill(opts.premium);
  await page.getByTestId("policy-capacity").fill(opts.capacity);
  // Worked example and both creator-side cases are on the screen before any money moves.
  const example = page.getByTestId("worked-example");
  await expect(example).toContainText("Best case for you");
  await expect(example).toContainText("Worst case for you");
  await expect(example).toContainText("No qualifying email");
  await expect(page.getByTestId("risk-notice")).toContainText("unaudited");
  await expect(page.getByTestId("risk-notice")).toContainText("not pay based on your own lease");
  await expect(page.getByTestId("key-dates")).toContainText("Claims close");
  await expect(page.getByTestId("create-blocked")).toContainText("Tick the box");
  await page.getByTestId("policy-accept").check();
  await expect(page.getByTestId("step-bar")).toContainText("Step 4 of 6");
  await expect(page.getByTestId("approve-step")).toContainText("First, approve");
  if (opts.shotName) await shot(page, opts.shotName);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approved-ok")).toBeVisible();
  await page.getByTestId("policy-create").click();
  await expect(page).toHaveURL(/policies\/\d+$/);
  await expect(page.getByTestId("policy-status")).toHaveText("On sale");
  return Number(page.url().split("/").pop());
}

test("the list starts empty with a way forward", async ({ page }) => {
  await openAs(page, null, "/policies");
  await expect(page.getByTestId("empty-state")).toContainText("No policies yet");
  await expect(page.getByRole("link", { name: "Create the first one" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Step-by-step guide" })).toBeVisible();
  await shot(page, "00-list-empty");
});

test("the guide explains both journeys and the shared step", async ({ page }) => {
  await openAs(page, null, "/policies/guide");
  await expect(page.getByRole("tabpanel").getByTestId("guide-steps")).toContainText("Approve, then buy");
  await page.getByTestId("guide-tab-creator").click();
  await expect(page).toHaveURL(/tab=creator/);
  await expect(page.getByRole("tabpanel")).toContainText("lose the whole escrow");
  await page.getByTestId("guide-tab-record").click();
  await expect(page.getByRole("tabpanel")).toContainText("Download the original email");
  const recipe = page.getByTestId("alert-recipe");
  await expect(recipe).toContainText("As-it-happens");
  await expect(recipe).toContainText("All results");
  await expect(recipe).toContainText("https://www.apartments.com/rent-market-trends/");
  await expect(page.getByRole("heading", { name: /Downloading the original email from Gmail/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /A claim versus a refund/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Getting USDC and a little ETH on Arbitrum One/ })).toBeVisible();
  await shot(page, "00-guide");
});

test("Journey B: the creator opens a policy through the UI", async ({ page }) => {
  const before = await usdcBalance(CREATOR);
  const id = await createViaUi(page, { slugLabel: "East Harlem", low: "2900", high: "3100", premium: "10", capacity: "100", shotName: "01-create-ready" });
  remember("settled", id);
  const s = await readSeries(id);
  expect(s.escrow).toBe(parseUnits("100", 6));
  expect(s.strikeLowCents).toBe(290000);
  expect(s.strikeHighCents).toBe(310000);
  expect(s.obsMonth).toBe(yyyymm(readState().month));
  expect(await usdcBalance(CREATOR)).toBe(before - parseUnits("100", 6));
  // The creator sees their controls and a share hint right away.
  await expect(page.getByTestId("creator-card")).toContainText("Share the link");
  await expect(page.getByTestId("cancel")).toBeVisible();
  await shot(page, "02-created");
});

test("Journey B: a second policy on another page (voids later)", async ({ page }) => {
  const id = await createViaUi(page, { slugLabel: "Mott Haven", low: "2800", high: "3000", premium: "10", capacity: "50" });
  remember("void", id);
  await expect(page.getByRole("heading", { name: /Mott Haven/ })).toBeVisible();
});

test("Journey A: a renter buys protection (approve, then buy; a double-click sends once)", async ({ page }) => {
  const { ids } = readState();
  const id = ids.settled;
  const s = await readSeries(id);
  const before = await usdcBalance(BUYER);
  await openAs(page, BUYER, `/policies/${id}`);
  await expect(page.getByTestId("status-next")).toContainText("Buy protection until the policy month starts");
  await expect(page.getByTestId("step-bar")).toContainText("Step 3 of 6");
  await page.getByTestId("buy-amount").fill("20");
  await expect(page.getByText("You pay now (premium)").locator("..")).toContainText("2 USDC");
  const example = page.getByTestId("worked-example");
  await expect(example).toContainText(`${monthLabel(s.obsMonth)} headline rent reaches $3100.00 or more, you get 20 USDC`);
  await expect(example).toContainText("$3000.00, you get 10 USDC");
  await expect(example).toContainText("at or below $2900.00, you get $0");
  await expect(example).toContainText("2 USDC premium back. That is a refund, not a claim");
  await expect(page.getByTestId("risk-notice")).toContainText("not insurance");
  await expect(page.getByTestId("key-dates")).toContainText("Sales close");
  await shot(page, "03-buy-ready");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approved-ok")).toBeVisible();
  await expect(page.getByTestId("step-bar")).toContainText("Step 4 of 6");
  await page.getByTestId("buy-submit").dblclick();
  await expect(page.getByTestId("bought-ok")).toBeVisible();
  await expect(page.getByTestId("claim-card")).toContainText("20 USDC");
  await expect(page.getByTestId("step-bar")).toContainText("Step 5 of 6");
  await shot(page, "04-bought");
  expect(await claimBalance(BUYER, id)).toBe(parseUnits("20", 6));
  expect((await readSeries(id)).sold).toBe(parseUnits("20", 6));
  expect(await usdcBalance(BUYER)).toBe(before - parseUnits("2", 6));
});

test("more buyers and scratch policies for the later files", async () => {
  const { ids, month } = readState();
  const ym = yyyymm(month);
  const { start, end } = monthBounds(ym);
  // Exact approvals only: a leftover allowance would hide the approve step the later files test.
  await approveAs(BUYER2, parseUnits("3.75", 6));
  await buyAs(BUYER2, ids.settled, parseUnits("30", 6), parseUnits("3", 6));
  await approveAs(BUYER, parseUnits("1", 6));
  await buyAs(BUYER, ids.void, parseUnits("10", 6), parseUnits("1", 6));
  await buyAs(BUYER2, ids.void, parseUnits("5", 6), parseUnits("0.5", 6));
  const redeemEnd = end + 1n + 7n * DAY + 30n * DAY;
  remember("unsold", await createAs(CREATOR, { slug: "east-harlem-new-york-ny", obsMonth: ym, low: 290000, high: 310000, bps: 1000, saleEnd: start, redeemEnd, capacity: parseUnits("20", 6) }));
  const soldOut = await createAs(CREATOR, { slug: "mott-haven-bronx-ny", obsMonth: ym, low: 280000, high: 300000, bps: 500, saleEnd: start, redeemEnd, capacity: parseUnits("5", 6) });
  await buyAs(BUYER2, soldOut, parseUnits("5", 6), parseUnits("0.25", 6));
  remember("soldOut", soldOut);
  expect(await chainNow()).toBeLessThan(start);
});

test("the list reflects every policy with a status and what happens next", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, BUYER, "/policies");
  await expect(page.getByTestId(`policy-${ids.settled}`)).toContainText("On sale");
  await expect(page.getByTestId(`policy-${ids.soldOut}`)).toContainText("Sold out");
  await expect(page.getByTestId(`policy-${ids.settled}`).getByTestId("policy-status")).toBeVisible();
  await expect(page.getByTestId(`policy-${ids.settled}`)).toContainText("Still available");
  await shot(page, "05-list");
});
