// Mid-flow race tests: chain state changes UNDER an already-rendered page, the
// user clicks anyway, and the simulate-first useTx flow must surface the
// decoded custom-error copy — not a generic failure.
//
// Runs AFTER journey.spec.ts (alphabetical path order, single worker), so series 0
// is already settled with the buyer still holding 0.004 of cover. Tests that need
// an OPEN sale build their own scratch series on top of that state inside an anvil
// evm_snapshot and revert it afterwards, leaving the chain exactly as journey left
// it. On the permissionless pool a scratch series can never be settled mid-sale
// (saleEnd ≤ obsStart is a contract invariant and the only oracle observation is
// in the past), so the old settled-mid-flow race became the cancel and
// sale-window races below — same decode path, live causes.
import { test, expect, type Page } from "@playwright/test";
import { parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import {
  ACCOUNTS,
  RPC_URL,
  alignClock,
  chainNow,
  connectWallet,
  deployment,
  installWallet,
  publicClient,
  walletClient,
  warpTo,
} from "../support/helpers";

const CREATOR = ACCOUNTS[0];
const BUYER = ACCOUNTS[1];

const SERIES_0 = 0n; // settled at 61% by journey; buyer still holds 0.004
const HELD_COVER = parseEther("0.004"); // journey's unredeemed remainder
const SCRATCH_CAPACITY = parseEther("0.02");

const poolWriteAbi = parseAbi([
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
  "function setSeriesPaused(uint256 seriesId, bool paused)",
  "function cancelSeries(uint256 seriesId)",
  "function redeem(uint256 seriesId, uint256 amount)",
  "function seriesCount() view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
]);

let rpcId = 1_000;
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** Send a write from one of anvil's unlocked dev accounts and wait for it. */
async function write(
  account: `0x${string}`,
  address: `0x${string}`,
  abi: typeof poolWriteAbi | typeof erc20Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const hash = await walletClient.writeContract({
    account,
    address,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
    chain: foundry,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Creates a scratch series with an OPEN sale window, escrowed by the creator
 * (the permissionless pool pulls the capacity at create time). All windows
 * honour the contract rules: saleEnd ≤ obsStart < obsEnd < redeemEnd and a
 * ≥ 7-day claim window. Returns the new series id and its saleEnd.
 */
async function createScratchSeries(): Promise<{ id: number; saleEnd: bigint }> {
  const id = Number(
    await publicClient.readContract({
      address: deployment().pool,
      abi: poolWriteAbi,
      functionName: "seriesCount",
    }),
  );
  const now = await chainNow();
  const saleEnd = now + 3_600n;
  const obsStart = saleEnd;
  const obsEnd = obsStart + 3_600n;
  const redeemEnd = obsEnd + 8n * 86_400n; // ≥ obsEnd + MIN_REDEEM_WINDOW (7d)
  await write(CREATOR, deployment().currency, erc20Abi, "approve", [
    deployment().pool,
    SCRATCH_CAPACITY,
  ]);
  await write(CREATOR, deployment().pool, poolWriteAbi, "createSeries", [
    8800, // strikeLowCents — same strikes as the demo series
    9600, // strikeHighCents
    2850, // premiumRateBps
    saleEnd,
    obsStart,
    obsEnd,
    redeemEnd,
    SCRATCH_CAPACITY,
  ]);
  return { id, saleEnd };
}

/**
 * Fills the buy form for the scratch series and walks the approve step, leaving
 * the page one click away from buyProtection. The browser clock is pinned to
 * the (warped, past) chain clock first — the app gates the sale window on
 * Date.now().
 */
async function armBuy(page: Page, seriesId: number): Promise<void> {
  await alignClock(page);
  await installWallet(page, { accountIndex: 1 });
  await page.goto(`/#/buy/${seriesId}`);
  await connectWallet(page);
  await page.getByTestId("buy-amount").fill("0.001");
  const approve = page.getByTestId("approve-button");
  await approve.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await approve.isVisible().catch(() => false)) {
    await expect(approve).toBeEnabled();
    await approve.click();
  }
  await expect(page.getByTestId("buy-button")).toBeEnabled({ timeout: 45000 });
}

test.describe.configure({ mode: "serial" });

let snapshotId: string;

test.beforeEach(async () => {
  snapshotId = await rpc<string>("evm_snapshot");
});

test.afterEach(async () => {
  const ok = await rpc<boolean>("evm_revert", [snapshotId]);
  expect(ok).toBe(true);
});

test("buy raced by the creator pausing sales shows the decoded paused copy", async ({
  page,
}) => {
  const { id: seriesId } = await createScratchSeries();
  await armBuy(page, seriesId);

  // Race: the series creator pauses ITS sales AFTER the page rendered an open
  // sale (there is no global pause on the permissionless pool).
  await write(CREATOR, deployment().pool, poolWriteAbi, "setSeriesPaused", [
    BigInt(seriesId),
    true,
  ]);
  await page.getByTestId("buy-button").click();

  // Simulation-first useTx decodes SalesArePaused before any wallet interaction.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText(
    "Sales are currently paused by the series creator",
  );

  // A fresh render of the same page shows the dedicated paused empty state.
  await page.reload();
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Sales paused");
});

test("buy raced by the creator cancelling shows the decoded cancelled copy", async ({
  page,
}) => {
  const { id: seriesId } = await createScratchSeries();
  await armBuy(page, seriesId);

  // Race: nothing has sold yet, so the creator can still cancel and take the
  // escrow back — mid-flow, under the armed buy form.
  await write(CREATOR, deployment().pool, poolWriteAbi, "cancelSeries", [
    BigInt(seriesId),
  ]);
  await page.getByTestId("buy-button").click();

  // buyProtectionFor reverts SeriesClosed once cancelled.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("cancelled by its creator");

  await page.reload();
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Series cancelled");
});

test("redeem raced by a redeem in another tab shows the balance-changed copy", async ({
  page,
}) => {
  // Journey left the buyer holding 0.004 of settled series 0, claimable now.
  await alignClock(page);
  await installWallet(page, { accountIndex: 1 });
  await page.goto(`/#/redeem/${SERIES_0}`);
  await connectWallet(page);
  await page.getByTestId("redeem-amount").fill("0.001");
  await expect(page.getByTestId("redeem-button")).toBeEnabled({
    timeout: 45000,
  });

  // Race: the full remaining balance is redeemed from "another tab" (direct RPC).
  await write(BUYER, deployment().pool, poolWriteAbi, "redeem", [
    SERIES_0,
    HELD_COVER,
  ]);
  await page.getByTestId("redeem-button").click();

  // token.burn reverts ERC1155InsufficientBalance; the copy explains the race.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("You no longer hold that much cover");
});

// LAST in this file: it warps the chain clock forward (harmless for the later
// residual suite, which warps much further, but it must not run before the
// snapshot-scoped tests above in case evm_revert keeps anvil's time offset).
test("buy raced by the sale window closing shows the decoded closed copy", async ({
  page,
}) => {
  const { id: seriesId, saleEnd } = await createScratchSeries();
  await armBuy(page, seriesId);

  // Race: the chain clock passes saleEnd while the page still shows the sale
  // it rendered a moment ago.
  await warpTo(saleEnd + 60n);
  await page.getByTestId("buy-button").click();

  // buyProtectionFor reverts SaleClosed; the copy names both causes.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("Buying is closed for this series");

  // Let the BROWSER clock catch up with the warp, then a fresh render shows
  // the dedicated sale-closed empty state.
  await page.clock.fastForward(2 * 3_600 * 1000);
  await page.reload();
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Sale closed");
});
