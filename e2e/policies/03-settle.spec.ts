// Time travel: the sale closes under an open page, the month's alert is
// recorded from a test-key-signed .eml, the policy settles at a real payout,
// the other voids, and both sides collect. Forward-only warps, in order.
import { test } from "@playwright/test";
import { parseUnits } from "viem";
import {
  BUYER, BUYER2, CREATOR, DAY, POOR, chainNow, claimBalance, earliest, ensureApproved, expect, makeEml, monthBounds, monthLabel, openAs, readSeries, readState,
  setPausedAs, shot, usdcBalance, warpTo, yyyymm,
} from "./support";

test.describe.configure({ mode: "serial" });
const WAD = 10n ** 18n;

test("36 hours before the month: the create page defaults to a later month and warns about the short one", async ({ browser }) => {
  const { month } = readState();
  const { start } = monthBounds(yyyymm(month));
  await warpTo(start - 36n * 3600n);
  const page = await (await browser.newContext()).newPage();
  await openAs(page, CREATOR, "/policies/new");
  const select = page.getByTestId("policy-month");
  await expect(select).not.toHaveValue(month);
  await expect(page.getByTestId("short-sale-warning")).toHaveCount(0);
  await select.selectOption(month);
  const warning = page.getByTestId("short-sale-warning");
  await expect(warning).toContainText("Few people may be able to buy");
  // The warning and the key dates quote the same remaining time (≤ 36 h: the
  // run may already start closer to the month than the warp above).
  const remaining = /close (in [^.]+)\./.exec(await warning.innerText())?.[1];
  expect(remaining, "warning quotes the remaining time").toBeTruthy();
  expect(remaining).toMatch(/hour|minute/);
  await expect(page.getByTestId("key-dates")).toContainText(`(${remaining})`);
  await shot(page, "05b-short-sale-warning");
});

test("the sale closes while a page is open: plain copy, nothing charged", async ({ page }) => {
  const { ids, month } = readState();
  const { start } = monthBounds(yyyymm(month));
  await setPausedAs(CREATOR, ids.settled, false); // whatever 02 left behind
  const before = await usdcBalance(BUYER);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("1");
  await ensureApproved(page);
  await warpTo(start);
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("tx-reverted")).toContainText("Sales for this policy closed while you were on the page");
  await shot(page, "06-sale-closed-under-page");
  expect(await usdcBalance(BUYER)).toBe(before);
  // A fresh visit (browser clock re-aligned to the chain) shows the closed state.
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await expect(page.getByTestId("policy-status")).toHaveText("Awaiting rent data");
  await expect(page.getByTestId("awaiting-data")).toContainText("Record this month's Google Alert");
  await expect(page.getByTestId("buy-card")).toHaveCount(0);
});

test("shared step: anyone records the month's alert; a second copy is refused; a later email cannot replace it", async ({ page, browser }) => {
  const { month } = readState();
  const ym = yyyymm(month);
  const { start } = monthBounds(ym);
  const t = start + DAY + DAY / 2n;
  await warpTo(t + 3600n);
  const good = makeEml("good", { slug: "east-harlem-new-york-ny", label: "East Harlem", dollars: "3,010", month, t });
  await openAs(page, BUYER2, "/policies/submit");
  // A rent nobody has a policy on needs a separate "publish anyway" acknowledgement.
  await page.getByTestId("alert-file").setInputFiles(makeEml("orphan", { slug: "rego-park-queens-ny", label: "Rego Park", dollars: "2,301", month, t }));
  await expect(page.getByTestId("no-matching-policies")).toBeVisible();
  await page.getByTestId("alert-consent").check();
  await expect(page.getByTestId("alert-submit")).toBeDisabled();
  await page.getByTestId("publish-anyway").check();
  await expect(page.getByTestId("alert-submit")).toBeEnabled();
  await shot(page, "07a-publish-anyway");

  await page.getByTestId("alert-file").setInputFiles(good);
  await expect(page.getByTestId("step-bar")).toContainText("Step 3 of 5");
  await expect(page.getByTestId("matching-policies").getByTestId(`matching-policy-${readState().ids.settled}`)).toBeVisible();
  const preview = page.getByTestId("preview-card");
  await expect(preview).toContainText(`East Harlem, ${monthLabel(ym)}`);
  await expect(preview).toContainText("$3010.00/mo");
  await expect(page.getByTestId("publish-warning")).toContainText("permanently");
  await expect(page.getByTestId("alert-submit")).toBeDisabled();
  await page.getByTestId("alert-consent").check();
  await expect(page.getByTestId("step-bar")).toContainText("Step 4 of 5");
  await shot(page, "07-record-ready");
  await page.getByTestId("alert-submit").click();
  await expect(page.getByTestId("recorded-ok")).toContainText("Recorded");
  await expect(page.getByTestId("step-bar")).toContainText("All 5 steps done");
  await shot(page, "08-recorded");
  const [obsT, cents] = await earliest("east-harlem-new-york-ny", ym);
  expect(obsT).toBe(t);
  expect(cents).toBe(301000);

  // Coming back later (fresh visit) with the same file: told it is already recorded, no publish button.
  const again = await (await browser.newContext()).newPage();
  await openAs(again, BUYER2, "/policies/submit");
  await expect(again.getByTestId("step-bar")).toContainText("Step 1 of 5");
  await again.getByTestId("alert-file").setInputFiles(good);
  await expect(again.getByTestId("already-recorded")).toContainText("already recorded");
  await expect(again.getByTestId("alert-submit")).toHaveCount(0);
  await shot(again, "09-already-recorded");

  const later = makeEml("later", { slug: "east-harlem-new-york-ny", label: "East Harlem", dollars: "3,500", month, t: t + 1800n });
  await again.getByTestId("alert-file").setInputFiles(later);
  await again.getByTestId("alert-consent").check();
  await again.getByTestId("alert-submit").click();
  await expect(again.getByTestId("recorded-ok")).toContainText("earlier-signed email");
  expect((await earliest("east-harlem-new-york-ny", ym))[1]).toBe(301000);
});

