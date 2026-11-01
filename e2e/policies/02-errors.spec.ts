// Every error path the UI can reach while sales are still open. Nothing here
// warps the chain clock; 03-settle.spec.ts owns the time travel.
import fs from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { connectWallet } from "../support/helpers";
import { parseUnits } from "viem";
import {
  ART_DIR, BROKE, BUYER, BUYER2, CREATOR, CREDAILY_EML, DAY, POOR, approveAs, blockRpc, buyAs, ensureApproved, claimBalance, expect, fundUsdc, makeEml, monthBounds, openAs,
  readSeries, readState, rejectNextSend, rpc, setPausedAs, shot, usdcBalance, yyyymm,
} from "./support";

test.describe.configure({ mode: "serial" });

const noHex = async (page: Page, testId: string) => {
  const text = (await page.getByTestId(testId).innerText()).toLowerCase();
  expect(text, `raw hex leaked: ${text}`).not.toMatch(/0x[0-9a-f]{8}/);
  expect(text).not.toMatch(/reverted with/);
};

test("wallet not connected: a connect button with a reason", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, null, `/policies/${ids.settled}`);
  await expect(page.getByTestId("wallet-gate-connect")).toContainText("Connect a wallet to pay the premium");
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
  await expect(page.getByTestId("worked-example")).toBeVisible();
  await shot(page, "e-not-connected");
});

test("wrong network: an inline switch button fixes it", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, BUYER, `/policies/${ids.settled}`, { walletChainId: 100 });
  const gate = page.getByTestId("wallet-gate-network");
  await expect(gate).toContainText("Policies live on Arbitrum One");
  await expect(page.getByTestId("wrong-network-banner")).toContainText("Arbitrum One");
  await expect(page.getByTestId("chain-switcher").first()).toHaveValue("42161");
  await shot(page, "e-wrong-network");
  await page.getByTestId("switch-network").click();
  await expect(gate).toBeHidden();
  await expect(page.getByTestId("wrong-network-banner")).toBeHidden();
  await expect(page.getByTestId("approve-step").or(page.getByTestId("buy-submit"))).toBeVisible();
});

test("no USDC at all, then not enough USDC", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, POOR, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("20");
  await expect(page.getByTestId("no-funds")).toContainText("You have no USDC in this wallet");
  await expect(page.getByTestId("no-funds")).toContainText("How to get USDC on Arbitrum One");
  await shot(page, "e-no-usdc");
  await fundUsdc(POOR, parseUnits("1", 6));
  await expect(page.getByTestId("no-funds")).toContainText("You need 1 USDC more", { timeout: 40000 });
  await expect(page.getByTestId("no-funds")).toContainText("this wallet holds 1 USDC");
});

test("no ETH for the network fee", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, BROKE, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("20");
  await expect(page.getByTestId("no-gas")).toContainText("no ETH on Arbitrum One");
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  await shot(page, "e-no-gas");
});

test("every invalid buy amount is explained before any button appears", async ({ page }) => {
  const { ids } = readState();
  const available = (await readSeries(ids.settled)).escrow - (await readSeries(ids.settled)).sold;
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  const amount = page.getByTestId("buy-amount");
  const cases: [string, RegExp][] = [
    ["", /Enter a payout amount/],
    ["abc", /digits only/],
    ["-5", /digits only/],
    ["0", /more than zero/],
    ["1.1234567", /at most 6 decimal places/],
    ["0.000009", /rounds to zero/],
    ["1000000", new RegExp(`Only ${Number(available) / 1e6} USDC is still available`)],
  ];
  for (const [value, re] of cases) {
    await amount.fill(value);
    await expect(page.getByTestId("buy-validation"), value).toContainText(re);
    await expect(page.getByTestId("buy-submit")).toHaveCount(0);
    await expect(page.getByTestId("approve-button")).toHaveCount(0);
  }
  await shot(page, "e-buy-validation");
});

test("an escrow above the wallet balance is flagged before the checkbox and can be fixed in one tap", async ({ page }) => {
  await openAs(page, BUYER2, "/policies/new");
  await page.getByTestId("policy-capacity").fill("100000");
  await expect(page.getByTestId("wallet-balance")).toContainText("USDC");
  await page.getByTestId("use-balance").click();
  await expect(page.getByTestId("escrow-over-balance")).toHaveCount(0);
  await expect(page.getByTestId("form-errors")).toHaveCount(0);
  await expect(page.getByTestId("policy-capacity")).not.toHaveValue("100000");
});

