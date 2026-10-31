// Owns the stack for the neighborhood-policy suite:
//   1. anvil --fork-url <Arbitrum One> on 127.0.0.1:8551 (real chainId 42161)
//   2. a TEST-KEY ApartmentsRentOracle + CoverToken + ApartmentsCoverPool on the
//      fork (script/DeployApartmentsFork.s.sol, broadcast from an impersonated
//      fresh deployer: no private key anywhere). The real Google key cannot
//      sign a future month, so the suite records a synthetic email signed with
//      fixtures/testkey instead. The live contracts are untouched.
//   3. fresh wallets funded with fork ETH and real on-fork USDC from a whale
//   4. a production `vite build` with TWO temporary files: the legacy
//      web/src/deployment.json naming chainId 42161 (so VITE_RPC_URL pins the
//      app's Arbitrum transport to the fork, see web/src/chain/wagmi.ts) and
//      web/src/chain/apartments-deployment.json naming the fork addresses.
//      Both are restored in teardown (and on setup failure). Served on :5177.
// Nothing is ever broadcast to real Arbitrum; the upstream RPC only serves reads.
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, parseUnits } from "viem";
import {
  ALL_WALLETS, APARTMENTS_DEPLOYMENT_BAK, APARTMENTS_DEPLOYMENT_PATH, ART_DIR, BROKE, BUYER, BUYER2, CREATOR, DEPLOYER, FORK_PORT, FORK_RPC_URL,
  LEGACY_DEPLOYMENT_BAK, LEGACY_DEPLOYMENT_PATH, PIDS_PATH, POOR, PREVIEW_PORT, PREVIEW_URL, REPO_ROOT, UPSTREAM_RPC_URL, USDC, USDC_WHALE,
  chainNow, erc20Abi, fundUsdc, rpc, sendAs, writeState,
} from "./support";
import { restoreFiles } from "./global-teardown";

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
  return String(res.stdout ?? "");
}

async function waitFor(probe: () => Promise<boolean>, what: string, tries = 480): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const forkUp = async () => (await rpc<string>("eth_chainId")) === "0xa4b1";
const previewUp = async () => (await fetch(PREVIEW_URL)).ok;

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const pids: { anvil?: number; preview?: number } = {};
  const savePids = () => fs.writeFileSync(PIDS_PATH, JSON.stringify(pids));
  try {
    // 1. Fork.
    const anvil = spawn("anvil", [
      "--host", "127.0.0.1", "--port", String(FORK_PORT), "--fork-url", UPSTREAM_RPC_URL, "--auto-impersonate", "--silent",
    ], { cwd: REPO_ROOT, detached: true, stdio: "ignore" });
    anvil.unref();
    pids.anvil = anvil.pid;
    savePids();
    await waitFor(forkUp, `anvil fork of ${UPSTREAM_RPC_URL} on :${FORK_PORT}`);

    // Fresh, code-less wallets (anvil dev keys carry 7702 sweeper code on real chains).
    for (const who of ALL_WALLETS) {
      const code = await rpc<string>("eth_getCode", [who, "latest"]);
      if (code !== "0x") throw new Error(`${who} unexpectedly has code on the fork`);
      if (who !== BROKE) await rpc("anvil_setBalance", [who, "0x8ac7230489e80000"]); // 10 ETH
    }
    await rpc("anvil_setBalance", [USDC_WHALE, "0x8ac7230489e80000"]);

    // 2. Test-key oracle + token + pool.
    const modulusHex = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "fixtures/testkey/meta.json"), "utf8")).modulus_hex as string;
    run("forge", [
      "script", "script/DeployApartmentsFork.s.sol:DeployApartmentsFork", "--rpc-url", FORK_RPC_URL, "--broadcast", "--unlocked", "--sender", DEPLOYER,
    ], {
      env: { ...process.env, MODULUS: modulusHex, CURRENCY: USDC, DEPLOYER, FORK_RPC_URL, FOUNDRY_OUT: "out-policies", FOUNDRY_CACHE_PATH: "cache-policies" },
    });
    const runFile = path.join(REPO_ROOT, "broadcast", "DeployApartmentsFork.s.sol", "42161", "run-latest.json");
    const byName: Record<string, `0x${string}`> = {};
    for (const tx of JSON.parse(fs.readFileSync(runFile, "utf8")).transactions ?? []) {
      if (tx.transactionType === "CREATE" && tx.contractName) byName[tx.contractName] = tx.contractAddress;
    }
    const need = (n: string) => { const a = byName[n]; if (!a) throw new Error(`broadcast has no CREATE for ${n}`); return a; };
    const oracle = need("ApartmentsRentOracle");
    const token = need("CoverToken");
    const pool = need("ApartmentsCoverPool");

    // 3. Funds: USDC from the whale, ETH already set (BROKE keeps zero ETH).
    await fundUsdc(CREATOR, parseUnits("1000", 6));
    await fundUsdc(BUYER, parseUnits("100", 6));
    await fundUsdc(BUYER2, parseUnits("100", 6));
    await fundUsdc(BROKE, parseUnits("50", 6));
    void POOR; // ETH only
    // Sanity: the whale transfer path works and balances are real USDC.
    const bal = BigInt(await rpc<string>("eth_call", [{ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [BUYER] }) }, "latest"]));
    if (bal !== parseUnits("100", 6)) throw new Error(`buyer USDC funding failed: ${bal}`);
    void sendAs;

    const now = await chainNow();
    const d = new Date(Number(now) * 1000);
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const month = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    writeState({ oracle, token, pool, ids: {}, month });

    // 4. Build with temporary deployment files; teardown restores them.
    fs.rmSync(LEGACY_DEPLOYMENT_BAK, { force: true });
    fs.rmSync(APARTMENTS_DEPLOYMENT_BAK, { force: true });
    if (fs.existsSync(LEGACY_DEPLOYMENT_PATH)) fs.copyFileSync(LEGACY_DEPLOYMENT_PATH, LEGACY_DEPLOYMENT_BAK);
    fs.copyFileSync(APARTMENTS_DEPLOYMENT_PATH, APARTMENTS_DEPLOYMENT_BAK);
    fs.writeFileSync(LEGACY_DEPLOYMENT_PATH, JSON.stringify({ chainId: 42161, oracle, pool, token, currency: USDC, seriesIds: [] }, null, 2) + "\n");
    fs.writeFileSync(APARTMENTS_DEPLOYMENT_PATH, JSON.stringify({ chainId: 42161, oracle, token, pool }, null, 2) + "\n");
    if (!fs.existsSync(path.join(REPO_ROOT, "web", "node_modules"))) run("npm", ["--prefix", "web", "install"]);
    run("npm", ["--prefix", "web", "run", "build"], { env: { ...process.env, VITE_RPC_URL: FORK_RPC_URL } });
    // The build has the addresses baked in: put the committed files back now.
    restoreFiles();

    const preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
      cwd: path.join(REPO_ROOT, "web"), detached: true, stdio: "ignore",
    });
    preview.unref();
    pids.preview = preview.pid;
    savePids();
    await waitFor(previewUp, `vite preview on :${PREVIEW_PORT}`);
  } catch (e) {
    restoreFiles();
    throw e;
  }
}
