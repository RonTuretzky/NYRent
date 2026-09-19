// Header chain switch → one-transaction native-ETH buy on an Arbitrum fork:
// the wallet starts on Gnosis, the header switcher flips BOTH the app context
// and the wallet to Arbitrum One, and a fresh code-less buyer (never anvil
// key #0) pays native ETH through the REAL SwapAndBuyRouter — real QuoterV2
// quote, real WETH/USDC 0.05% pool, real permissionless CoverPool — in ONE
// confirmation, with the unspent input refunded as WETH.
import { test, expect } from "@playwright/test";
import { parseUnits } from "viem";
import { connectWallet } from "../support/helpers";
import {
  BUYER,
  COVER_TOKEN,
  POOL,
  USDC,
  WETH,
  coverTokenAbi,
  erc20Abi,
  forkClient,
  installArbWallet,
  readState,
} from "./support";

const MAX_CLAIM = parseUnits("10", 6); // 10 USDC of cover (6-dec pool currency)
const PREMIUM = parseUnits("2.85", 6); // 2850 bps of 10 USDC
const CAPACITY = parseUnits("20", 6); // the creator's escrow from global-setup

test("header chain switch, then one-tx native-ETH swap-and-buy on the real router", async ({
  page,
}) => {
  const { seriesId } = readState();
  const poolUsdcBefore = await forkClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [POOL],
  });
  expect(poolUsdcBefore).toBe(CAPACITY);
  const wethBefore = await forkClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BUYER],
  });
  const ethBefore = await forkClient.getBalance({ address: BUYER });

  await installArbWallet(page);
  await page.goto("/");
  await connectWallet(page);

  // The app followed the wallet onto Gnosis (the default chain).
  const switcher = page.getByTestId("chain-switcher").first();
  await expect(switcher).toHaveValue("100");

  // Header chain switch drives BOTH the app context and the wallet.
  await switcher.selectOption("42161");
  await expect(switcher).toHaveValue("42161");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            ethereum: { request(a: { method: string }): Promise<string> };
          }
        ).ethereum.request({ method: "eth_chainId" }),
      ),
    )
    .toBe("0xa4b1");
  await expect(page.getByTestId("wrong-network-banner")).toBeHidden();

  // SPA navigation (no reload — the shim would reset to its initial chain).
  await page.evaluate((id) => {
    window.location.hash = `#/buy/${id}`;
  }, seriesId);

  await page.getByTestId("buy-amount").fill("10");
  await page.getByTestId("token-option-eth").click();

  // Live exact-output quote from the real QuoterV2 over the real 0.05% pool.
  const quote = page.getByTestId("swap-quote");
  await expect(quote).toBeVisible();
  await expect(quote).toContainText("via Uniswap v3");
  await expect(quote).toContainText(/0\.\d+ ETH/);

  // The plain-language protection summary + the index disclosure are there.
  await expect(page.getByTestId("protection-summary")).toBeVisible();
  await expect(page.getByTestId("index-disclosure").getByRole("link", { name: "market page" })).toHaveAttribute("href", `#/market/${seriesId}`);
  await expect(page.getByTestId("index-disclosure").getByRole("link", { name: "docs", exact: true })).toHaveAttribute("href", "#/docs");

  // Native coin: no approval — ONE confirmation swaps and buys atomically.
  await expect(page.getByTestId("swap-approve-button")).toHaveCount(0);
  const swapBuy = page.getByTestId("swap-buy-button");
  await expect(swapBuy).toBeEnabled({ timeout: 90000 });
  await swapBuy.click();

  await expect(page.getByText("Cover minted.")).toBeVisible({ timeout: 90000 });

  // On-chain truth on the fork: cover minted on the REAL token to the buyer…
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

  // …the EXACT premium landed in the real pool in USDC…
  const poolUsdcAfter = await forkClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [POOL],
  });
  expect(poolUsdcAfter).toBe(CAPACITY + PREMIUM);

  // …the swap dust came back as WETH (exact-output swap, value = slippage
  // cap), and the whole thing cost a sliver of ETH (premium ≈ $2.85).
  const wethAfter = await forkClient.readContract({
    address: WETH,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BUYER],
  });
  expect(wethAfter).toBeGreaterThan(wethBefore);
  const ethAfter = await forkClient.getBalance({ address: BUYER });
  const ethSpent = ethBefore - ethAfter;
  expect(ethSpent).toBeGreaterThan(0n);
  expect(ethSpent).toBeLessThan(parseUnits("0.05", 18)); // sanity: ≪ 0.05 ETH
});