test("a neighborhood with no October rent never keeps the previous strikes", async ({ page }) => {
  await openAs(page, CREATOR, "/policies/new");
  await page.getByTestId("policy-slug").selectOption({ label: "Financial District" });
  await expect(page.getByTestId("policy-low")).toHaveValue("");
  await expect(page.getByTestId("policy-high")).toHaveValue("");
  await expect(page.getByTestId("form-errors")).toBeVisible();
});

test("every invalid create input is explained and blocks the button", async ({ page }) => {
  await openAs(page, CREATOR, "/policies/new");
  const set = async (id: string, v: string) => page.getByTestId(id).fill(v);
  await set("policy-low", "3200");
  await set("policy-high", "3100");
  await expect(page.getByTestId("form-errors")).toContainText("full-payout rent must be above the starting rent");
  await set("policy-low", "abc");
  await expect(page.getByTestId("form-errors")).toContainText("starting rent in dollars");
  await set("policy-low", "2900");
  await set("policy-premium", "150");
  await expect(page.getByTestId("form-errors")).toContainText("cannot be more than 100%");
  await set("policy-premium", "10");
  await set("policy-capacity", "0");
  await expect(page.getByTestId("form-errors")).toContainText("escrow must be more than zero");
  await set("policy-capacity", "1.1234567");
  await expect(page.getByTestId("form-errors")).toContainText("at most 6 decimal places");
  await set("policy-capacity", "-1");
  await expect(page.getByTestId("form-errors")).toContainText("digits only");
  await page.getByTestId("policy-accept").check();
  await expect(page.getByTestId("create-blocked")).toContainText("Fix the terms");
  await expect(page.getByTestId("policy-create")).toHaveCount(0);
  await shot(page, "e-create-validation");
  await set("policy-capacity", "10");
  await expect(page.getByTestId("form-errors")).toHaveCount(0);
  // A typed percent sign is not doubled, 0% is stated plainly, and a premium that rounds to zero is refused.
  await set("policy-premium", "10%");
  await expect(page.getByTestId("worked-example")).toContainText("(10% of their maximum payout)");
  await expect(page.getByTestId("worked-example")).not.toContainText("%%");
  await set("policy-premium", "0");
  await expect(page.getByTestId("zero-premium")).toContainText("buyers pay nothing and you earn nothing");
  await expect(page.getByTestId("form-errors")).toHaveCount(0);
  await set("policy-premium", "1");
  await set("policy-capacity", "0.00001"); // 10 units at 1% = 0.1 unit, which the contract rounds to zero
  await expect(page.getByTestId("form-errors")).toContainText("rounds to zero");
  await expect(page.getByTestId("policy-create")).toHaveCount(0);
});

test("a pending transaction survives a reload and is not offered twice", async ({ page }) => {
  const { ids } = readState();
  const held = await claimBalance(BUYER, ids.settled);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("2");
  await ensureApproved(page);
  await rpc("anvil_setAutomine", [false]);
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("tx-pending")).toBeVisible();
  await page.reload();
  await connectWallet(page); // the shim wallet starts disconnected after a reload
  const resumed = page.getByTestId("resumed-tx");
  await expect(resumed).toContainText("You have a transaction in progress: Buy protection");
  await expect(page.getByTestId("held-back")).toBeVisible();
  await expect(page.getByTestId("buy-submit")).toHaveCount(0);
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  await shot(page, "e-resumed-pending");
  await rpc("evm_mine");
  await rpc("anvil_setAutomine", [true]);
  await expect(resumed).toContainText("went through");
  await expect(page.getByTestId("held-back")).toHaveCount(0);
  await expect(page.getByTestId("approve-button").or(page.getByTestId("buy-submit"))).toBeVisible();
  await expect.poll(() => claimBalance(BUYER, ids.settled)).toBe(held + parseUnits("2", 6));
  await expect(page.getByTestId("claim-card")).toContainText(`${Number(held + parseUnits("2", 6)) / 1e6} USDC`);
});

test("approval: pending feedback, stale allowance after changing the amount", async ({ page }) => {
  const { ids } = readState();
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("10");
  await expect(page.getByTestId("approve-button")).toContainText("Approve 1 USDC");
  await rpc("anvil_setAutomine", [false]);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approve-button")).toContainText("Approving…");
  await expect(page.getByTestId("approve-button")).toBeDisabled();
  await expect(page.getByTestId("tx-pending")).toBeVisible();
  await expect(page.getByTestId("buy-submit")).toHaveCount(0);
  await shot(page, "e-approve-pending");
  await rpc("evm_mine");
  await rpc("anvil_setAutomine", [true]);
  await expect(page.getByTestId("approved-ok")).toBeVisible();
  await expect(page.getByTestId("buy-submit")).toBeVisible();
  // A bigger amount outgrows the approval: the approve step comes back with the new figure.
  await page.getByTestId("buy-amount").fill("20");
  await expect(page.getByTestId("approve-button")).toContainText("Approve 2 USDC");
  await expect(page.getByTestId("buy-submit")).toHaveCount(0);
});

