// Pay-with-USDC.e against the REAL Uniswap v3 deployment on a Gnosis fork:
// the quote comes from the real QuoterV2 over the real WXDAI/USDC.e 0.01% pool
// and ONE SwapAndBuyRouter transaction swaps + buys on the real permissionless
// CoverPool — all on anvil's fork, spending zero mainnet funds. The old
// frontend-orchestrated 4-step stepper is gone: the uniform router UX is
// approve (ERC-20 only) → swapAndBuy.
import { test, expect } from "@playwright/test";
import { parseEther } from "viem";
import { connectWallet } from "../support/helpers";
import {
  BUYER,
  COVER_TOKEN,
  USDCE,
  coverTokenAbi,
  erc20Abi,
  forkClient,
  installForkWallet,
  readState,
} from "./support";

const MAX_CLAIM = parseEther("1"); // 1 WXDAI of cover → premium 0.285 WXDAI

test("buyer pays with USDC.e: real QuoterV2 quote, one router swap-and-buy, cover minted", async ({
  page,
}) => {
  const { seriesId } = readState();
  const usdceBefore = await forkClient.readContract({
    address: USDCE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BUYER],
  });

  await installForkWallet(page);
  await page.goto(`/#/buy/${seriesId}`);
  await connectWallet(page);
  await page.getByTestId("buy-amount").fill("1");

  // Swap tokens are visible because the active deployment IS Gnosis (100).
  await page.getByTestId("token-option-usdce").click();

  // Live exact-output quote from the real QuoterV2: 0.285 WXDAI out costs
  // ~0.285 USDC.e in (the 0.01% pool sits within bps of par).
  const quote = page.getByTestId("swap-quote");
  await expect(quote).toBeVisible();
  await expect(quote).toContainText("via Uniswap v3");
  await expect(quote).toContainText(/0\.285\d* USDC\.e/);

  // The plain-language protection summary precedes the confirm buttons.
  await expect(page.getByTestId("protection-summary")).toBeVisible();
  await expect(page.getByTestId("index-disclosure")).toContainText(
    "Manhattan office rent",
  );

  // Uniform router UX: approve the router for USDC.e, then ONE transaction
  // swaps to the exact premium and buys — no stepper, no pool approval.
  const approve = page.getByTestId("swap-approve-button");
  await expect(approve).toBeEnabled({ timeout: 60000 });
  await approve.click();

  const swapBuy = page.getByTestId("swap-buy-button");
  await expect(swapBuy).toBeEnabled({ timeout: 90000 });
  await swapBuy.click();

  await expect(page.getByText("Cover minted.")).toBeVisible({ timeout: 90000 });

  // On-chain truth on the fork: the cover position exists on the REAL token…
  await expect
    .poll(
      () =>
        forkClient.readContract({
          address: COVER_TOKEN,
          abi: coverTokenAbi,
          functionName: "balanceOf",
          args: [BUYER, BigInt(seriesId)],
        }),
      { timeout: 30000 },
    )
    .toBe(MAX_CLAIM);

  // …and the premium was genuinely paid in USDC.e through the real pool:
  // ~0.285 USDC.e spent (exact-output swap, unspent input refunded in the
  // same transaction), never more than the 50 bps slippage cap allows.
  const usdceAfter = await forkClient.readContract({
    address: USDCE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BUYER],
  });
  const spent = usdceBefore - usdceAfter;
  expect(spent).toBeGreaterThan(280_000n); // > 0.28 USDC.e
  expect(spent).toBeLessThan(300_000n); // < 0.30 USDC.e (0.285 + slippage room)
});
