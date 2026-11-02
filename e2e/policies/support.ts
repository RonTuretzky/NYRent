// Shared constants and helpers for the neighborhood-policy browser suite.
// Everything runs against an anvil fork of Arbitrum One on 127.0.0.1:8551
// (real chainId 42161) with a TEST-KEY oracle, a V1 pool and token
// (script/DeployApartmentsFork.s.sol) and a V2 pool and token on that same
// oracle (deployed by global-setup from forge artifacts), and a production
// build on 127.0.0.1:5177.
// The only remote traffic is anvil lazily fetching forked state. No private key
// is read anywhere: every sender is a fresh address anvil impersonates.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, toBytes } from "viem";
import { arbitrum } from "viem/chains";
import { installTestWallet } from "../../web/e2e-shim/wallet-shim";

export const FORK_PORT = 8551;
export const FORK_RPC_URL = `http://127.0.0.1:${FORK_PORT}`;
export const PREVIEW_PORT = 5177;
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
export const CHAIN_ID = 42161;
export const UPSTREAM_RPC_URL = process.env.ARBITRUM_FORK_URL ?? "https://arb1.arbitrum.io/rpc";
/** Native (Circle) USDC on Arbitrum One: the pool currency, 6 decimals. */
export const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
/** Large on-fork USDC holder impersonated as the faucet (Hyperliquid bridge). */
export const USDC_WHALE = process.env.USDC_WHALE ?? "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

/** Fresh, code-less addresses (re-verified by setup). Never anvil dev keys. */
export const DEPLOYER = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0240" as const;
export const CREATOR = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0241" as const;
export const BUYER = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0242" as const;
export const BUYER2 = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0243" as const;
/** ETH only, no USDC. */
export const POOR = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0244" as const;
/** USDC only, zero ETH. */
export const BROKE = "0xe2ee1d3b84b7d4a1cbd5e48d1c43683e5c0f0245" as const;
export const ALL_WALLETS = [DEPLOYER, CREATOR, BUYER, BUYER2, POOR, BROKE] as const;

export const USDC_1 = 1_000000n;
export const DAY = 86_400n;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const ART_DIR = path.join(HERE, ".artifacts");
export const PIDS_PATH = path.join(ART_DIR, "pids.json");
export const STATE_PATH = path.join(ART_DIR, "state.json");
export const APARTMENTS_DEPLOYMENT_PATH = path.join(REPO_ROOT, "web/src/chain/apartments-deployment.json");
export const APARTMENTS_DEPLOYMENT_BAK = path.join(ART_DIR, "apartments-deployment.json.bak");
export const SHOT_DIR = process.env.SHOT_DIR;
export const CREDAILY_EML = path.join(REPO_ROOT, "fixtures/credaily-2026-09-17/credaily-cpace-2026-09-17.eml");

export type Version = "v1" | "v2";

export interface State {
  oracle: `0x${string}`;
  /** The V2 claim token and pool: every policy created through the UI. */
  token: `0x${string}`;
  pool: `0x${string}`;
  /** The V1 pool and token on the same oracle (earlier rules). */
  v1: { pool: `0x${string}`; token: `0x${string}` };
  /** Populated by the specs as they create policies (V1 ones are keyed v1*). */
  ids: Record<string, number>;
  /** YYYY-MM of the first selectable policy month at setup time. */
  month: string;
}
export const readState = (): State => JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
export const writeState = (s: State) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n");
export function remember(key: string, id: number) {
  const s = readState();
  s.ids[key] = id;
  writeState(s);
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
]);
export const poolAbi = parseAbi([
  "function seriesCount() view returns (uint256)",
  "struct Series { address creator; uint32 strikeLowCents; uint32 strikeHighCents; uint16 premiumRateBps; uint32 obsMonth; bool settled; bool voided; bool cancelled; bool residualWithdrawn; uint64 saleEnd; uint64 finalizeAt; uint64 redeemEnd; uint64 payoutRatioWad; uint64 observationT; uint128 escrow; uint128 sold; uint128 premiumsAccrued; uint128 paidOut; bytes32 slugHash; bytes32 emailId; }",
  "function series(uint256) view returns (Series memory)",
  "function createSeries(string slug, uint32 obsMonth, uint32 strikeLowCents, uint32 strikeHighCents, uint16 premiumRateBps, uint64 saleEnd, uint64 redeemEnd, uint128 capacity) returns (uint256)",
  "function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium)",
  "function setSeriesPaused(uint256 seriesId, bool paused)",
  "function redeem(uint256 seriesId, uint256 amount)",
  "function SUBMISSION_GRACE() view returns (uint64)",
]);
export const tokenAbi = parseAbi(["function balanceOf(address, uint256) view returns (uint256)"]);
export const oracleAbi = parseAbi([
  "function earliest(bytes32, uint32) view returns (uint64, uint32, bytes32)",
  "function submitObservation(bytes signedHeaders, bytes canonBody, bytes sig)",
]);

