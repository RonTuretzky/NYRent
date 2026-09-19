// docs.gif on the FORK stack on purpose: the fork suite serves the production
// build against the committed REAL deployment.json, so the docs page's contract
// address card and chainId chip show the actual Gnosis deployment — not the
// throwaway anvil addresses the local recorder stack would print.
import { test, expect } from "@playwright/test";
import { caption, installCursor, pause, scrollToView, startCapture } from "./guide.helpers";

test("docs.gif — rules, real addresses, recorded lifecycle", async ({ page }) => {
  await installCursor(page); // scroll-only shot; cursor stays parked off-screen
  await page.goto("/#/docs");
  await expect(page.getByRole("heading", { name: /Documentation/i })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const stop = await startCapture(page, "docs");
  await pause(page, 2000); // header + pinned-key / $92.88 chips
  await scrollToView(page, page.getByRole("heading", { name: /Settlement rules/i }), 900);
  await pause(page, 1600);
  await page.evaluate(() => window.scrollBy({ top: 500, behavior: "smooth" })); // rules 5–10
  await pause(page, 1800);
  await scrollToView(page, page.getByRole("heading", { name: /Contract addresses/i }), 900);
  await caption(page, "The real Gnosis deployment — Sourcify-verified");
  await pause(page, 2400);
  await scrollToView(page, page.getByRole("heading", { name: /Recorded lifecycle/i }), 900);
  await caption(page, "Series 0 settled on-chain with the 2026-09-17 email");
  await pause(page, 2400);
  await caption(page, null);
  await scrollToView(page, page.getByRole("heading", { name: /Repository docs/i }), 900);
  await pause(page, 1800);
  await stop();
});