test("wallet rejection is neutral, and the retry sends exactly once", async ({ page }) => {
  const { ids } = readState();
  const held = await claimBalance(BUYER, ids.settled);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("5");
  await ensureApproved(page);
  await rejectNextSend(page);
  await page.getByTestId("buy-submit").click();
  const status = page.getByTestId("tx-reverted");
  await expect(status).toContainText("cancelled");
  await expect(status).toContainText("You cancelled in your wallet, so nothing was sent");
  await expect(status).toHaveAttribute("role", "status");
  await expect(page.getByTestId("retry-hint")).toBeVisible();
  await shot(page, "e-rejected");
  expect(await claimBalance(BUYER, ids.settled)).toBe(held);
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("bought-ok")).toBeVisible();
  expect(await claimBalance(BUYER, ids.settled)).toBe(held + parseUnits("5", 6));
});

test("a transaction stuck pending is reported as still pending, not failed, and never re-sent", async ({ page }) => {
  // With mining paused the wallet has sent the transaction but no block
  // includes it; after useTx's 120 s wait the page must say so without
  // calling it a failure or offering a second send as the fix.
  test.setTimeout(300000);
  const { ids } = readState();
  const held = await claimBalance(BUYER, ids.settled);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await page.getByTestId("buy-amount").fill("1");
  await ensureApproved(page);
  await rpc("anvil_setAutomine", [false]);
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("tx-pending")).toBeVisible();
  await expect(page.getByTestId("buy-submit")).toBeDisabled();
  await shot(page, "e-pending");
  const still = page.getByTestId("tx-still-pending");
  await expect(still).toBeVisible({ timeout: 150000 });
  await expect(still).toContainText("may still go through");
  await expect(still).toHaveAttribute("role", "status");
  await expect(page.getByTestId("still-pending-hint")).toContainText("Do not send it again");
  await shot(page, "e-still-pending");
  await rpc("evm_mine");
  await rpc("anvil_setAutomine", [true]);
  await expect.poll(() => claimBalance(BUYER, ids.settled)).toBe(held + parseUnits("1", 6));
  await page.reload();
  await connectWallet(page);
  await expect(page.getByTestId("claim-card")).toContainText(`${Number(held + parseUnits("1", 6)) / 1e6} USDC`);
});

test("paused: shown on load, and caught if it happens under an open page", async ({ page }) => {
  const { ids } = readState();
  await setPausedAs(CREATOR, ids.settled, true);
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  await expect(page.getByTestId("paused-notice")).toContainText("paused by the creator");
  await expect(page.getByTestId("policy-status")).toHaveText("Sales paused");
  await expect(page.getByTestId("buy-card")).toHaveCount(0);
  await shot(page, "e-paused");
  await setPausedAs(CREATOR, ids.settled, false);
  await expect(page.getByTestId("buy-card")).toBeVisible({ timeout: 40000 });
  await page.getByTestId("buy-amount").fill("1");
  await ensureApproved(page);
  await setPausedAs(CREATOR, ids.settled, true);
  await page.getByTestId("buy-submit").click();
  await expect(page.getByTestId("tx-reverted")).toContainText("The creator paused sales on this policy. Nothing was charged.");
  await noHex(page, "tx-reverted");
  // The page refreshed itself into the paused state without a reload, error still shown.
  await expect(page.getByTestId("paused-notice")).toBeVisible();
  await expect(page.getByTestId("tx-reverted")).toBeVisible();
  await shot(page, "e-paused-under-click");
  await setPausedAs(CREATOR, ids.settled, false);
});

