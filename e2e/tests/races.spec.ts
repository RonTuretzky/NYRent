// Mid-flow race tests: chain state changes UNDER an already-rendered page, the
// user clicks anyway, and the simulate-first useTx flow must surface the
// decoded custom-error copy — not a generic failure.
//
// Runs AFTER journey.spec.ts (alphabetical path order, single worker), so series 0
// is already settled and fully redeemed. Every test builds its own scratch series
// on top of that state inside an anvil evm_snapshot and reverts it afterwards,
// leaving the chain exactly as journey left it.
import { test, expect, type Page } from "@playwright/test";
import { parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import {
  ACCOUNTS,
  RPC_URL,
  connectWallet,
  deployment,
  installWallet,
  publicClient,
  walletClient,
} from "../support/helpers";

const SPONSOR = ACCOUNTS[0];
const BUYER = ACCOUNTS[1];

const MAX_CLAIM = parseEther("0.001");
const PREMIUM = (MAX_CLAIM * 2850n) / 10_000n; // series rate is 2850 bps
// Ground truth of the fixture email already recorded as oracle observation #0
// during journey.spec.ts (SPEC §0 / meta.json).
const OBS_T = 1_789_642_464n;

const poolWriteAbi = parseAbi([
  "function createSeries(uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 obsStart, uint64 obsEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
  "function setSalesPaused(bool paused)",
  "function settle(uint256 seriesId, uint256 obsIndex)",
  "function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium)",
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

async function chainNow(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Creates a scratch series with an OPEN sale window whose observation window
 * contains the already-recorded observation #0, so it can be settled at any
 * moment via RPC. Returns the new series id.
 */
async function createScratchSeries(): Promise<number> {
  const id = Number(
    await publicClient.readContract({
      address: deployment().pool,
      abi: poolWriteAbi,
      functionName: "seriesCount",
    }),
  );
  const now = await chainNow();
  const saleEnd = now + 3_600n;
  const obsEnd = saleEnd; // createSeries requires saleEnd <= obsEnd
  await write(SPONSOR, deployment().pool, poolWriteAbi, "createSeries", [
    8800, // strikeLowCents — same strikes as the demo series
    9600, // strikeHighCents
    2850, // premiumRateBps
    saleEnd,
    OBS_T - 1_000n, // obsStart: the recorded observation qualifies
    obsEnd,
    now + 90n * 86_400n, // redeemEnd
    parseEther("0.02"),
  ]);
  return id;
}

/**
 * Fills the buy form for the scratch series and walks the approve step, leaving
 * the page one click away from buyProtection.
 */
async function armBuy(page: Page, seriesId: number): Promise<void> {
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

test("buy raced by the sponsor pausing sales shows the decoded paused copy", async ({
  page,
}) => {
  const seriesId = await createScratchSeries();
  await armBuy(page, seriesId);

  // Race: the sponsor pauses sales AFTER the page rendered an open sale.
  await write(SPONSOR, deployment().pool, poolWriteAbi, "setSalesPaused", [true]);
  await page.getByTestId("buy-button").click();

  // Simulation-first useTx decodes SalesArePaused before any wallet interaction.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("Sales are currently paused by the sponsor");

  // A fresh render of the same page shows the dedicated paused empty state.
  await page.reload();
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Sales paused");
});

test("buy raced by settlement shows the decoded sale-closed copy", async ({
  page,
}) => {
  const seriesId = await createScratchSeries();
  await armBuy(page, seriesId);

  // Race: someone settles the series (observation #0 qualifies) mid-flow.
  await write(SPONSOR, deployment().pool, poolWriteAbi, "settle", [
    BigInt(seriesId),
    0n,
  ]);
  await page.getByTestId("buy-button").click();

  // buyProtection reverts SaleClosed once settled; the copy names both causes.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("has already settled");

  await page.reload();
  const empty = page.getByTestId("empty-state");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Series settled");
});

test("redeem raced by a redeem in another tab shows the balance-changed copy", async ({
  page,
}) => {
  const seriesId = await createScratchSeries();

  // Buyer holds 0.001 of cover on the scratch series, which then settles at 61%.
  await write(BUYER, deployment().currency, erc20Abi, "approve", [
    deployment().pool,
    PREMIUM,
  ]);
  await write(BUYER, deployment().pool, poolWriteAbi, "buyProtection", [
    BigInt(seriesId),
    MAX_CLAIM,
    PREMIUM,
  ]);
  await write(SPONSOR, deployment().pool, poolWriteAbi, "settle", [
    BigInt(seriesId),
    0n,
  ]);

  await installWallet(page, { accountIndex: 1 });
  await page.goto(`/#/redeem/${seriesId}`);
  await connectWallet(page);
  await page.getByTestId("redeem-amount").fill("0.001");
  await expect(page.getByTestId("redeem-button")).toBeEnabled({
    timeout: 45000,
  });

  // Race: the full balance is redeemed from "another tab" (direct RPC).
  await write(BUYER, deployment().pool, poolWriteAbi, "redeem", [
    BigInt(seriesId),
    MAX_CLAIM,
  ]);
  await page.getByTestId("redeem-button").click();

  // token.burn reverts ERC1155InsufficientBalance; the copy explains the race.
  const error = page.getByTestId("tx-reverted");
  await expect(error).toContainText("You no longer hold that much cover");
});
