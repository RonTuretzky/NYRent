// Owns the whole local stack for the browser suite (SPEC §7):
//   1. Anvil on 127.0.0.1:8547 (chainId 31337)
//   2. `forge script script/Deploy.s.sol:Deploy` broadcast with Anvil's WELL-KNOWN
//      dev key #0 — never the real deployer. Foundry writes to out-e2e/cache-e2e,
//      which the teardown deletes.
//   3. web/src/deployment.json written from the broadcast (previous copy backed up
//      and restored in teardown)
//   4. currency seeding: wraps native coin for sponsor + buyer (the local currency
//      deployed on 31337 must be WETH9-style, see e2e/README.md)
//   5. `vite build` + `vite preview` on 127.0.0.1:5174 (web/'s preview script)
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import {
  ACCOUNTS,
  ANVIL_KEY_0,
  DEPLOYMENT_PATH,
  PREVIEW_URL,
  RPC_URL,
  publicClient,
  walletClient,
} from "./support/helpers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(HERE, ".artifacts");
const PIDS = path.join(ART, "pids.json");
const DEPLOYMENT_BAK = path.join(ART, "deployment.json.bak");

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

async function waitFor(probe: () => Promise<boolean>, what: string, tries = 240): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const rpcUp = async (): Promise<boolean> => {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  return (await res.json()).result === "0x7a69";
};
const previewUp = async (): Promise<boolean> => (await fetch(PREVIEW_URL)).ok;

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ART, { recursive: true });
  const pids: { anvil?: number; preview?: number } = {};
  const savePids = () => fs.writeFileSync(PIDS, JSON.stringify(pids));

  // Frontend deps (Integrate phase may already have installed them).
  if (!fs.existsSync(path.join(ROOT, "web", "node_modules"))) {
    run("npm", ["--prefix", "web", "install"]);
  }

  // Preserve any real deployment.json; the run substitutes the local one.
  fs.rmSync(DEPLOYMENT_BAK, { force: true });
  if (fs.existsSync(DEPLOYMENT_PATH)) fs.copyFileSync(DEPLOYMENT_PATH, DEPLOYMENT_BAK);

  // 1. Anvil (kept for the whole suite; killed in teardown).
  const anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", "8547", "--chain-id", "31337", "--gas-limit", "30000000", "--silent"],
    { cwd: ROOT, detached: true, stdio: "ignore" },
  );
  anvil.unref();
  pids.anvil = anvil.pid;
  savePids();
  await waitFor(rpcUp, "anvil RPC on 127.0.0.1:8547");

  // 2. Deploy with the well-known Anvil dev key #0 (never the real deployer).
  run("forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC_URL, "--broadcast"], {
    env: {
      ...process.env,
      // Deploy.s.sol reads the key from env (etherform-style), never from the repo.
      PRIVATE_KEY: ANVIL_KEY_0,
      FOUNDRY_OUT: "out-e2e",
      FOUNDRY_CACHE_PATH: "cache-e2e",
    },
  });

  // 3. Addresses from the etherform-compatible broadcast output.
  const runFile = path.join(ROOT, "broadcast", "Deploy.s.sol", "31337", "run-latest.json");
  const byName: Record<string, `0x${string}`> = {};
  for (const tx of JSON.parse(fs.readFileSync(runFile, "utf8")).transactions ?? []) {
    if ((tx.transactionType === "CREATE" || tx.transactionType === "CREATE2") && tx.contractName) {
      byName[tx.contractName] = tx.contractAddress;
    }
  }
  const need = (name: string): `0x${string}` => {
    const addr = byName[name];
    if (!addr) throw new Error(`broadcast has no CREATE for ${name} (found: ${Object.keys(byName).join(", ")})`);
    return addr;
  };
  const oracle = need("CredailyRentOracle");
  const pool = need("CoverPool");
  const token = need("CoverToken");
  const currency = await publicClient.readContract({
    address: pool,
    abi: parseAbi(["function currency() view returns (address)"]),
    functionName: "currency",
  });
  fs.writeFileSync(
    DEPLOYMENT_PATH,
    JSON.stringify({ chainId: 31337, oracle, pool, token, currency, seriesIds: [0] }, null, 2) + "\n",
  );

  // 4. Seed: wrap native coin for the sponsor and the buyer (WETH9-style deposit).
  for (const account of ACCOUNTS) {
    const hash = await walletClient.writeContract({
      address: currency,
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
      value: parseEther("1"),
      account,
      chain: foundry,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // 5. Build against the local deployment.json, then serve the built app.
  run("npm", ["--prefix", "web", "run", "build"], {
    // production build against anvil chainId 31337 — declare it so the app's
    // isDeployed prod guard (deployment.ts) accepts the test deployment
    env: { ...process.env, VITE_ALLOW_TEST_CHAIN: "1" },
  });
  const preview = spawn("npm", ["--prefix", "web", "run", "preview"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  preview.unref();
  pids.preview = preview.pid;
  savePids();
  await waitFor(previewUp, "vite preview on 127.0.0.1:5174");
}
