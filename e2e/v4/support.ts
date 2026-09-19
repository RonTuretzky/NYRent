import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { foundry } from "viem/chains";
import { ART, ROOT, RPC, CREATOR, BUYER } from "./constants";
export { connectWallet } from "../support/helpers";
export const client = createPublicClient({chain: foundry, transport: http(RPC)});
export const testClient = createTestClient({chain: foundry, mode: "anvil", transport: http(RPC)});
export const wallet = createWalletClient({chain: foundry, transport: http(RPC)});
export const marketAbi = parseAbi([
  "function totalSupply() view returns (uint256)", "function totalDeposited() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function escrowAccounted() view returns (uint256)",
  "function settled() view returns (bool)", "function payoutRatioWad() view returns (uint64)",
  "function residualOf(address) view returns (uint256)", "function paidOut() view returns (uint256)",
  "function residualPaid() view returns (uint256)", "function tradingOpen() view returns (bool)",
  "function liquidityRemovalOpen() view returns (bool)", "function transfer(address,uint256) returns (bool)",
]);
export const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export const oracleAbi = parseAbi(["function observationCount() view returns (uint256)", "function observations(uint256) view returns (uint64,uint32,bytes32)"]);
export const routerAbi = parseAbi(["function liquidityOf(address,address,int24,int24) view returns (uint128)"]);
export type Deployment = { market: Address; oracle: Address; currency: Address; router: Address; hook: Address; poolManager: Address };
export const deployment = (): Deployment => JSON.parse(fs.readFileSync(path.join(ART, "v4-deployments.json"), "utf8"))["31337"];
export const balance = (token: Address, holder: Address) => client.readContract({address: token, abi: tokenAbi, functionName: "balanceOf", args: [holder]});
export const rentBalance = (holder: Address) => balance(deployment().market, holder);
export const cashBalance = (holder: Address) => balance(deployment().currency, holder);
export const lpBalance = () => client.readContract({address: deployment().router, abi: routerAbi, functionName: "liquidityOf", args: [CREATOR, deployment().market, -887220, 887220]});
export async function warp(timestamp: bigint) {
  await testClient.setNextBlockTimestamp({timestamp}); await testClient.mine({blocks: 1});
}
export async function openWallet(page: Page, accountIndex: number) {
  await page.clock.install({time: new Date(Number((await client.getBlock()).timestamp) * 1000)});
  await page.addInitScript(config => { (window as unknown as {__E2E_WALLET_CONFIG: unknown}).__E2E_WALLET_CONFIG = config; }, {rpcUrl: RPC, chainIdHex: "0x7a69", accounts: [CREATOR, BUYER], accountIndex});
  await page.addInitScript({path: path.join(ROOT, "e2e/support/wallet-shim.js")});
}
export async function syncClock(page: Page) { await page.clock.setSystemTime(new Date(Number((await client.getBlock()).timestamp) * 1000)); }
export async function clickReady(page: Page, name: string) {
  const button = page.getByRole("button", {name, exact: true}).last();
  await expect(button).toBeEnabled(); await button.click();
}

/** Keep proof screenshots readable without changing application toast behavior. */
export async function dismissToasts(page: Page) {
  const dismiss = page.getByRole("button", {name: "Dismiss notification", exact: true});
  while (await dismiss.count()) await dismiss.first().click();
}
