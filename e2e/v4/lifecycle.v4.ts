import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { formatUnits, parseAbiItem } from "viem";
import { ART, PREVIEW, CREATOR, BUYER, OBS_START, SETTLE_TIME, CLAIM_END, UNIT } from "./constants";
import { client, deployment, marketAbi, oracleAbi, rentBalance, cashBalance, balance, lpBalance, warp, openWallet, syncClock, connectWallet, clickReady, dismissToasts } from "./support";

test("real v4 UI: backed mint, LP, buy/sell, blackout, DKIM settlement, payout and residual", async ({ page: insurer, context }) => {
  test.setTimeout(180000);
  const renter = await context.newPage();
  const d = deployment();
  const receipts: Record<string, unknown> = { scope: "LOCAL ANVIL ONLY: real Uniswap v4 contracts, synthetic TEST-key signed emails" };
  await openWallet(insurer, 0);
  await openWallet(renter, 1);

  await test.step("insurer escrows actual USDC and mints equal RENT through the UI", async () => {
    await insurer.goto("/#/insurer");
    await connectWallet(insurer);
    await expect(insurer.getByTestId("v4-market-actions")).toBeVisible();
    await expect(insurer.getByTestId("market-strip")).toHaveCount(0);
    await expect(insurer.locator("main")).not.toContainText(/\bdemo\b/i);
    await insurer.getByLabel("Collateral (USDC)", {exact: true}).fill("1000");
    await clickReady(insurer, "Deposit and mint RENT");
    await expect.poll(() => rentBalance(CREATOR)).toBe(1000n * UNIT);
    expect(await balance(d.currency, d.market)).toBe(1000n * UNIT);
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "totalSupply"})).toBe(1000n * UNIT);
  });

  await test.step("insurer funds real v4 liquidity, distinct from escrow", async () => {
    await insurer.getByLabel("RENT to add", {exact: true}).fill("100000");
    await expect(insurer.getByRole("button", {name: "Add liquidity", exact: true})).toBeDisabled();
    await expect(insurer.getByTestId("liquidity-funds-warning")).toContainText("Not enough RENT");
    await insurer.getByLabel("RENT to add", {exact: true}).fill("500");
    await expect(insurer.getByTestId("liquidity-deposit-controls").locator("input")).toHaveCount(1);
    await expect(insurer.getByTestId("liquidity-usdc-required")).toHaveText("142.5 USDC");
    await expect(insurer.getByTestId("liquidity-usdc-maximum")).toHaveText("143.925 USDC");
    await expect(insurer.getByTestId("liquidity-price")).toContainText("Adding liquidity does not set a new price");
    await expect(insurer.getByTestId("liquidity-deposit-preview")).toContainText("Unused tokens stay in your wallet");
    const beforeRent = await rentBalance(CREATOR), beforeCash = await cashBalance(CREATOR);
    await clickReady(insurer, "Add liquidity");
    await expect.poll(lpBalance).toBeGreaterThan(0n);
    expect(beforeRent - await rentBalance(CREATOR)).toBe(500n * UNIT);
    expect(beforeCash - await cashBalance(CREATOR)).toBe(142_500000n);
    expect(await balance(d.currency, d.market)).toBe(1000n * UNIT);
    receipts.liquidity = (await lpBalance()).toString();
  });

  await test.step("empty wallets see chain-specific missing USDC, RENT and gas messages", async () => {
    const emptyWalletContext = await context.browser()!.newContext({ baseURL: PREVIEW });
    const empty = await emptyWalletContext.newPage();
    await openWallet(empty, 0, ["0x000000000000000000000000000000000000dEaD"]);
    await empty.goto("/#/buy");
    await connectWallet(empty);
    await expect(empty.getByTestId("insufficient-funds")).toContainText("No USDC on");
    await expect(empty.getByTestId("pay-balance")).toContainText("0 USDC");
    await expect(empty.getByTestId("missing-gas")).toContainText("network fees");
    await expect(empty.getByRole("button", {name: "Confirm trade", exact: true})).toBeDisabled();
    await empty.getByRole("button", {name: "Sell", exact: true}).click();
    await expect(empty.getByTestId("insufficient-funds")).toContainText("No RENT on");
    await expect(empty.getByRole("button", {name: "Confirm trade", exact: true})).toBeDisabled();
    await empty.goto("/#/insurer");
    await expect(empty.getByTestId("liquidity-funds-warning")).toContainText("USDC to cover the displayed maximum");
    await expect(empty.getByRole("button", {name: "Add liquidity", exact: true})).toBeDisabled();
    await emptyWalletContext.close();
  });

  await test.step("renter buys, then sells RENT back through the real v4 router", async () => {
    await renter.goto("/#/buy?amount=3");
    await connectWallet(renter);
    await expect(renter.getByText("We filled in its current cost below", {exact: false})).toBeVisible();
    const targetSpend = Number(await renter.getByLabel("You pay (USDC)", {exact: true}).inputValue());
    expect(targetSpend).toBeGreaterThan(0.8);
    expect(targetSpend).toBeLessThan(1);
    await expect(renter.getByTestId("rent-current-price")).toContainText("Trading open");
    await renter.getByLabel("You pay (USDC)", {exact: true}).fill("100");
    await expect(renter.getByTestId("spot-conversion")).toContainText("100 USDC ÷");
    await expect(renter.getByTestId("price-impact-warning")).toContainText("too large for the available liquidity");
    await expect(renter.getByRole("button", {name: "Confirm trade", exact: true})).toBeDisabled();
    await expect(renter.getByTestId("coverage-request")).toHaveCount(0);
    await renter.getByLabel("You pay (USDC)", {exact: true}).fill("100001");
    await expect(renter.getByTestId("insufficient-funds")).toContainText("Not enough USDC");
    await expect(renter.getByTestId("insufficient-funds")).toContainText("1 more USDC");
    await renter.getByLabel("You pay (USDC)", {exact: true}).fill("1");
    await expect(renter.getByTestId("insufficient-funds")).toHaveCount(0);
    const cashBefore = await cashBalance(BUYER);
    await clickReady(renter, "Confirm trade");
    await expect.poll(() => rentBalance(BUYER)).toBeGreaterThan(3n * UNIT);
    expect(await cashBalance(BUYER)).toBe(cashBefore - UNIT);
    const bought = await rentBalance(BUYER);
    await renter.getByRole("button", {name: "Sell", exact: true}).click();
    await renter.getByLabel("You pay (RENT)", {exact: true}).fill("1");
    await clickReady(renter, "Confirm trade");
    await expect.poll(() => rentBalance(BUYER)).toBe(bought - UNIT);
    expect(await cashBalance(BUYER)).toBeGreaterThan(cashBefore - UNIT);
    receipts.renterRemaining = (await rentBalance(BUYER)).toString();
    await renter.goto("/#/market-view");
    await expect(renter.getByTestId("v4-price-history-chart")).toBeVisible();
    const swaps = await client.getLogs({
      address: d.poolManager,
      event: parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"),
      fromBlock: 0n, toBlock: "latest",
    });
    expect(swaps).toHaveLength(2);
    await expect(renter.getByTestId("v4-swap-point")).toHaveCount(swaps.length);
    await expect(renter.getByRole("heading", {name: "Recorded swap prices", exact: true})).toBeVisible();
    await expect(renter.getByTestId("v4-swap-row")).toHaveCount(swaps.length);
    for (const swap of swaps) {
      const token1PerToken0 = (Number(swap.args.sqrtPriceX96!) / 2 ** 96) ** 2;
      const expectedPrice = BigInt(d.market) < BigInt(d.currency) ? token1PerToken0 : 1 / token1PerToken0;
      const row = renter.locator(`[data-testid="v4-swap-row"][data-transaction="${swap.transactionHash}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(expectedPrice.toFixed(5));
    }
    receipts.historySwapTransactions = swaps.map(swap => swap.transactionHash);
    await dismissToasts(renter);
    await renter.screenshot({path: path.join(ART, "v4-market-history.png"), fullPage: true});
  });

  await test.step("observation window blocks trading, transfers and LP removal", async () => {
    await warp(OBS_START);
    await syncClock(insurer); await syncClock(renter);
    await insurer.reload();
    await expect(insurer.getByRole("button", {name: "Remove my liquidity", exact: true})).toBeDisabled();
    await expect(insurer.getByRole("button", {name: "Add liquidity", exact: true})).toBeDisabled();
    await renter.goto("/#/trade");
    await expect(renter.getByRole("button", {name: "Confirm trade", exact: true}).last()).toBeDisabled();
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "tradingOpen"})).toBe(false);
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "liquidityRemovalOpen"})).toBe(false);
    await expect(client.simulateContract({account: BUYER, address: d.market, abi: marketAbi, functionName: "transfer", args: [CREATOR, 1n]})).rejects.toThrow();
  });

  await test.step("browser verifies the TEST-key DKIM signature, submits and settles at 50%", async () => {
    await warp(SETTLE_TIME + 60n);
    await syncClock(renter); await syncClock(insurer);
    await renter.goto("/#/settle");
    await renter.getByLabel("Original email (.eml)", {exact: true}).setInputFiles(path.join(ART, "settlement-test-only.eml"));
    await expect(renter.getByTestId("signed-rent-summary")).toContainText("$97.99");
    await expect(renter.getByTestId("signed-rent-summary")).toContainText("0.5000 USDC");
    await expect(renter.getByTestId("signed-rent-summary")).toContainText("Signature checks passed locally");
    await expect(renter.getByTestId("v4-preflight")).not.toContainText("✕");
    await expect(renter.getByTestId("v4-preflight")).toContainText("RSA signature");
    await clickReady(renter, "Authenticate email on-chain");
    await expect.poll(() => client.readContract({address: d.oracle, abi: oracleAbi, functionName: "observationCount"})).toBe(2n);
    const observed = await client.readContract({address: d.oracle, abi: oracleAbi, functionName: "observations", args: [1n]});
    expect(observed[0]).toBe(SETTLE_TIME); expect(observed[1]).toBe(9799);
    await clickReady(renter, "Settle market");
    await expect.poll(() => client.readContract({address: d.market, abi: marketAbi, functionName: "settled"})).toBe(true);
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "payoutRatioWad"})).toBe(500_000_000_000_000_000n);
    await expect(renter.getByText("Already settled at 50.00% of maximum payout.")).toBeVisible();
    await dismissToasts(renter);
    await renter.screenshot({path: path.join(ART, "v4-signed-settlement.png"), fullPage: true});
  });

  await test.step("settlement unlocks LP inventory; renter and insurer redeem actual backing", async () => {
    await insurer.reload();
    await clickReady(insurer, "Remove my liquidity");
    await expect.poll(lpBalance).toBe(0n);
    for (const [page, who] of [[renter, BUYER], [insurer, CREATOR]] as const) {
      const rent = await rentBalance(who); const cash = await cashBalance(who);
      await page.goto("/#/redeem");
      await page.getByLabel("RENT to redeem", {exact: true}).fill(formatUnits(rent, 6));
      await clickReady(page, "Redeem RENT");
      await expect.poll(() => rentBalance(who)).toBe(0n);
      expect(await cashBalance(who)).toBe(cash + rent / 2n);
      receipts[`payout-${who}`] = (rent / 2n).toString();
    }
    const paid = await client.readContract({address: d.market, abi: marketAbi, functionName: "paidOut"});
    expect(await balance(d.currency, d.market)).toBe(1000n * UNIT - paid);
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "residualOf", args: [CREATOR]})).toBe(0n);
  });

  await test.step("claim expiry returns exactly remaining escrow to original insurer", async () => {
    await warp(CLAIM_END + 1n);
    await syncClock(insurer);
    const residual = await balance(d.currency, d.market);
    const before = await cashBalance(CREATOR);
    await insurer.goto("/#/insurer");
    const withdraw = insurer.getByRole("button", {name: /^Withdraw [\d,.]+ USDC$/});
    await expect(withdraw).toBeEnabled(); await withdraw.click();
    await expect.poll(() => balance(d.currency, d.market)).toBe(0n);
    expect(await cashBalance(CREATOR)).toBe(before + residual);
    expect(await client.readContract({address: d.market, abi: marketAbi, functionName: "escrowAccounted"})).toBe(0n);
    receipts.residual = residual.toString();
    receipts.finalEscrow = "0";
    fs.writeFileSync(path.join(ART, "verified-lifecycle.json"), JSON.stringify(receipts, null, 2));
    await dismissToasts(insurer);
    await insurer.screenshot({path: path.join(ART, "v4-residual-complete.png"), fullPage: true});
  });
});
