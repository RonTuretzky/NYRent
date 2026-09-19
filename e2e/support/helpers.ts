import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi } from "viem";
import { foundry } from "viem/chains";

export const RPC_URL = "http://127.0.0.1:8547";
export const PREVIEW_URL = "http://127.0.0.1:5174"; // web/'s preview script pins 5174
export const CHAIN_ID = 31337;
export const CHAIN_ID_HEX = "0x7a69";

/**
 * The local chain's clock base (SPEC §7, Option B): anvil starts at 2026-09-10,
 * ~7.4 days BEFORE the fixture email's signed t. The deploy script pins demo
 * series 0 to saleEnd = obsStart = ANVIL_START_TS + 36h, obsEnd = obsStart + 30d,
 * so the sale is open at journey time and the fixture t sits inside the window.
 */
export const ANVIL_START_TS = 1789000000n;

/** Signed DKIM t= of the real fixture email (2026-09-17; ground truth, meta.json). */
export const FIXTURE_T = 1789642464n;

/**
 * Where the journey warps between its BUY and SETTLE steps: just past the fixture
 * t (mirrors test/RealEmail.t.sol). This is after demo series 0's obsStart
 * (start + 36h — sale closed, observation window open) and satisfies the oracle's
 * `t <= block.timestamp + 1 day` rule; it stays far inside obsEnd and redeemEnd,
 * so record/settle/redeem all work at this time.
 */
export const SETTLE_WARP_TS = 1789700000n;

/** Anvil's publicly known dev accounts — local test chain only, never real funds. */
export const ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // #0 deployer + sponsor
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // #1 buyer
] as const;
/**
 * Anvil's WELL-KNOWN dev private key #0 (printed by every `anvil` start; a public
 * constant of the tooling, not a secret). Used only to run the deploy script against
 * the throwaway local chain — never the real deployer key (SPEC §7/§8).
 */
export const ANVIL_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const FIXTURE_EML = path.join(
  REPO_ROOT,
  "fixtures/credaily-2026-09-17/credaily-cpace-2026-09-17.eml",
);
export const DEPLOYMENT_PATH = path.join(REPO_ROOT, "web/src/deployment.json");

export interface Deployment {
  chainId: number;
  oracle: `0x${string}`;
  pool: `0x${string}`;
  token: `0x${string}`;
  currency: `0x${string}`;
  seriesIds: number[];
}
export const deployment = (): Deployment =>
  JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) });
export const walletClient = createWalletClient({ chain: foundry, transport: http(RPC_URL) });
export const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) });

/**
 * Warp the local anvil clock to an ABSOLUTE unix timestamp and mine one block so
 * `block.timestamp` observes it immediately. Forward-only (anvil rejects going
 * back). The Option B journey MUST call `await warpTo(SETTLE_WARP_TS)` between its
 * BUY and SETTLE steps: demo series 0 stops selling at obsStart (= anvil start +
 * 36h, contract rule saleEnd <= obsStart) and the fixture email can only be
 * recorded once the chain clock is within 1 day of its signed t, so buys happen
 * at start time and settlement happens after the warp.
 */
export async function warpTo(timestamp: bigint): Promise<void> {
  await testClient.setNextBlockTimestamp({ timestamp });
  await testClient.mine({ blocks: 1 });
}

// Frozen SPEC §2 signatures only. The Integrate phase compiles the real ABIs; these
// minimal fragments keep the suite independent of Foundry build artifacts.
export const oracleAbi = parseAbi([
  "function observationCount() view returns (uint256)",
  "function observations(uint256) view returns (uint64 t, uint32 cents, bytes32 emailId)",
  "function modulus() view returns (bytes)",
]);
export const currencyAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function deposit() payable",
  "function symbol() view returns (string)",
]);
export const coverTokenAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
export const poolViewAbi = parseAbi(["function currency() view returns (address)"]);

export const currencyBalance = (holder: `0x${string}`) =>
  publicClient.readContract({
    address: deployment().currency,
    abi: currencyAbi,
    functionName: "balanceOf",
    args: [holder],
  });
export const poolBalance = () => currencyBalance(deployment().pool);
export const coverBalance = (holder: `0x${string}`, seriesId: bigint) =>
  publicClient.readContract({
    address: deployment().token,
    abi: coverTokenAbi,
    functionName: "balanceOf",
    args: [holder, seriesId],
  });
export const observationCount = () =>
  publicClient.readContract({
    address: deployment().oracle,
    abi: oracleAbi,
    functionName: "observationCount",
  });
export const observation = (index: bigint) =>
  publicClient.readContract({
    address: deployment().oracle,
    abi: oracleAbi,
    functionName: "observations",
    args: [index],
  });

/**
 * Install the EIP-1193/EIP-6963 wallet shim before any app script runs.
 * `chainIdHex` other than 0x7a69 simulates a wallet sitting on the wrong network.
 */
export async function installWallet(
  page: Page,
  opts: { chainIdHex?: string; accountIndex?: number } = {},
): Promise<void> {
  const cfg = {
    rpcUrl: RPC_URL,
    chainIdHex: opts.chainIdHex ?? CHAIN_ID_HEX,
    accounts: [...ACCOUNTS],
    accountIndex: opts.accountIndex ?? 0,
  };
  await page.addInitScript((c) => {
    (window as unknown as { __E2E_WALLET_CONFIG: unknown }).__E2E_WALLET_CONFIG = c;
  }, cfg);
  await page.addInitScript({ path: path.join(HERE, "wallet-shim.js") });
}

/**
 * Connect through the app's RainbowKit ConnectButton + modal; no-op when already
 * connected. The app configures the injected wallet only (web/src/chain/wagmi.ts),
 * which RainbowKit lists as "Browser Wallet"; wagmi's EIP-6963 discovery may list
 * the shim as "E2E Test Wallet" instead.
 */
export async function connectWallet(page: Page): Promise<void> {
  const connect = page.getByRole("button", { name: /connect wallet/i }).first();
  if (!(await connect.isVisible().catch(() => false))) return;
  await connect.click();
  await page
    .getByRole("button", { name: /E2E Test Wallet|Injected|Browser/i })
    .first()
    .click();
  await expect(connect).toBeHidden();
}

/**
 * Drive an approve-then-act button pair (web/E2E.md): pool flows submit an ERC-20
 * `approve` first when allowance is insufficient, then enable the main button.
 */
export async function approveThen(page: Page, buttonTestId: string): Promise<void> {
  const approve = page.getByTestId("approve-button");
  await approve.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await approve.isVisible().catch(() => false)) {
    await expect(approve).toBeEnabled();
    await approve.click();
  }
  const main = page.getByTestId(buttonTestId);
  await expect(main).toBeEnabled({ timeout: 45000 });
  await main.click();
}

/** Switch the shim account and let wagmi observe accountsChanged. */
export const setAccount = (page: Page, index: number) =>
  page.evaluate(
    (i) =>
      (
        window as unknown as { __e2eWallet: { setAccount(i: number): void } }
      ).__e2eWallet.setAccount(i),
    index,
  );

/**
 * Real fixture with the printed rent edited inside the quoted-printable body:
 * the DKIM structure stays intact, the body hash no longer matches (preflight
 * must fail exactly the bh check).
 */
export function tamperedEml(): Buffer {
  const raw = fs.readFileSync(FIXTURE_EML);
  const at = raw.indexOf(Buffer.from("$92.88"));
  if (at < 0) throw new Error("fixture anchor $92.88 not found — fixture changed?");
  const out = Buffer.from(raw);
  Buffer.from("$99.99").copy(out, at);
  return out;
}
