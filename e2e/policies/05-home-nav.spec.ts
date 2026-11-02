// The home page, the nav into every policy route (desktop dropdown and mobile
// menu), retired office-market routes redirecting home, and no horizontal
// scroll on home at 360/390/768/1280. Runs last, so the preview has policies.
import { test, type Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, openAs, readState, shot } from "./support";

test.describe.configure({ mode: "serial" });

const POLICY_ROUTES: [label: string, hash: RegExp, heading: RegExp][] = [
  ["Browse policies", /#\/policies$/, /Neighborhood rent policies/],
  ["Create a policy", /#\/policies\/new$/, /Create a rent policy/],
  ["Record a rent", /#\/policies\/submit$/, /Record a month's rent/],
  ["Guide", /#\/policies\/guide$/, /How neighborhood policies work/],
];

async function expectHome(page: Page) {
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("rent climbs");
}

test("home renders: hero, roles, newest policies from the pools, how it settles, risks", async ({ page }) => {
  await openAs(page, null, "/");
  await expectHome(page);
  await expect(page).toHaveTitle(/Neighborhood rent policies/);
  await expect(page.getByTestId("home-pitch")).toContainText("Arbitrum One");
  await expect(page.getByTestId("home-browse")).toHaveAttribute("href", "#/policies");
  await expect(page.getByTestId("home-create")).toHaveAttribute("href", "#/policies/new");
  for (const tab of ["renter", "creator", "record"]) {
    await expect(page.getByTestId(`home-role-${tab}`)).toHaveAttribute("href", `#/policies/guide?tab=${tab}`);
  }
  const preview = page.getByTestId("home-preview");
  await expect(preview.locator("li")).toHaveCount(3);
  await expect(preview.getByTestId("policy-status").first()).toBeVisible();
  await expect(page.getByTestId("home-settles")).toContainText("Earliest in the month wins");
  await expect(page.getByTestId("home-settles")).toContainText("No email means a refund");
  for (const word of ["unaudited", "immutable", "not insurance", "does not pay based on your own lease"]) {
    await expect(page.getByTestId("home-risks")).toContainText(word);
  }
  await page.getByTestId("home-role-creator").click();
  await expect(page).toHaveURL(/tab=creator/);
  await expect(page.getByTestId("guide-tab-creator")).toHaveAttribute("aria-selected", "true");
});

test("desktop nav: the Policies menu reaches every policy route, and Home comes back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAs(page, null, "/");
  const nav = page.getByRole("navigation", { name: "Main navigation" }).first();
  for (const [label, hash, heading] of POLICY_ROUTES) {
    await nav.getByTestId("nav-group-policies").click();
    await nav.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(hash);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    await expect(nav.getByTestId("nav-group-policies")).toHaveClass(/font-bold/);
  }
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await expectHome(page);
});

test("mobile nav: the menu lists every policy route and closes on navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, null, "/");
  for (const [label, hash, heading] of POLICY_ROUTES) {
    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.getByRole("dialog", { name: "Navigation menu" });
    await menu.getByRole("link", { name: label, exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(page).toHaveURL(hash);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
  }
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("link", { name: "Home", exact: true }).click();
  await expectHome(page);
});

test("retired office-market routes redirect to the home page", async ({ page }) => {
  await openAs(page, null, "/");
  for (const old of ["/buy", "/trade", "/redeem", "/redeem/0", "/story", "/story/2", "/markets", "/market/1", "/create", "/insurer", "/renter",
    "/market-view", "/choose", "/settle", "/settle/0", "/legacy/home", "/underwrite", "/sponsor", "/docs", "/docs/bankr", "/nope"]) {
    await page.goto(`/#${old}`);
    await expectHome(page);
  }
});

test("no horizontal scroll on home at 360, 390, 768 and 1280", async ({ browser }) => {
  void readState();
  for (const width of [360, 390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await openAs(page, null, "/");
    await expect(page.getByTestId("home-preview").locator("li").first()).toBeVisible();
    await expect(page.getByTestId("loading-skeleton")).toHaveCount(0, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await expectNoHorizontalScroll(page);
    await shot(page, `home-${width}`);
    await context.close();
  }
});