test("capacity changes underneath: decoded, explained, numbers refreshed", async ({ page }) => {
  const { ids } = readState();
  const s = await readSeries(ids.settled);
  const available = s.escrow - s.sold;
  await openAs(page, BUYER, `/policies/${ids.settled}`);
  const want = available - parseUnits("5", 6);
  await page.getByTestId("buy-amount").fill(String(Number(want) / 1e6));
  await ensureApproved(page);
  // Another renter takes most of what is left while this page sits open.
  await approveAs(BUYER2, parseUnits("2", 6));
  await buyAs(BUYER2, ids.settled, parseUnits("20", 6), parseUnits("2", 6));
  await page.getByTestId("buy-submit").click();
  const status = page.getByTestId("tx-reverted");
  await expect(status).toContainText("Someone bought part of this policy while you were looking");
  await noHex(page, "tx-reverted");
  await expect(page.getByTestId("buy-validation")).toContainText(`Only ${Number(available - parseUnits("20", 6)) / 1e6} USDC is still available`);
  await shot(page, "e-capacity-race");
});

test("sold out, then the creator adds escrow and sales reopen", async ({ page, browser }) => {
  const { ids } = readState();
  await openAs(page, BUYER, `/policies/${ids.soldOut}`);
  await expect(page.getByTestId("sold-out-notice")).toContainText("The creator can add escrow until sales close");
  await expect(page.getByTestId("buy-card")).toHaveCount(0);
  await expect(page.getByTestId("step-bar")).toContainText("Sold out");
  await shot(page, "e-sold-out");

  const creator = await (await browser.newContext()).newPage();
  const before = await usdcBalance(CREATOR);
  await openAs(creator, CREATOR, `/policies/${ids.soldOut}`);
  const card = creator.getByTestId("add-escrow-card");
  await expect(card).toContainText("this policy is sold out");
  await creator.getByTestId("add-amount").fill("abc");
  await expect(creator.getByTestId("add-validation")).toContainText("digits only");
  await creator.getByTestId("add-amount").fill("10");
  await expect(creator.getByTestId("approve-button")).toContainText("Approve 10 USDC");
  await creator.getByTestId("approve-button").click();
  await expect(creator.getByTestId("approved-ok")).toBeVisible();
  await creator.getByTestId("add-escrow").click();
  await expect(creator.getByTestId("added-ok")).toContainText("Added 10 USDC");
  await expect(creator.getByTestId("policy-status")).toHaveText("On sale");
  await expect(creator.getByText("Still available").locator("..")).toContainText("10 USDC");
  expect(await usdcBalance(CREATOR)).toBe(before - parseUnits("10", 6));
  await shot(creator, "e-escrow-added");

  // The renter's page catches up on its own.
  await expect(page.getByTestId("buy-card")).toBeVisible({ timeout: 40000 });
  await expect(page.getByTestId("sold-out-notice")).toHaveCount(0);
});

test("unknown and malformed policy ids never crash the page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openAs(page, null, "/policies/999999");
  await expect(page.getByTestId("empty-state")).toContainText("Policy not found");
  await expect(page.getByRole("link", { name: "See all policies" })).toBeVisible();
  for (const bad of ["abc", "1.5", "-1", "0x10", "1e3", "99999999999999999999999"]) {
    await page.goto(`/#/policies/${bad}`);
    await expect(page.getByTestId("empty-state"), bad).toContainText("not a policy link");
  }
  await shot(page, "e-bad-id");
  expect(errors).toEqual([]);
});

test("RPC down: a retry state instead of a blank page; stale data gets a banner", async ({ page }) => {
  const { ids } = readState();
  const unblock = await blockRpc(page);
  await openAs(page, null, "/policies");
  await expect(page.getByTestId("rpc-down")).toContainText("Can't reach the Arbitrum One RPC");
  await shot(page, "e-rpc-down");
  await unblock();
  await page.getByTestId("rpc-down-retry").click();
  await expect(page.getByTestId(`policy-${ids.settled}`)).toBeVisible();

  await page.goto(`/#/policies/${ids.settled}`);
  await expect(page.getByTestId("key-dates")).toBeVisible();
  const unblock2 = await blockRpc(page);
  await expect(page.getByTestId("rpc-stale-banner")).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId("key-dates")).toBeVisible();
  await shot(page, "e-rpc-stale");
  await unblock2();
  await page.getByTestId("rpc-stale-retry").click();
  await expect(page.getByTestId("rpc-stale-banner")).toBeHidden({ timeout: 60000 });
});

test("creator cancels an unsold policy and gets the escrow back", async ({ page, browser }) => {
  const { ids } = readState();
  const before = await usdcBalance(CREATOR);
  await openAs(page, CREATOR, `/policies/${ids.unsold}`);
  await expect(page.getByTestId("creator-card")).toContainText("you can still cancel");
  await page.getByTestId("cancel").click();
  await expect(page.getByTestId("policy-status")).toHaveText("Cancelled");
  await expect(page.getByTestId("creator-card")).toContainText("escrow came back");
  expect(await usdcBalance(CREATOR)).toBe(before + parseUnits("20", 6));
  await shot(page, "e-cancelled");
  // A buyer landing on a cancelled policy is told so.
  const page2 = await (await browser.newContext()).newPage();
  await openAs(page2, BUYER, `/policies/${ids.unsold}`);
  await expect(page2.getByTestId("status-next")).toContainText("took the escrow back");
});

