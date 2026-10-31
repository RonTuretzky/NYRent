import { expect, test, type Page } from "@playwright/test";
import { installTestWallet } from "../../web/e2e-shim/wallet-shim";
import { encodeFunctionData, keccak256, parseAbi, toBytes } from "viem";
import { connectWallet } from "../support/helpers";

const RPC = "http://127.0.0.1:8599";
const CREATOR = "0x1000000000000000000000000000000000000c01";
const BUYER = "0x1000000000000000000000000000000000000b02";
const SHOTS = process.env.SHOT_DIR;

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** oracle.earliest(east-harlem-new-york-ny, 202610).t from the fork. */
async function recordedTimestamp() {
  const slugHash = keccak256(toBytes("east-harlem-new-york-ny"));
  const data = encodeFunctionData({
    abi: parseAbi(["function earliest(bytes32,uint32) view returns (uint64,uint32,bytes32)"]),
    args: [slugHash, 202610],
  });
  const result = await rpc("eth_call", [{ to: process.env.APARTMENTS_ORACLE, data }, "latest"]);
  return Number(BigInt(result.slice(0, 66)));
}

async function wrapped(owner: string) {
  const data = encodeFunctionData({
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    args: [owner as `0x${string}`],
  });
  return BigInt(await rpc("eth_call", [{ to: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", data }, "latest"]));
}

async function as(page: Page, address: string, path: string) {
  await page.addInitScript(installTestWallet, { rpcUrl: RPC, address, chainId: 100, knownChainIds: [100] });
  await page.goto(`/#${path}`);
  await connectWallet(page);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("create, buy, record a real alert, void, refund, withdraw", async ({ browser }) => {
  await rpc("anvil_autoImpersonateAccount", [true]);
  for (const a of [CREATOR, BUYER]) await rpc("anvil_setBalance", [a, "0x21E19E0C9BAB2400000"]);

  // Anyone creates and funds a policy.
  const creator = await (await browser.newContext()).newPage();
  await as(creator, CREATOR, "/policies/new");
  await creator.getByTestId("policy-capacity").fill("50");
  await creator.getByTestId("policy-premium").fill("10");
  await creator.getByTestId("policy-month").selectOption({ index: 1 });
  await creator.getByTestId("policy-accept").check();
  await shot(creator, "01-create-policy");
  await creator.getByRole("button", { name: /wrap funds/i }).click();
  await creator.getByRole("button", { name: /^approve/i }).click();
  await creator.getByTestId("policy-create").click();
  await expect(creator).toHaveURL(/policies\/\d+$/);
  await expect(creator.getByText("On sale", { exact: false })).toBeVisible();
  const id = creator.url().split("/").pop();

  // Someone else buys.
  const buyer = await (await browser.newContext()).newPage();
  await as(buyer, BUYER, `/policies/${id}`);
  await buyer.getByTestId("buy-amount").fill("20");
  await buyer.getByRole("button", { name: /wrap funds/i }).click();
  await buyer.getByRole("button", { name: /^approve/i }).click();
  await buyer.getByTestId("buy-submit").click();
  await expect(buyer.getByRole("heading", { name: "Your claim" })).toBeVisible();
  await shot(buyer, "02-policy-bought");

  await buyer.goto("/#/policies");
  await expect(buyer.getByTestId(`policy-${id}`)).toBeVisible();
  await shot(buyer, "03-policy-list");

  // Anyone records a rent from a real email; the browser-built calldata must verify.
  if (process.env.REAL_ALERT_EML) {
    await buyer.goto("/#/policies/submit");
    await buyer.getByTestId("alert-file").setInputFiles(process.env.REAL_ALERT_EML);
    await expect(buyer.getByText("publishes the full email permanently", { exact: false })).toBeVisible();
    await expect(buyer.getByTestId("alert-submit")).toBeDisabled();
    await buyer.getByTestId("alert-consent").check();
    await buyer.getByTestId("alert-submit").click();
    await expect.poll(recordedTimestamp, { timeout: 60000 }).toBeGreaterThan(0);
    await shot(buyer, "04-real-alert-recorded");
  }

  // With no email for the policy month it voids: premium back.
  const DAY = 86400;
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const start = Number(block.timestamp);
  await rpc("evm_setNextBlockTimestamp", [start + 75 * DAY]);
  await rpc("evm_mine");
  const later = await (await browser.newContext()).newPage();
  await later.addInitScript((ms) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + ms;
  }, 75 * DAY * 1000);
  await as(later, BUYER, `/policies/${id}`);
  const beforeClaim = await wrapped(BUYER);
  await later.getByTestId("redeem").click();
  await expect(later.getByText("Void: premiums refundable").first()).toBeVisible();
  await expect.poll(() => wrapped(BUYER)).toBe(beforeClaim + 2n * 10n ** 18n);
  await shot(later, "05-voided-refunded");

  // After claims close the creator recovers the escrow.
  await rpc("evm_setNextBlockTimestamp", [start + 110 * DAY]);
  await rpc("evm_mine");
  const end = await (await browser.newContext()).newPage();
  await end.addInitScript((ms) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + ms;
  }, 110 * DAY * 1000);
  await as(end, CREATOR, `/policies/${id}`);
  const beforeWithdraw = await wrapped(CREATOR);
  await end.getByRole("button", { name: "Withdraw remaining funds" }).click();
  await expect.poll(() => wrapped(CREATOR)).toBe(beforeWithdraw + 50n * 10n ** 18n);
  await shot(end, "06-creator-withdrew");
});