export const client = createPublicClient({ chain: arbitrum, transport: http(FORK_RPC_URL) });

let rpcId = 0;
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(FORK_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

/** eth_sendTransaction from an impersonated sender; waits for success. */
export async function sendAs(from: `0x${string}`, to: `0x${string}`, data: `0x${string}`): Promise<void> {
  const hash = await rpc<`0x${string}`>("eth_sendTransaction", [{ from, to, data }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`fork tx ${hash} reverted (to ${to})`);
}

export const usdcBalance = (owner: `0x${string}`) =>
  client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
export const poolOf = (v: Version = "v2") => (v === "v1" ? readState().v1.pool : readState().pool);
export const tokenOf = (v: Version = "v2") => (v === "v1" ? readState().v1.token : readState().token);
export const claimBalance = (owner: `0x${string}`, id: number, v: Version = "v2") =>
  client.readContract({ address: tokenOf(v), abi: tokenAbi, functionName: "balanceOf", args: [owner, BigInt(id)] });
export const readSeries = (id: number, v: Version = "v2") =>
  client.readContract({ address: poolOf(v), abi: poolAbi, functionName: "series", args: [BigInt(id)] });
export const seriesCount = (v: Version = "v2") => client.readContract({ address: poolOf(v), abi: poolAbi, functionName: "seriesCount" });
export const earliest = (slug: string, yyyymm: number) =>
  client.readContract({ address: readState().oracle, abi: oracleAbi, functionName: "earliest", args: [keccak256(toBytes(slug)), yyyymm] });

export async function chainNow(): Promise<bigint> {
  return (await client.getBlock()).timestamp;
}

/** Forward-only warp of the fork clock. */
export async function warpTo(t: bigint): Promise<void> {
  const now = await chainNow();
  if (t <= now) return;
  await rpc("evm_setNextBlockTimestamp", [Number(t)]);
  await rpc("evm_mine");
}

export async function fundUsdc(to: `0x${string}`, amount: bigint): Promise<void> {
  await rpc("anvil_impersonateAccount", [USDC_WHALE]);
  await sendAs(USDC_WHALE as `0x${string}`, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }));
  await rpc("anvil_stopImpersonatingAccount", [USDC_WHALE]);
}

export async function approveAs(from: `0x${string}`, amount: bigint, v: Version = "v2"): Promise<void> {
  await sendAs(from, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [poolOf(v), amount] }));
}

export async function buyAs(from: `0x${string}`, id: number, maxClaim: bigint, maxPremium: bigint, v: Version = "v2"): Promise<void> {
  await sendAs(from, poolOf(v), encodeFunctionData({ abi: poolAbi, functionName: "buyProtection", args: [BigInt(id), maxClaim, maxPremium] }));
}

export async function setPausedAs(from: `0x${string}`, id: number, paused: boolean, v: Version = "v2"): Promise<void> {
  await sendAs(from, poolOf(v), encodeFunctionData({ abi: poolAbi, functionName: "setSeriesPaused", args: [BigInt(id), paused] }));
}

/** Records a test-key alert straight on the oracle (written with makeEml's `dumpCanon`). */
export async function recordAs(from: `0x${string}`, canonPrefix: string): Promise<void> {
  const hex = (ext: string) => `0x${fs.readFileSync(`${canonPrefix}.${ext}`).toString("hex")}` as `0x${string}`;
  await sendAs(from, readState().oracle, encodeFunctionData({
    abi: oracleAbi, functionName: "submitObservation", args: [hex("head"), hex("body"), hex("sig")],
  }));
}

/** Creates a policy straight on the contract (for scratch cases the UI does not need to drive). */
export async function createAs(from: `0x${string}`, args: {
  slug: string; obsMonth: number; low: number; high: number; bps: number; saleEnd: bigint; redeemEnd: bigint; capacity: bigint;
}, v: Version = "v2"): Promise<number> {
  const id = Number(await seriesCount(v));
  await approveAs(from, args.capacity, v);
  await sendAs(from, poolOf(v), encodeFunctionData({
    abi: poolAbi, functionName: "createSeries",
    args: [args.slug, args.obsMonth, args.low, args.high, args.bps, args.saleEnd, args.redeemEnd, args.capacity],
  }));
  return id;
}

export function monthBounds(yyyymm: number): { start: bigint; end: bigint } {
  const y = Math.floor(yyyymm / 100);
  const m = yyyymm % 100;
  return { start: BigInt(Date.UTC(y, m - 1, 1) / 1000), end: BigInt(Date.UTC(y, m, 1) / 1000 - 1) };
}
export const yyyymm = (month: string) => Number(month.replace("-", ""));
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (ym: number) => `${MONTH_NAMES[(ym % 100) - 1]} ${Math.floor(ym / 100)}`;

