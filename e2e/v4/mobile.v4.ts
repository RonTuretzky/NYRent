import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ART, PREVIEW, CREATOR, BUYER, UNIT } from "./constants";
import { openWallet, clickReady, rentBalance, lpBalance, dismissToasts } from "./support";

const SIZES = [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }];
const EMPTY = "0x000000000000000000000000000000000000dEaD" as const;

async function connectWallet(page: Page) {
  const account = page.locator('[data-testid="rk-account-button"]:visible').first();
  if (await account.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false)) return;
  await page.getByRole("button", { name: /^(?:Connect|Connect wallet)$/i }).first().click();
  await page.getByRole("button", { name: /E2E Test Wallet|Injected|Browser/i }).first().click();
  await expect(account).toBeVisible();
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))).toMatchObject({ width: page.viewportSize()!.width, scroll: page.viewportSize()!.width });
}
async function fits(page: Page, target: Locator, minimumHeight = 0) {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(box!.height).toBeGreaterThanOrEqual(minimumHeight);
}

test("mobile v4 forms, wallet states, navigation and recordings fit at 360, 390 and 768px", async ({ browser }) => {
  test.setTimeout(180000);
  fs.mkdirSync(path.join(ART, "mobile"), { recursive: true });
  const creatorContext = await browser.newContext({ baseURL: PREVIEW, viewport: SIZES[0], isMobile: true, hasTouch: true });
  const buyerContext = await browser.newContext({ baseURL: PREVIEW, viewport: SIZES[1], isMobile: true, hasTouch: true });
  const emptyContext = await browser.newContext({ baseURL: PREVIEW, viewport: SIZES[0], isMobile: true, hasTouch: true });
  const creator = await creatorContext.newPage(), buyer = await buyerContext.newPage(), empty = await emptyContext.newPage();
  const pageErrors: string[] = [];
  for (const page of [creator, buyer, empty]) page.on("pageerror", error => pageErrors.push(`${page.url()}: ${error.message}`));
  await openWallet(creator, 0); await openWallet(buyer, 1); await openWallet(empty, 0, [EMPTY]);
  try {
    await test.step("a phone can deposit backing and separately fund trading liquidity", async () => {
      await creator.goto("/#/insurer"); await connectWallet(creator);
      const collateral = creator.getByLabel("Collateral (USDC)", { exact: true });
      await fits(creator, collateral, 44); await collateral.fill("1000");
      await fits(creator, creator.getByRole("button", { name: "Deposit and mint RENT", exact: true }), 44);
      await clickReady(creator, "Deposit and mint RENT");
      await expect.poll(() => rentBalance(CREATOR)).toBe(1000n * UNIT);
      const rentLimit = creator.getByLabel("RENT deposit limit", { exact: true });
      const cashLimit = creator.getByLabel("USDC deposit limit", { exact: true });
      await fits(creator, rentLimit, 44); await fits(creator, cashLimit, 44);
      await rentLimit.fill("500"); await cashLimit.fill("142.5");
      await expect(creator.getByTestId("liquidity-deposit-preview")).toContainText("unused tokens stay in your wallet");
      await fits(creator, creator.getByRole("button", { name: "Add liquidity", exact: true }), 44);
      await clickReady(creator, "Add liquidity"); await expect.poll(lpBalance).toBeGreaterThan(0n);
      await dismissToasts(creator); await noOverflow(creator);
      await creator.screenshot({ path: path.join(ART, "mobile/insurer-360.png"), fullPage: true });
    });

    await test.step("a phone can execute a properly sized trade", async () => {
      await buyer.goto("/#/buy"); await connectWallet(buyer);
      await buyer.getByLabel("You pay (USDC)", { exact: true }).fill("1");
      await fits(buyer, buyer.getByRole("button", { name: "Confirm trade", exact: true }), 44);
      await clickReady(buyer, "Confirm trade");
      await expect.poll(() => rentBalance(BUYER)).toBeGreaterThan(3n * UNIT);
      await dismissToasts(buyer); await noOverflow(buyer);
    });

    for (const size of SIZES) await test.step(`${size.width}px wallet warnings, menus, liquidity and video playback`, async () => {
      for (const page of [creator, buyer, empty]) await page.setViewportSize(size);
      await empty.goto("/#/buy"); await connectWallet(empty);
      await expect(empty.getByTestId("insufficient-funds")).toContainText("No USDC on");
      await expect(empty.getByTestId("missing-gas")).toContainText("network fees");
      await fits(empty, empty.getByTestId("insufficient-funds"));
      await fits(empty, empty.getByTestId("missing-gas"));
      await fits(empty, empty.getByLabel("You pay (USDC)", { exact: true }), 44);
      await fits(empty, empty.getByRole("button", { name: "Buy", exact: true }), 44);
      await fits(empty, empty.getByRole("button", { name: "Sell", exact: true }), 44);
      await expect(empty.getByRole("button", { name: "Confirm trade", exact: true })).toBeDisabled();
      await empty.getByRole("button", { name: "Sell", exact: true }).click();
      await expect(empty.getByTestId("insufficient-funds")).toContainText("No RENT on");
      await noOverflow(empty);
      await empty.screenshot({ path: path.join(ART, `mobile/empty-wallet-${size.width}.png`), fullPage: true });

      const menu = empty.getByRole("button", { name: "Open menu", exact: true });
      await fits(empty, menu, 44); await menu.click();
      const dialog = empty.getByRole("dialog", { name: "Navigation menu", exact: true });
      await expect(dialog).toBeVisible(); await fits(empty, dialog);
      await dialog.getByRole("button", { name: "For renters / insurers", exact: true }).click();
      await expect(dialog.getByRole("link", { name: "Renter", exact: true })).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Insurer", exact: true })).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Buy & Sell", exact: true })).toHaveCount(1);
      await dialog.getByRole("link", { name: "Redeem RENT", exact: true }).click();
      await expect(empty).toHaveURL(/#\/redeem$/); await expect(dialog).toBeHidden();
      await fits(empty, empty.getByLabel("RENT to redeem", { exact: true }), 44);
      await fits(empty, empty.getByRole("button", { name: "Redeem RENT", exact: true }), 44);
      await expect(empty.getByRole("button", { name: "Redeem RENT", exact: true })).toBeDisabled();
      await noOverflow(empty);

      await buyer.goto("/#/buy");
      await buyer.getByLabel("You pay (USDC)", { exact: true }).fill("100");
      await expect(buyer.getByTestId("price-impact-warning")).toContainText("too large for the available liquidity");
      await fits(buyer, buyer.getByTestId("price-impact-warning")); await noOverflow(buyer);
      await buyer.screenshot({ path: path.join(ART, `mobile/trade-impact-${size.width}.png`), fullPage: true });

      await creator.goto("/#/insurer");
      await fits(creator, creator.getByTestId("liquidity-price"));
      await fits(creator, creator.getByLabel("RENT deposit limit", { exact: true }), 44);
      await fits(creator, creator.getByLabel("USDC deposit limit", { exact: true }), 44);
      await noOverflow(creator);

      await buyer.goto("/#/docs");
      await expect(buyer.getByRole("heading", { level: 1 })).toBeVisible(); await noOverflow(buyer);
      await buyer.screenshot({ path: path.join(ART, `mobile/docs-${size.width}.png`), fullPage: true });
      await buyer.goto("/#/docs/uniswap");
      await expect(buyer.getByRole("heading", { level: 1 })).toBeVisible(); await noOverflow(buyer);
      await buyer.screenshot({ path: path.join(ART, `mobile/uniswap-${size.width}.png`), fullPage: true });
      await buyer.goto("/#/docs/walkthrough");
      const videos = buyer.locator("video"); await expect(videos).toHaveCount(2);
      for (const video of await videos.all()) {
        await fits(buyer, video);
        await video.scrollIntoViewIfNeeded();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => Number.isFinite(element.duration) && element.duration > 100)).toBe(true);
        expect(await video.evaluate((element: HTMLVideoElement) => element.error?.message ?? null)).toBeNull();
        if (size.width === 390) {
          await video.evaluate((element: HTMLVideoElement) => element.play());
          await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.2);
          await video.evaluate((element: HTMLVideoElement) => element.pause());
        }
      }
      await expect(buyer.getByRole("heading", { name: "Jump to a step", exact: true })).toBeVisible();
      await noOverflow(buyer);
      await buyer.screenshot({ path: path.join(ART, `mobile/recordings-${size.width}.png`), fullPage: true });
      expect(pageErrors, "Browsers must not raise uncaught application errors").toEqual([]);
    });
  } catch (error) {
    for (const [label, page] of [["creator", creator], ["buyer", buyer], ["empty", empty]] as const) {
      await page.screenshot({ path: path.join(ART, `mobile/failure-${label}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally { await Promise.all([creatorContext.close(), buyerContext.close(), emptyContext.close()]); }
});