test("upload failures: wrong type, huge file, non-Google email, no qualifying rent, wrong month, future signature", async ({ page }) => {
  const { month } = readState();
  const { start } = monthBounds(yyyymm(month));
  await openAs(page, BUYER, "/policies/submit");
  await expect(page.getByTestId("step-bar")).toContainText("Step 1 of 5");
  const input = page.getByTestId("alert-file");

  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("file-error")).toContainText("not an email file");
  await expect(page.getByTestId("step-bar")).toContainText("Step 2 of 5");

  await input.setInputFiles({ name: "huge.eml", mimeType: "message/rfc822", buffer: Buffer.alloc(2 * 1024 * 1024, 65) });
  await expect(page.getByTestId("file-error")).toContainText("2.0 MB");

  await input.setInputFiles(CREDAILY_EML);
  await expect(page.getByTestId("file-error")).toContainText("no Google signature");
  await shot(page, "e-upload-non-google");

  const t = start + DAY + DAY / 2n;
  await input.setInputFiles(makeEml("bedroom", { slug: "east-harlem-new-york-ny", label: "East Harlem", dollars: "3,010", month, t, bedroom: true }));
  await expect(page.getByTestId("no-qualifying")).toContainText("no rent the contract accepts");
  await expect(page.getByTestId("no-qualifying")).toContainText("Average Rent by Bedroom");

  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1));
  const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  await input.setInputFiles(makeEml("wrong-month", { slug: "east-harlem-new-york-ny", label: "East Harlem", dollars: "3,010", month, t, sentenceMonth: nextMonth }));
  await expect(page.getByTestId("no-qualifying")).toContainText("but Google signed it on");
  await expect(page.getByTestId("no-qualifying")).toContainText("signed during the month it names");
  await shot(page, "e-upload-wrong-month");

  // A good email for the policy month, uploaded before that month: qualifying, but the contract would call it future-dated.
  const good = makeEml("good", { slug: "east-harlem-new-york-ny", label: "East Harlem", dollars: "3,010", month, t });
  await input.setInputFiles(good);
  await expect(page.getByTestId("preview-card")).toContainText("$3010.00/mo");
  await expect(page.getByTestId("matching-policies")).toContainText(`Policy #${readState().ids.settled}`);
  await expect(page.getByTestId("future-signature")).toContainText("from the future");
  await expect(page.getByTestId("alert-submit")).toHaveCount(0);
  await shot(page, "e-upload-future");

  // A page nobody has a policy on: said plainly before any publish step.
  await input.setInputFiles(makeEml("orphan", { slug: "rego-park-queens-ny", label: "Rego Park", dollars: "2,301", month, t }));
  await expect(page.getByTestId("no-matching-policies")).toContainText("Recording this helps no one yet");
  await shot(page, "e-upload-no-policy");
  fs.writeFileSync(path.join(ART_DIR, "good.path"), good);
});

test("a real alert, when provided, previews locally and fails on-chain against the test key", async ({ page }) => {
  const real = process.env.REAL_ALERT_EML;
  test.skip(!real, "REAL_ALERT_EML not set");
  await openAs(page, BUYER, "/policies/submit");
  await page.getByTestId("alert-file").setInputFiles(real!);
  await expect(page.getByTestId("preview-card")).toBeVisible();
  const qualifying = await page.getByTestId("alert-consent").count();
  if (qualifying === 0) {
    await expect(page.getByTestId("no-qualifying")).toBeVisible();
    return;
  }
  await expect(page.getByTestId("publish-warning")).toContainText("permanently");
  await page.getByTestId("alert-consent").check();
  // A real alert is for a month no policy here covers: the separate acknowledgement is required.
  if (await page.getByTestId("publish-anyway").count()) {
    await expect(page.getByTestId("alert-submit")).toBeDisabled();
    await page.getByTestId("publish-anyway").check();
  }
  // The fork's oracle pins the TEST key, so a genuine Google signature must be refused with plain copy.
  await page.getByTestId("alert-submit").click();
  await expect(page.getByTestId("tx-reverted")).toContainText("Google's signature does not verify");
  await noHex(page, "tx-reverted");
});
