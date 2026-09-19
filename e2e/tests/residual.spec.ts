// Creator residual withdrawal — the permissionless pool's replacement for the
// old sponsor free-capital withdrawal. MUST BE THE LAST SPEC FILE: it warps the
// chain past demo series 0's redeemEnd (months ahead), after which nothing can
// be bought or redeemed on that series ever again.
//
// Money math re-checked over RPC against the journey's frozen numbers:
// residual = escrow (0.02) + premiums (0.00285) − paidOut (0.00366) = 0.01919,
// which includes the 0.004 of cover the buyer never redeemed.
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import {
  ACCOUNTS,
  alignClock,
  connectWallet,
  currencyBalance,
  installWallet,
  poolBalance,
  readSeries,
  warpTo,
} from "../support/helpers";

const CREATOR = ACCOUNTS[0];
const EXPECTED_RESIDUAL = parseEther("0.01919");
const ESCROW_1 = parseEther("0.005"); // journey-created series 1 stays escrowed

test("creator withdraws the residual once the claim window closes", async ({
  page,
}) => {
  const before = await readSeries(0n);
  expect(before.settled).toBe(true);
  expect(before.residualWithdrawn).toBe(false);
  const residual =
    before.escrow + before.premiumsAccrued - before.paidOut - before.withdrawn;
  expect(residual).toBe(EXPECTED_RESIDUAL);

  // Past redeemEnd the residual unlocks — chain first, then the browser clock.
  await warpTo(before.redeemEnd + 60n);
  await alignClock(page, before.redeemEnd + 60n);
  await installWallet(page, { accountIndex: 0 });
  await page.goto("/#/underwrite");
  await connectWallet(page);

  const creatorBefore = await currencyBalance(CREATOR);
  const poolBefore = await poolBalance();

  // The creator's series card for series 0 (series 1 has its own card).
  const card = page.getByTestId("your-series-0");
  await expect(card).toBeVisible();
  const withdraw = card.getByTestId("withdraw-button");
  await expect(withdraw).toBeEnabled({ timeout: 45000 });
  await withdraw.click();

  await expect
    .poll(() => currencyBalance(CREATOR), { timeout: 45000 })
    .toBe(creatorBefore + EXPECTED_RESIDUAL);
  expect(await poolBalance()).toBe(poolBefore - EXPECTED_RESIDUAL);
  // Only journey's series-1 escrow remains in the pool: series 0's book closed.
  expect(await poolBalance()).toBe(ESCROW_1);

  // One-shot latch on-chain, and the card reports the withdrawal.
  const after = await readSeries(0n);
  expect(after.residualWithdrawn).toBe(true);
  expect(after.withdrawn).toBe(EXPECTED_RESIDUAL);
  await expect(card).toContainText("Residual withdrawn");
});
