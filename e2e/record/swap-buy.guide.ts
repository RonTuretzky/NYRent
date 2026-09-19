// buy-with-usdce.gif on the mainnet-fork stack: the real QuoterV2 quote over
// the real WXDAI/USDC.e 0.01% pool, the swap through the real SwapRouter02,
// and the buy minting cover on the REAL CoverPool — anvil fork, zero mainnet
// funds. Mirrors e2e/fork/swap.spec.ts, paced for the camera.
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import {
  BUYER,
  COVER_TOKEN,
  FORK_RPC_URL,
  coverTokenAbi,
  forkClient,
  readState,
} from "../fork/support";
import {
  caption,
  connectGuideWallet,
  glideClick,
  installGuideWallet,
  pause,
  scrollToView,
  slowType,
  startCapture,
} from "./guide.helpers";

const MAX_CLAIM = parseEther("1"); // 1 WXDAI of cover → premium 0.285 WXDAI

test("buy-with-usdce.gif — real Uniswap quote, swap stepper, cover minted", async ({ page }) => {
  const { seriesId } = readState();
  await installGuideWallet(page, {
    accountIndex: 0,
    rpcUrl: FORK_RPC_URL,
    chainIdHex: "0x64",
    accounts: [BUYER],
  });
  await page.goto(`/#/buy/${seriesId}`);
  await connectGuideWallet(page);
  const amount = page.getByTestId("buy-amount");
  await expect(amount).toBeVisible();

  const stop = await startCapture(page, "buy-with-usdce");
  await caption(page, "Buy 1 WXDAI of cover — but pay in USDC.e");
  await pause(page, 1200);
  await slowType(page, amount, "1");
  await pause(page, 1000);
  await scrollToView(page, page.getByTestId("token-select"));
  await glideClick(page, page.getByTestId("token-option-usdce"));

  // Live exact-output quote from the real QuoterV2 (0.01% pool sits near par).
  const quote = page.getByTestId("swap-quote");
  await expect(quote).toBeVisible();
  await expect(quote).toContainText("via Uniswap v3");
  await expect(quote).toContainText(/0\.28\d* USDC\.e/);
  await scrollToView(page, quote);
  await caption(page, "Real Uniswap v3 quote: ≈0.285 USDC.e for the premium");
  await pause(page, 2400);

  await expect(page.getByTestId("buy-stepper")).toBeVisible();
  await caption(page, "Approve swap → swap → approve pool → buy");
  const steps = ["swap-approve", "swap", "pool-approve", "buy"] as const;
  for (const step of steps) {
    const button = page.getByTestId(`step-${step}-button`);
    await expect(button).toBeEnabled({ timeout: 120000 });
    await pause(page, 800);
    await glideClick(page, button);
  }

  const minted = page.getByText("Cover minted.");
  await expect(minted).toBeVisible({ timeout: 120000 });
  await expect
    .poll(
      () =>
        forkClient.readContract({
          address: COVER_TOKEN,
          abi: coverTokenAbi,
          functionName: "balanceOf",
          args: [BUYER, BigInt(seriesId)],
        }),
      { timeout: 45000 },
    )
    .toBe(MAX_CLAIM);
  await scrollToView(page, minted);
  await caption(page, "Cover minted — premium swapped and paid through the real pool");
  await pause(page, 2600);
  await caption(page, null);
  await stop();
});
