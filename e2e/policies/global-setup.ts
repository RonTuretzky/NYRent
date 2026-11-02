// Owns the stack for the neighborhood-policy suite:
//   1. anvil --fork-url <Arbitrum One> on 127.0.0.1:8551 (real chainId 42161)
//   2. a TEST-KEY ApartmentsRentOracle with a V1 CoverToken + ApartmentsCoverPool
//      (script/DeployApartmentsFork.s.sol) and a V2 CoverToken +
//      ApartmentsCoverPoolV2 on the same oracle (created here from forge
//      artifacts), all sent from an impersonated fresh deployer: no private key
//      anywhere. The real Google key cannot sign a future month, so the suite
//      records synthetic emails signed with fixtures/testkey. The live
//      contracts are untouched.
//   3. fresh wallets funded with fork ETH and real on-fork USDC from a whale
//   4. a production `vite build` with VITE_RPC_URL pinning the app's only
//      (Arbitrum) transport to the fork, and a temporary
//      web/src/chain/apartments-deployment.json naming the fork addresses,
//      restored right after the build (and in teardown or on failure).
//      Served on :5177.
// Nothing is ever broadcast to real Arbitrum; the upstream RPC only serves reads.
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { encodeAbiParameters, encodeFunctionData, getContractAddress, parseUnits, type Hex } from "viem";
import {
  ALL_WALLETS, APARTMENTS_DEPLOYMENT_BAK, APARTMENTS_DEPLOYMENT_PATH, ART_DIR, BROKE, BUYER, BUYER2, CREATOR, DEPLOYER, FORK_PORT, FORK_RPC_URL,
  PIDS_PATH, POOR, PREVIEW_PORT, PREVIEW_URL, REPO_ROOT, UPSTREAM_RPC_URL, USDC, USDC_WHALE,
  chainNow, client, erc20Abi, fundUsdc, rpc, sendAs, writeState,
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

const FOUNDRY_ENV = { FOUNDRY_OUT: "out-policies", FOUNDRY_CACHE_PATH: "cache-policies" };

function bytecode(file: string, name: string): Hex {
  const artifact = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "out-policies", file, `${name}.json`), "utf8"));
  return artifact.bytecode.object as Hex;
}

/** CREATE from the impersonated deployer; returns the new contract's address. */
async function deployAs(from: `0x${string}`, data: Hex): Promise<`0x${string}`> {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, data, gas: "0x1c9c380" }]);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`fork deploy ${hash} failed`);
  return receipt.contractAddress;
}

/** A V2 claim token and pool on `oracle`, mirroring script/DeployApartmentsV2.s.sol (which needs a key and the real modulus). */
async function deployV2(oracle: `0x${string}`): Promise<{ pool: `0x${string}`; token: `0x${string}` }> {
  run("forge", ["build", "src/apartments/ApartmentsCoverPoolV2.sol", "src/CoverToken.sol"], { env: { ...process.env, ...FOUNDRY_ENV } });
  const nonce = BigInt(await rpc<string>("eth_getTransactionCount", [DEPLOYER, "latest"]));
  const predictedPool = getContractAddress({ from: DEPLOYER, nonce: nonce + 1n });
  const token = await deployAs(DEPLOYER, (bytecode("CoverToken.sol", "CoverToken") +
    encodeAbiParameters([{ type: "address" }, { type: "uint8" }], [predictedPool, 6]).slice(2)) as Hex);
  const pool = await deployAs(DEPLOYER, (bytecode("ApartmentsCoverPoolV2.sol", "ApartmentsCoverPoolV2") +
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [USDC, token, oracle]).slice(2)) as Hex);
  if (pool.toLowerCase() !== predictedPool.toLowerCase()) throw new Error(`V2 pool landed at ${pool}, token expects ${predictedPool}`);
  return { pool, token };
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

    // 2. POLICIES_LIVE=1 drives the deployed contracts (both pools) on the fork;
    //    otherwise a test-key oracle with a V1 and a V2 pool. Live mode cannot
    //    record synthetic emails, so it runs the specs before 03;
    //    test/apartments/LiveArbitrumFork.t.sol settles with a real email.
    type Pair = { pool: `0x${string}`; token: `0x${string}` };
    const live = JSON.parse(fs.readFileSync(APARTMENTS_DEPLOYMENT_PATH, "utf8")) as { oracle: `0x${string}`; v1: Pair; v2: Pair };
    let oracle = live.oracle;
    let v1 = live.v1;
    let v2 = live.v2;
    if (process.env.POLICIES_LIVE !== "1") {
      const modulusHex = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "fixtures/testkey/meta.json"), "utf8")).modulus_hex as string;
      run("forge", [
        "script", "script/DeployApartmentsFork.s.sol:DeployApartmentsFork", "--rpc-url", FORK_RPC_URL, "--broadcast", "--unlocked", "--sender", DEPLOYER,
      ], {
        env: { ...process.env, MODULUS: modulusHex, CURRENCY: USDC, DEPLOYER, FORK_RPC_URL, ...FOUNDRY_ENV },
      });
      const runFile = path.join(REPO_ROOT, "broadcast", "DeployApartmentsFork.s.sol", "42161", "run-latest.json");
      const byName: Record<string, `0x${string}`> = {};
      for (const tx of JSON.parse(fs.readFileSync(runFile, "utf8")).transactions ?? []) {
        if (tx.transactionType === "CREATE" && tx.contractName) byName[tx.contractName] = tx.contractAddress;
      }
      const need = (n: string) => { const a = byName[n]; if (!a) throw new Error(`broadcast has no CREATE for ${n}`); return a; };
      oracle = need("ApartmentsRentOracle");
      v1 = { token: need("CoverToken"), pool: need("ApartmentsCoverPool") };
      v2 = await deployV2(oracle);
    }

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
    writeState({ oracle, token: v2.token, pool: v2.pool, v1, ids: {}, month });

    // 4. Build with a temporary deployment file; teardown restores it.
    fs.rmSync(APARTMENTS_DEPLOYMENT_BAK, { force: true });
    fs.copyFileSync(APARTMENTS_DEPLOYMENT_PATH, APARTMENTS_DEPLOYMENT_BAK);
    fs.writeFileSync(APARTMENTS_DEPLOYMENT_PATH, JSON.stringify({ chainId: 42161, oracle, v2, v1 }, null, 2) + "\n");
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