/** Writes a test-key-signed Google Alert .eml into .artifacts and returns its path. */
export function makeEml(name: string, opts: {
  slug: string; label: string; dollars: string; month: string; t: bigint; sentenceMonth?: string; bedroom?: boolean; dumpCanon?: boolean;
}): string {
  const out = path.join(ART_DIR, `${name}.eml`);
  const args = [
    path.join(REPO_ROOT, "scripts/make-google-alert-eml.py"),
    "--out", out, "--slug", opts.slug, "--name", opts.label, "--dollars", opts.dollars, "--month", opts.month, "--t", String(opts.t),
  ];
  if (opts.sentenceMonth) args.push("--sentence-month", opts.sentenceMonth);
  if (opts.bedroom) args.push("--bedroom");
  if (opts.dumpCanon) args.push("--dump-canon", path.join(ART_DIR, name));
  const res = spawnSync("python3", args, { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) throw new Error(`make-google-alert-eml failed: ${res.stderr}`);
  return out;
}

/**
 * Waits until the header shows a connected wallet: RainbowKit's account chip,
 * or its "Wrong network" chip when the shim sits on another chain. Clicks
 * through the connect modal if auto-connect did not happen.
 */
export async function connectWallet(page: Page): Promise<void> {
  const account = page.locator('[data-testid="rk-account-button"], [data-testid="rk-wrong-network-button"]').first();
  const autoConnected = await account.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
  if (autoConnected) return;
  const connect = page.getByRole("button", { name: /connect wallet/i }).first();
  if (await connect.isVisible().catch(() => false)) {
    // A late auto-connect can detach the button mid-click; the chip below is the real postcondition.
    await connect.click().catch(() => {});
    const wallet = page.getByRole("button", { name: /E2E Test Wallet|Injected|Browser/i }).first();
    if (await wallet.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false)) {
      await wallet.click().catch(() => {});
    }
  }
  await expect(account).toBeVisible({ timeout: 15000 });
}

/**
 * Opens `path` as `address` with the shim wallet pointed at the fork. The
 * browser clock is shifted to the fork clock (the app judges every window by
 * Date.now(), and the specs warp the chain forward).
 */
export async function openAs(page: Page, address: string | null, hashPath: string, opts: { walletChainId?: number; knownChainIds?: number[]; connect?: boolean } = {}): Promise<void> {
  const offsetMs = Number((await chainNow()) - BigInt(Math.floor(Date.now() / 1000))) * 1000;
  await page.addInitScript((ms) => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + ms;
  }, offsetMs);
  if (address) {
    await page.addInitScript(installTestWallet, {
      rpcUrl: FORK_RPC_URL,
      address,
      chainId: opts.walletChainId ?? CHAIN_ID,
      knownChainIds: opts.knownChainIds ?? [CHAIN_ID, 100],
      // Reloads (pending-transaction resume) must come back connected without a race.
      preauthorized: true,
    });
  }
  // A hash-only change would not reload (and would keep an older clock offset).
  if (page.url() !== "about:blank") await page.goto("about:blank");
  await page.goto(`/#${hashPath}`);
  // wagmi auto-connects the shim on mount; `connect: false` skips waiting for
  // the header account chip (narrow viewports render it differently).
  if (address && opts.connect !== false) await connectWallet(page);
}

/**
 * Walks the approve step if the page shows one (a previous failed attempt may
 * have left an allowance behind) and waits for the real action button.
 */
export async function ensureApproved(page: Page, action = "buy-submit"): Promise<void> {
  const approve = page.getByTestId("approve-button");
  const main = page.getByTestId(action);
  await expect(approve.or(main)).toBeVisible();
  if (await approve.isVisible().catch(() => false)) {
    await approve.click();
    await expect(page.getByTestId("approved-ok")).toBeVisible();
  }
  await expect(main).toBeVisible();
}

export async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

/** Makes the shim refuse the next eth_sendTransaction like a user clicking Reject. */
export async function rejectNextSend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown>; __orig?: (a: { method: string }) => Promise<unknown> } };
    w.ethereum.__orig = w.ethereum.request;
    w.ethereum.request = async (args) => {
      if (args.method === "eth_sendTransaction") {
        w.ethereum.request = w.ethereum.__orig!;
        const err = new Error("User rejected the request.") as Error & { code: number };
        err.code = 4001;
        throw err;
      }
      return w.ethereum.__orig!(args);
    };
  });
}

/** Blocks every browser → fork RPC request (reads and writes) until `unblock`. */
export async function blockRpc(page: Page): Promise<() => Promise<void>> {
  const pattern = `${FORK_RPC_URL}/**`;
  await page.route(pattern, (route) => route.abort("connectionrefused"));
  return () => page.unroute(pattern);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(widths.scroll, `horizontal overflow ${widths.scroll}>${widths.client}`).toBeLessThanOrEqual(widths.client);
}

export { expect };