test("Journey A, last step: finalize and claim a settled payout", async ({ page, browser }) => {
  const { ids, month } = readState();
  const s = await readSeries(ids.settled);
  await warpTo(s.finalizeAt + 3600n);
  const held = await claimBalance(BUYER, ids.settled);
  const before = await usdcBalance(BUYER);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await expect(page.getByTestId("policy-status")).toHaveText("Ready to finalize");
  await expect(page.getByTestId("step-bar")).toContainText("Step 6 of 6");
  await expect(page.getByTestId("claim-card")).toContainText("Nobody has finalized yet");
  await expect(page.getByText("Earliest signed rent so far").locator("..")).toContainText("$3010.00/mo");
  await shot(page, "10-ready-to-finalize");
  await page.getByTestId("redeem").click();
  await expect(page.getByTestId("policy-status")).toHaveText("Settled");
  await expect(page.getByText("Final payout").locator("..")).toContainText("55% of each claim");
  const expected = (held * (WAD * 55n / 100n)) / WAD;
  const ok = page.getByTestId("claimed-ok");
  await expect(ok).toContainText(`You received ${Number(expected) / 1e6} USDC as a claim on the recorded rent`);
  await expect(ok).toContainText("done for you");
  await expect(page.getByTestId("step-bar")).toContainText("All 6 steps done");
  await expect(page.getByTestId("nothing-to-claim")).toHaveCount(0);
  await expect(page.getByTestId("redeem")).toHaveCount(0);
  expect(await usdcBalance(BUYER)).toBe(before + expected);
  expect(await claimBalance(BUYER, ids.settled)).toBe(0n);
  await shot(page, "11-settled-claimed");

  // The second renter claims against the settled ratio.
  const held2 = await claimBalance(BUYER2, ids.settled);
  const before2 = await usdcBalance(BUYER2);
  const page2 = await (await browser.newContext()).newPage(); // a second actor needs its own context: wagmi syncs its connection across tabs of one context
  await openAs(page2, BUYER2, `/policies/${ids.settled}`);
  await expect(page2.getByTestId("claim-card")).toContainText("pays 55% of each claim");
  await expect(page2.getByTestId("redeem")).toContainText(`Claim ${Number(held2 * 55n / 100n) / 1e6} USDC`);
  await page2.getByTestId("redeem").click();
  await expect.poll(() => usdcBalance(BUYER2)).toBe(before2 + held2 * 55n / 100n);
  void month;
});

test("void policy: the premium comes back as a refund", async ({ page }) => {
  const { ids } = readState();
  const before = await usdcBalance(BUYER);
  await openAs(page, BUYER, `/policies/${ids.void}`);
  await expect(page.getByTestId("claim-card")).toContainText("Finalize and claim");
  await page.getByTestId("redeem").click();
  await expect(page.getByTestId("policy-status")).toHaveText("Void: premiums refundable");
  await expect(page.getByTestId("status-next")).toContainText("buyers take their premium back");
  await expect(page.getByTestId("claimed-ok")).toContainText("You received 1 USDC as a refund of your premium");
  await expect(page.getByTestId("claimed-ok")).toContainText("not a payout");
  expect(await usdcBalance(BUYER)).toBe(before + parseUnits("1", 6));
  await shot(page, "12-void-refunded");
});

test("nothing to claim is said plainly", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, POOR, `/policies/${ids.settled}`);
  await expect(page.getByTestId("nothing-to-claim")).toContainText("holds no protection");
  await expect(page.getByTestId("redeem")).toHaveCount(0);
  await expect(page.getByTestId("step-bar")).toContainText("Stopped here");
  await expect(page.getByTestId("step-bar")).toContainText("holds no protection");
});

test("after claims close: a late holder is told, and the creator withdraws what remains (Journey B, last step)", async ({ page, browser }) => {
  const { ids } = readState();
  const s = await readSeries(ids.settled);
  await warpTo(s.redeemEnd + 3600n);
  await openAs(page, BUYER2, `/policies/${ids.void}`);
  await expect(page.getByTestId("policy-status")).toHaveText("Void: premiums refundable");
  await expect(page.getByTestId("claim-timing")).toContainText("Claims closed");
  await expect(page.getByTestId("redeem")).toHaveCount(0);
  await expect(page.getByTestId("step-bar")).toContainText("claim window closed");
  await shot(page, "13-claims-closed");

  const fresh = await readSeries(ids.settled);
  const residual = fresh.escrow + fresh.premiumsAccrued - fresh.paidOut;
  const before = await usdcBalance(CREATOR);
  const page2 = await (await browser.newContext()).newPage();
  await openAs(page2, CREATOR, `/policies/${ids.settled}`);
  await expect(page2.getByTestId("creator-card")).toContainText("is yours to withdraw");
  await expect(page2.getByTestId("add-escrow-card")).toHaveCount(0); // sales closed long ago
  await expect(page2.getByTestId("withdraw")).toContainText(`Withdraw ${Number(residual) / 1e6} USDC`);
  await page2.getByTestId("withdraw").click();
  await expect(page2.getByTestId("creator-card")).toContainText("You withdrew the remaining funds");
  expect(await usdcBalance(CREATOR)).toBe(before + residual);
  await shot(page2, "14-creator-withdrew");
  expect(await chainNow()).toBeGreaterThan(s.redeemEnd);
});
