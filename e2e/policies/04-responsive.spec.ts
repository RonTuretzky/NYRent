// Layout and accessibility basics at 360/390/768/1280 px, screenshotted so a
// human can look at them (SHOT_DIR). Runs last, so settled and void states
// are on the pages too.
import { test } from "@playwright/test";
import { BUYER, expect, expectNoHorizontalScroll, openAs, readState, shot } from "./support";

const WIDTHS = [360, 390, 768, 1280];

test.describe.configure({ mode: "serial" });

for (const width of WIDTHS) {
  test(`fits ${width}px: no horizontal scroll, 44px targets, labelled inputs, visible focus`, async ({ browser }) => {
    const { ids } = readState();
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const pages: [string, string][] = [
      ["home", "/"],
      ["list", "/policies"],
      ["detail", `/policies/${ids.settled}`],
      ["void", `/policies/${ids.void}`],
      ["v1", `/policies/v1/${ids.v1}`],
      ["create", "/policies/new"],
      ["submit", "/policies/submit"],
      ["guide", "/policies/guide"],
    ];
    for (const [name, path] of pages) {
      if (name === "home") await openAs(page, BUYER, path, { connect: false });
      else await page.goto(`/#${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByTestId("loading-skeleton")).toHaveCount(0, { timeout: 30000 });
      if (name === "create") await page.getByTestId("policy-accept").check();
      await page.evaluate(() => document.fonts.ready);
      await expectNoHorizontalScroll(page);

      const small = await page.evaluate(() => {
        const sel = "main button, main a[data-testid], main input:not([type=checkbox]), main select, main [role=tab], main label:has(input[type=checkbox]), header nav a, header nav button";
        return Array.from(document.querySelectorAll<HTMLElement>(sel))
          .filter((el) => el.offsetParent !== null && !el.closest('[data-testid^="rk-"]'))
          .map((el) => ({ tag: el.tagName, text: (el.textContent ?? "").trim().slice(0, 40), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
          .filter((r) => r.h < 44 || r.w < 44);
      });
      expect(small, `${name}@${width}: targets under 44px`).toEqual([]);

      const unlabelled = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("main input, main select")).filter((el) => {
          const label = el.closest("label");
          const name = label?.textContent?.trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
          return !name;
        }).map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(unlabelled, `${name}@${width}: inputs without a label`).toEqual([]);

      // Live regions are real roles, not just styling: the risk notice on the create page is one.
      if (name === "create") expect(await page.locator("main [role=alert], main [role=status]").count()).toBeGreaterThan(0);

      await expect(page.getByRole("region", { name: /newsletters/i })).toHaveCount(0);
      await shot(page, `r-${width}-${name}`);
    }

    // Keyboard: tabbing reaches a control inside main and focus is visible.
    await page.goto(`/#/policies/${ids.settled}`);
    await expect(page.getByTestId("key-dates")).toBeVisible();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return Boolean(el && el.closest("main") && ["A", "BUTTON", "INPUT", "SELECT"].includes(el.tagName) && el.matches(":focus-visible"));
      });
    }
    expect(reached, `${width}: keyboard focus never reached a visible control in main`).toBe(true);
    await context.close();
  });
}
