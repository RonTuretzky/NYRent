import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ART } from "./constants";

const phases = [2, 2, 0, 0, 6, 0, 3, 7, 0, 0];

async function fitScreen(page: Page) {
  const bounds = await page.evaluate(() => {
    const screen = document.querySelector('[data-testid="story-screen"]')!;
    const nodes = Array.from(screen.querySelectorAll<HTMLElement>("h1,h2,p,button,input,svg,dl,img,a"));
    return {
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      clipped: nodes.filter(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).flatMap(el => {
        const box = el.getBoundingClientRect();
        return box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1
          ? [`${el.tagName}: ${(el.textContent ?? "").slice(0, 70)} (${Math.round(box.bottom)})`] : [];
      }),
    };
  });
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height);
  expect(bounds.clipped, "Every visible screen element must remain inside the viewport").toEqual([]);
}

test("Story fits every scene, preserves shared calculations and supports presenter navigation", async ({ page }) => {
  const out = path.join(ART, "story"); fs.mkdirSync(out, { recursive: true });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  for (const size of [{width:1366,height:768}, {width:1920,height:1080}, {width:390,height:844}]) {
    await page.setViewportSize(size);
    for (let step = 1; step <= phases.length; step++) {
      await page.goto(`/#/story/${step}`);
      const story = page.getByTestId("story");
      await expect(story).toHaveAttribute("data-step", String(step));
      await expect(page.getByRole("heading", {level:1})).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (let phase = 0; phase < phases[step - 1]; phase++) await page.keyboard.press("ArrowRight");
      await expect(story).toHaveAttribute("data-step", String(step));
      await expect(story).toHaveAttribute("data-phase", String(phases[step - 1]));
      const revealed = page.locator('.story-reveal[aria-hidden="false"]');
      if (await revealed.count()) await expect(revealed.last()).toHaveCSS("opacity", "1");
      if (step === 8) await expect(page.locator(".story-resolution-result")).toContainText("0.50 USDC per RENT");
      if (step === 10) {
        const links = page.locator(".story-connect-card");
        await expect(links).toHaveCount(4);
        for (const [index, url] of ["https://rentsafe.nyc/", "https://decentralpark.nyc/", "https://x.com/RonTuretzky", "https://x.com/shaudub"].entries()) {
          await expect(links.nth(index)).toHaveAttribute("href", url);
          await expect(links.nth(index).locator("img")).toHaveJSProperty("complete", true);
          expect(await links.nth(index).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
        }
        await expect(page.getByRole("button", {name:"Next",exact:true})).toBeDisabled();
      }
      await fitScreen(page);
      expect(await story.innerText()).not.toMatch(/\bseries\b/i);
      await expect(page.getByRole("button", {name:/connect wallet|confirm trade|approve/i})).toHaveCount(0);
      if (size.width >= 1366) {
        expect(await page.getByRole("heading", {level:1}).evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(56);
      }
      await page.screenshot({path:path.join(out, `story-${step}-${size.width}.png`)});
    }
  }

  await page.setViewportSize({width:1366,height:768});
  await page.goto("/#/story/6");
  await expect(page.getByTestId("story-premium")).toHaveText("$11,400");
  await expect(page.getByTestId("story-claims")).toHaveText("$16,000");
  await expect(page.getByTestId("story-net")).toHaveText("−$4,600");
  await page.getByTestId("story-growth").fill("8");
  await expect(page.getByTestId("story-claims")).toHaveText("$40,000");
  await expect(page.getByTestId("story-net")).toHaveText("−$28,600");
  await page.getByTestId("story-sold").fill("10");
  await page.getByTestId("story-sold").press("Tab");
  await expect(page.getByTestId("story-premium")).toHaveText("$2,850");
  await page.getByTestId("story-growth").fill("5");
  await expect(page.getByTestId("story-net")).toHaveText("−$1,150");
  await page.getByRole("heading", {level:1}).click();
  await page.keyboard.press("9");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "9");
  await expect(page.getByTestId("story-market-price")).toHaveText("0.285");
  await expect(page.getByTestId("story-implied-growth")).toHaveText("+4.4%");
  await expect(page.getByTestId("story-implied-rent")).toHaveText("$96.99");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "10");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "9");
  await page.keyboard.press("0");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "10");
  await page.keyboard.press("n");
  await expect(page.getByRole("region", {name:"Speaker notes"})).toBeVisible();
  await page.keyboard.press("n");
  await expect(page.getByRole("region", {name:"Speaker notes"})).toBeHidden();
  await page.keyboard.press("1");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "1");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("story")).toHaveAttribute("data-phase", "1");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("story")).toHaveAttribute("data-phase", "0");
  await page.getByRole("button", {name:"Dark theme",exact:true}).click();
  await page.screenshot({path:path.join(out,"story-dark-1366.png")});
  await fitScreen(page);
  await page.getByRole("button", {name:"Light theme",exact:true}).click();
  await page.getByRole("button", {name:"Present",exact:true}).click();
  await expect(page.getByRole("button", {name:"Exit fullscreen",exact:true})).toBeVisible();
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole("button", {name:"Exit fullscreen",exact:true}).click();
  await expect(page.getByRole("button", {name:"Present",exact:true})).toBeVisible();
  await page.getByRole("button", {name:/Screen 4:/}).click();
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "4");
  await page.getByTestId("story-screen").dispatchEvent("touchstart", {touches:[{identifier:0,clientX:300,clientY:350}]});
  await page.getByTestId("story-screen").dispatchEvent("touchend", {changedTouches:[{identifier:0,clientX:100,clientY:350}]});
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "5");
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.keyboard.press("7");
  await fitScreen(page);
  expect(errors).toEqual([]);
});

test("Story uses labeled example constants only when the market is unconfigured", async ({page}) => {
  await page.goto("/unconfigured/#/story/3");
  await expect(page.getByTestId("story")).toHaveAttribute("data-step", "3");
  await expect(page.getByTestId("story-screen")).toContainText("Demo");
  await expect(page.getByTestId("story-screen")).toContainText("$92.88");
  await page.goto("/unconfigured/#/story/9");
  await expect(page.getByTestId("story-forecast-demo")).toContainText("Demo");
  await expect(page.getByTestId("story-market-price")).toHaveText("0.285");
  await expect(page.getByTestId("story-implied-rent")).toHaveText("$96.99");
  await expect(page.getByRole("button", {name:/connect wallet/i})).toHaveCount(0);
});
