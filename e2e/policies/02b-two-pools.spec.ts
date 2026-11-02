// V2 rules in the browser (sales into the current month, the sales-close
// control, sales stopping once a rent is recorded). Runs before
// 03-settle.spec.ts warps the clock.
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { parseUnits } from "viem";
import {
  ART_DIR, BUYER, BUYER2, CREATOR, DAY, chainNow, claimBalance, createAs, ensureApproved, expect, makeEml, monthBounds, openAs, readSeries, readState,
  recordAs, remember, shot, yyyymm,
} from "./support";

test.describe.configure({ mode: "serial" });

const KEW = { slug: "kew-gardens-queens-ny", label: "Kew Gardens" };

/** The month the fork clock is in, as YYYY-MM and its bounds. */
async function currentMonth() {
  const d = new Date(Number(await chainNow()) * 1000);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { month, ...monthBounds(yyyymm(month)) };
}

/** The current month is only offered while its last day has not started. */
async function currentMonthOpen(): Promise<boolean> {
  const { end } = await currentMonth();
  return (await chainNow()) < end + 1n - DAY;
}

async function saleCloseChoices(page: Page) {
  const select = page.getByTestId("policy-sale-close");
  const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  const out: { id: string; at: bigint }[] = [];
  for (const id of values) {
    await select.selectOption(id);
    const at = await page.getByTestId("sale-close-at").getAttribute("data-at");
    out.push({ id, at: BigInt(at ?? "0") });
  }
  return out;
}

test("sale-close options stay inside the month: current month from now, future month from its start", async ({ page }) => {
  test.skip(!(await currentMonthOpen()), "the current month's last day has started: it is not offered");
  const cur = await currentMonth();
  const { month: next } = readState();
  const nextBounds = monthBounds(yyyymm(next));
  await openAs(page, CREATOR, "/policies/new");
  await expect(page.getByTestId("policy-month").locator(`option[value="${cur.month}"]`)).toContainText("(this month)");
  // The in-month warning only appears once sales would run past the month start.
  await page.getByTestId("policy-month").selectOption(cur.month);
  await expect(page.getByTestId("sale-close-explainer")).toContainText("buy knowing the rent");
  await expect(page.getByTestId("sale-close-explainer")).toContainText("stop automatically as soon as a rent is recorded");
  await expect(page.getByTestId("sale-close-explainer")).toContainText("pause sales");

  await page.getByTestId("policy-month").selectOption(next);
  await expect(page.getByTestId("policy-sale-close")).toHaveValue("start");
  await expect(page.getByTestId("sale-close-explainer")).toHaveCount(0);
  const future = await saleCloseChoices(page);
  expect(future.map((o) => o.id)).toEqual(["start", "1d", "3d", "7d", "end"]);
  expect(future[0].at).toBe(nextBounds.start);
  expect(future[4].at).toBe(nextBounds.end);
  for (const o of future) expect(o.at, o.id).toBeLessThanOrEqual(nextBounds.end);

  await page.getByTestId("policy-month").selectOption(cur.month);
  await expect(page.getByTestId("policy-sale-close")).toHaveValue("3d");
  const now = await chainNow();
  const current = await saleCloseChoices(page);
  expect(current.map((o) => o.id)).toContain("end");
  expect(current.map((o) => o.id)).not.toContain("start");
  for (const o of current) {
    expect(o.at, `${o.id} after now`).toBeGreaterThan(now);
    expect(o.at, `${o.id} at most month end`).toBeLessThanOrEqual(cur.end);
  }
  expect(current.find((o) => o.id === "end")?.at).toBe(cur.end);
  // Claims open two days after the month (V2 grace).
  await expect(page.getByTestId("key-dates")).toContainText("Two days after the month ends");
  await shot(page, "15-sale-close-options");
});

