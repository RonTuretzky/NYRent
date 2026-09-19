import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ART } from "./constants";

const sizes = [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }];
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: page.viewportSize()!.width, document: page.viewportSize()!.width });
}

test("mobile home, renter scenarios and real source assets fit and honor reduced motion", async ({ page }) => {
  const out = path.join(ART, "mobile-content"); fs.mkdirSync(out, { recursive: true });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(`${page.url()}: ${error.message}`));
  for (const size of sizes) await test.step(`${size.width}px homepage, renter and newsletter sources`, async () => {
    await page.setViewportSize(size);
    await page.goto("/#/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await noOverflow(page);
    await page.getByText("Follow the money", { exact: true }).click();
    await expect(page.getByRole("img", { name: /^Money flow:/ })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: path.join(out, `home-${size.width}.png`), fullPage: true });

    const gallery = page.locator(".source-gallery");
    await expect(gallery).toHaveCount(1);
    const originalCards = gallery.locator(".source-gallery-group:not(.source-gallery-duplicate) .source-gallery-card");
    await expect(originalCards).toHaveCount(7);
    const motion = gallery.getByRole("button", { name: /^(Pause|Play) source gallery$/ });
    if (await motion.getAttribute("aria-pressed") !== "true") await motion.click();
    await expect(gallery.getByRole("button", { name: "Play source gallery", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const logo of await originalCards.locator("img").all()) {
      await logo.scrollIntoViewIfNeeded();
      await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
    await gallery.locator(".source-gallery-window").evaluate(element => { element.scrollLeft = 0; });
    await noOverflow(page);
    await gallery.screenshot({ path: path.join(out, `gallery-${size.width}.png`) });

    await page.goto("/#/renter");
    await page.getByTestId("renter-rent").fill("60000");
    await page.getByTestId("renter-price").fill("0.285");
    for (const [name, amount] of [["+3%", "$0"], ["+5%", "$1,200"], ["+8%", "$3,000"]] as const) {
      const button = page.getByRole("button", { name, exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await button.click(); await expect(page.getByTestId("renter-outcome-payout")).toHaveText(amount);
      await noOverflow(page);
    }
    await page.getByTestId("renter-growth-slider").focus();
    await page.getByTestId("renter-growth-slider").press("Home");
    await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$0");
    await page.getByTestId("renter-growth-slider").press("End");
    await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$3,000");
    await page.getByTestId("renter-growth").fill("5");
    await expect(page.getByTestId("renter-outcome-payout")).toHaveText("$1,200");
    await page.screenshot({ path: path.join(out, `renter-${size.width}.png`), fullPage: true });

    await page.goto("/#/docs/sources");
    await expect(page.getByRole("heading", { name: "Where the rent numbers come from", exact: true })).toBeVisible();
    const publications = page.locator('article[id^="source-"]');
    await expect(publications).toHaveCount(7);
    for (const publication of await publications.all()) {
      const logo = publication.locator("img"); await logo.scrollIntoViewIfNeeded();
      await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await publication.locator("summary").click();
    }
    await expect(publications.locator("details li")).toHaveCount(14);
    await noOverflow(page);
    await page.screenshot({ path: path.join(out, `sources-${size.width}.png`), fullPage: true });
    expect(pageErrors, "Browsers must not raise uncaught application errors").toEqual([]);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#/docs/sources");
  await page.locator('article[id^="source-"]').first().screenshot({ path: path.join(out, "source-card-desktop.png") });
  await page.locator(".source-gallery").screenshot({ path: path.join(out, "gallery-desktop.png") });
  await noOverflow(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/");
  const gallery = page.locator(".source-gallery");
  await gallery.scrollIntoViewIfNeeded();
  await expect(gallery.getByRole("button", { name: /source gallery$/ })).toBeHidden();
  await expect(gallery.locator(".source-gallery-duplicate")).toBeHidden();
  expect(await gallery.locator(".source-gallery-track").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  await noOverflow(page);
  expect(pageErrors).toEqual([]);
});
