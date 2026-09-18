// Failure handling (SPEC §7): a tampered email must show WHICH DKIM check failed,
// junk files fail friendly, over-capacity buys are blocked client-side, and a
// wallet on the wrong chain is told so and can recover.
// File runs before journey.spec.ts (alphabetical, single worker) and is written to
// be order-independent: nothing here mutates chain state.
import { test, expect } from "@playwright/test";
import { connectWallet, installWallet, tamperedEml } from "./support/helpers";

test("a tampered email fails exactly the body-hash preflight check", async ({ page }) => {
  await installWallet(page);
  await page.goto("/#/settle/0");
  await connectWallet(page);
  await page.getByTestId("eml-input").setInputFiles({
    name: "tampered.eml",
    mimeType: "message/rfc822",
    buffer: tamperedEml(),
  });
  // The value was edited inside the body: the signature over the headers still
  // verifies, bh-match must be the red check, and submission stays blocked.
  await expect(page.getByTestId("preflight-check-bh-match")).toHaveAttribute(
    "data-pass",
    "false",
    { timeout: 30000 },
  );
  await expect(page.getByTestId("preflight-check-rsa-verify")).toHaveAttribute(
    "data-pass",
    "true",
  );
  await expect(page.getByTestId("record-button")).toBeDisabled();
});

test("a file that is not an email gets a friendly error", async ({ page }) => {
  await installWallet(page);
  await page.goto("/#/settle/0");
  await connectWallet(page);
  await page.getByTestId("eml-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is not an email at all\n"),
  });
  await expect(page.getByTestId("preflight-error")).toBeVisible();
});

test("buying over the series capacity is blocked client-side", async ({ page }) => {
  await installWallet(page, { accountIndex: 1 });
  await page.goto("/#/buy/0");
  await connectWallet(page);
  // Demo series capacity is 0.02 WXDAI (SPEC §2.5); ask for more.
  await page.getByTestId("buy-amount").fill("0.05");
  await expect(page.getByTestId("buy-validation")).toBeVisible();
  await expect(page.getByTestId("buy-button")).toBeDisabled();
});

test("wrong network shows the banner and recovers after switching", async ({ page }) => {
  // Wallet sits on mainnet (0x1); the app targets the deployment.json chain.
  await installWallet(page, { chainIdHex: "0x1" });
  await page.goto("/#/");
  await connectWallet(page);
  const banner = page.getByTestId("wrong-network-banner");
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: /switch/i }).click();
  await expect(banner).toBeHidden();
});
