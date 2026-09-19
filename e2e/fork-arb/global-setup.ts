// Owns the Arbitrum-fork stack:
//   1. anvil --fork-url <Arbitrum One> on 127.0.0.1:8550 (real chainId 42161)
//   2. an impersonated FRESH creator receives real USDC from a large on-fork
//      holder (the Hyperliquid bridge — NOT the WETH/USDC route pool) and
//      escrows it into the REAL permissionless pool via createSeries — sale
//      window OPEN for the suite (the live pool ships with zero series)
//   3. the buyer is a FRESH code-less address funded with fork-only ETH —
//      never anvil dev key #0
//   4. production `vite build` with a TEMPORARY legacy deployment.json naming
//      chainId 42161, so VITE_RPC_URL pins the app's ARBITRUM transport to the
//      fork (web/src/chain/wagmi.ts); the original file is restored in
//      teardown. Served on 127.0.0.1:5176.
// No mainnet transaction is ever broadcast; the upstream RPC only serves reads.
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, parseUnits } from "viem";
import {
  ART_DIR,
  BUYER,
  COVER_TOKEN,
  CREATOR,
  DEPLOYMENT_BAK,
  DEPLOYMENT_PATH,
  FORK_PORT,
  FORK_PREVIEW_PORT,
  FORK_PREVIEW_URL,
  FORK_RPC_URL,
  ORACLE,
  PIDS_PATH,
  POOL,
  REPO_ROOT,
  STATE_PATH,
  UNI_WETH_USDC_POOL,
  UPSTREAM_RPC_URL,
  USDC,
  USDC_WHALE,
  erc20Abi,
  forkClient,
  poolAbi,
  rpc,
  sendTx,
  uniPoolAbi,
} from "./support";

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

async function waitFor(
  probe: () => Promise<boolean>,
  what: string,
  tries = 480,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const forkUp = async (): Promise<boolean> =>
  (await rpc<string>("eth_chainId")) === "0xa4b1";
const previewUp = async (): Promise<boolean> =>
  (await fetch(FORK_PREVIEW_URL)).ok;

const CAPACITY = parseUnits("20", 6); // creator-escrowed, 6-dec USDC

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const pids: { anvil?: number; preview?: number } = {};
  const savePids = () => fs.writeFileSync(PIDS_PATH, JSON.stringify(pids));

  // 1. anvil fork of real Arbitrum One (kept for the suite; killed in teardown).
  const anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(FORK_PORT),
      "--fork-url",
      UPSTREAM_RPC_URL,
      // Buyer/creator are fresh addresses (support.ts): anvil signs for any sender.
      "--auto-impersonate",
      "--silent",
    ],
    { cwd: REPO_ROOT, detached: true, stdio: "ignore" },
  );
  anvil.unref();
  pids.anvil = anvil.pid;
  savePids();
  await waitFor(forkUp, `anvil fork of ${UPSTREAM_RPC_URL} on :${FORK_PORT}`);

  // Buyer and creator must be code-less EOAs on the fork; fund with fork ETH.
  for (const [who, label] of [
    [BUYER, "buyer"],
    [CREATOR, "creator"],
  ] as const) {
    const code = await rpc<string>("eth_getCode", [who, "latest"]);
    if (code !== "0x") {
      throw new Error(`${label} ${who} unexpectedly has code on the fork`);
    }
    await rpc("anvil_setBalance", [who, "0x8ac7230489e80000"]); // 10 ETH
  }

  // 2. Real USDC for the creator's escrow, from the whale (not the route pool).
  await rpc("anvil_setBalance", [USDC_WHALE, "0x8ac7230489e80000"]);
  await rpc("anvil_impersonateAccount", [USDC_WHALE]);
  await sendTx({
    from: USDC_WHALE,
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [CREATOR, CAPACITY],
    }),
  });
  await rpc("anvil_stopImpersonatingAccount", [USDC_WHALE]);

  // 3. The creator escrows CAPACITY into the REAL permissionless pool:
  //    approve → createSeries pulls the escrow. Sale window OPEN all suite.
  const seriesId = Number(
    await forkClient.readContract({
      address: POOL,
      abi: poolAbi,
      functionName: "seriesCount",
    }),
  );
  const now = (await forkClient.getBlock()).timestamp;
  await rpc("anvil_impersonateAccount", [CREATOR]);
  await sendTx({
    from: CREATOR,
    to: USDC,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [POOL, CAPACITY],
    }),
  });
  await sendTx({
    from: CREATOR,
    to: POOL,
    data: encodeFunctionData({
      abi: poolAbi,
      functionName: "createSeries",
      args: [
        8800, // strikeLowCents (same strikes as the anvil demo series)
        9600, // strikeHighCents
        2850, // premiumRateBps
        now + 86_400n, // saleEnd — OPEN for the whole suite
        now + 86_400n, // obsStart (saleEnd ≤ obsStart: contract invariant)
        now + 2n * 86_400n, // obsEnd
        now + 30n * 86_400n, // redeemEnd (≥ obsEnd + 7d claim window)
        CAPACITY,
      ],
    }),
  });
  await rpc("anvil_stopImpersonatingAccount", [CREATOR]);

  const count = await forkClient.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "seriesCount",
  });
  if (Number(count) !== seriesId + 1) {
    throw new Error(`createSeries did not append: seriesCount=${count}`);
  }

  // Route-pool canary: the WETH/USDC 0.05% route must still have in-range
  // liquidity on the fork, else the pool migrated and the pinned route is stale.
  const liquidity = await forkClient.readContract({
    address: UNI_WETH_USDC_POOL,
    abi: uniPoolAbi,
    functionName: "liquidity",
  });
  if (liquidity === 0n) {
    throw new Error("WETH/USDC 0.05% pool has zero in-range liquidity");
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify({ seriesId }, null, 2) + "\n");

  // 4. Production build. VITE_RPC_URL only pins the chain the legacy
  //    deployment.json names (wagmi.ts), so a TEMPORARY 42161-shaped file
  //    stands in during the build; teardown restores the original. The
  //    registry ignores it (42161 is a production chain → no test entry).
  fs.rmSync(DEPLOYMENT_BAK, { force: true });
  if (fs.existsSync(DEPLOYMENT_PATH)) {
    fs.copyFileSync(DEPLOYMENT_PATH, DEPLOYMENT_BAK);
  }
  fs.writeFileSync(
    DEPLOYMENT_PATH,
    JSON.stringify(
      {
        chainId: 42161,
        oracle: ORACLE,
        pool: POOL,
        token: COVER_TOKEN,
        currency: USDC,
        seriesIds: [seriesId],
      },
      null,
      2,
    ) + "\n",
  );
  if (!fs.existsSync(path.join(REPO_ROOT, "web", "node_modules"))) {
    run("npm", ["--prefix", "web", "install"]);
  }
  run("npm", ["--prefix", "web", "run", "build"], {
    env: {
      ...process.env,
      VITE_RPC_URL: FORK_RPC_URL,
    },
  });
  const preview = spawn(
    "npx",
    [
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(FORK_PREVIEW_PORT),
      "--strictPort",
    ],
    { cwd: path.join(REPO_ROOT, "web"), detached: true, stdio: "ignore" },
  );
  preview.unref();
  pids.preview = preview.pid;
  savePids();
  await waitFor(previewUp, `vite preview on :${FORK_PREVIEW_PORT}`);
}