test("current month: a creator opens a policy that sells into the month, and a renter buys", async ({ page, browser }) => {
  test.skip(!(await currentMonthOpen()), "the current month's last day has started: it is not offered");
  const cur = await currentMonth();
  await openAs(page, CREATOR, "/policies/new");
  await page.getByTestId("policy-slug").selectOption({ label: KEW.label });
  await page.getByTestId("policy-month").selectOption(cur.month);
  await expect(page.getByTestId("policy-sale-close")).toHaveValue("3d");
  await page.getByTestId("policy-low").fill("2000");
  await page.getByTestId("policy-high").fill("2600");
  await page.getByTestId("policy-premium").fill("10");
  await page.getByTestId("policy-capacity").fill("50");
  await page.getByTestId("policy-accept").check();
  await ensureApproved(page, "policy-create");
  const before = await chainNow();
  await page.getByTestId("policy-create").click();
  await expect(page).toHaveURL(/policies\/\d+$/);
  const id = Number(page.url().split("/").pop());
  remember("current", id);
  const s = await readSeries(id);
  expect(s.obsMonth).toBe(yyyymm(cur.month));
  expect(s.saleEnd).toBeGreaterThan(before + 2n * DAY);
  expect(s.saleEnd).toBeLessThanOrEqual(cur.end);
  expect(s.finalizeAt).toBe(cur.end + 1n + 2n * DAY);
  await expect(page.getByTestId("policy-status")).toHaveText("On sale");
  await expect(page.getByTestId("status-next")).toContainText("creator chose");

  const renter = await (await browser.newContext()).newPage();
  await openAs(renter, BUYER, `/policies/${id}`);
  await expect(renter.getByTestId("key-dates")).toContainText("Sales also stop as soon as the month's rent is recorded");
  await renter.getByTestId("buy-amount").fill("10");
  await ensureApproved(renter);
  await renter.getByTestId("buy-submit").click();
  await expect(renter.getByTestId("bought-ok")).toContainText("You bought 10 USDC of protection");
  expect(await claimBalance(BUYER, id)).toBe(parseUnits("10", 6));
  await shot(renter, "16-current-month-bought");
});

test("a recorded rent stops sales: a buy racing the record gets plain copy; the page, creator and create form follow", async ({ page, browser }) => {
  test.skip(!(await currentMonthOpen()), "the current month's last day has started: it is not offered");
  const cur = await currentMonth();
  const id = readState().ids.current;
  await openAs(page, BUYER2, `/policies/${id}`);
  await page.getByTestId("buy-amount").fill("5");
  await ensureApproved(page);
  const before = await claimBalance(BUYER2, id);

  // Someone records this month's alert while the renter's page is open.
  const t = (await chainNow()) - 60n;
  makeEml("current-month", { ...KEW, dollars: "2,400", month: cur.month, t, dumpCanon: true });
  await recordAs(BUYER, path.join(ART_DIR, "current-month"));
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("tx-reverted")).toContainText("This month's rent is already recorded, so sales are closed.");
  expect(await claimBalance(BUYER2, id)).toBe(before);
  await shot(page, "17-rent-recorded-race");

  // A fresh visit shows the closed state, with no buy card.
  await openAs(page, BUYER2, `/policies/${id}`);
  await expect(page.getByTestId("policy-status")).toHaveText("Rent recorded");
  await expect(page.getByTestId("sales-stopped-recorded")).toContainText("This month's rent is already recorded, so sales are closed.");
  await expect(page.getByTestId("buy-card")).toHaveCount(0);

  // The creator can no longer add escrow or pause (sales are over).
  const creator = await (await browser.newContext()).newPage();
  await openAs(creator, CREATOR, `/policies/${id}`);
  await expect(creator.getByTestId("creator-card")).toBeVisible();
  await expect(creator.getByTestId("add-escrow-card")).toHaveCount(0);
  await expect(creator.getByTestId("pause")).toHaveCount(0);

  // And the create form refuses that page and month up front.
  await openAs(creator, CREATOR, "/policies/new");
  await creator.getByTestId("policy-slug").selectOption({ label: KEW.label });
  await creator.getByTestId("policy-month").selectOption(cur.month);
  await expect(creator.getByTestId("form-errors")).toContainText("already recorded");
});

