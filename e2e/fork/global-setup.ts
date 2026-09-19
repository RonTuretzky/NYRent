// Owns the mainnet-fork stack:
//   1. anvil --fork-url <Gnosis> on 127.0.0.1:8549 (real chainId 100 state)
//   2. an impersonated FRESH creator escrows real WXDAI into the REAL
//      permissionless pool via createSeries — sale window OPEN for the suite
//      (the live pool ships with zero series; anyone can create one)
//   3. the buyer (fresh code-less address, fork-funded xDAI) receives real
//      USDC.e from a large on-fork holder (the GNO/USDC.e Uniswap pool — NOT
//      the route pool)
//   4. production `vite build` against the committed real deployments with
//      VITE_RPC_URL pointed at the fork, served on 127.0.0.1:5175
// No mainnet transaction is ever broadcast; the upstream RPC only serves reads.
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import {
  ART_DIR,
  BUYER,
  CREATOR,
  FORK_PORT,
  FORK_PREVIEW_URL,
  FORK_PREVIEW_PORT,
  FORK_RPC_URL,
  PIDS_PATH,
  POOL,
  REPO_ROOT,
  STATE_PATH,
  UNI_WXDAI_USDCE_POOL,
  UPSTREAM_RPC_URL,
  USDCE,
  USDCE_WHALE,
  WXDAI,
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
  (await rpc<string>("eth_chainId")) === "0x64";
const previewUp = async (): Promise<boolean> =>
  (await fetch(FORK_PREVIEW_URL)).ok;

const CAPACITY = parseEther("2"); // creator-escrowed: backs the 1-WXDAI buy 1:1
const BUYER_USDCE = parseUnits("100", 6);

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const pids: { anvil?: number; preview?: number } = {};
  const savePids = () => fs.writeFileSync(PIDS_PATH, JSON.stringify(pids));

  // 1. anvil fork of real Gnosis (kept for the whole suite; killed in teardown).
  const anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(FORK_PORT),
      "--fork-url",
      UPSTREAM_RPC_URL,
      // The buyer is a fresh address (support.ts): anvil signs for any sender.
      "--auto-impersonate",
      "--silent",
    ],
    { cwd: REPO_ROOT, detached: true, stdio: "ignore" },
  );
  anvil.unref();
  pids.anvil = anvil.pid;
  savePids();
  await waitFor(forkUp, `anvil fork of ${UPSTREAM_RPC_URL} on :${FORK_PORT}`);

  // The buyer and creator must be code-less EOAs on the fork (see support.ts
  // on why the dev accounts don't qualify), funded with fork-only xDAI.
  for (const [who, label] of [
    [BUYER, "buyer"],
    [CREATOR, "creator"],
  ] as const) {
    const code = await rpc<string>("eth_getCode", [who, "latest"]);
    if (code !== "0x") {
      throw new Error(`${label} ${who} unexpectedly has code on the fork`);
    }
    await rpc("anvil_setBalance", [who, "0x8ac7230489e80000"]); // 10 xDAI
  }

  // 2. The impersonated creator escrows CAPACITY into the REAL permissionless
  //    pool: wrap → approve → createSeries pulls the escrow (no sponsor, no
  //    fundPool — the pool has no roles at all). Sale window OPEN all suite.
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
    to: WXDAI,
    value: CAPACITY,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "deposit" }),
  });
  await sendTx({
    from: CREATOR,
    to: WXDAI,
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

  // 3. Real USDC.e for the buyer, from a large on-fork holder. The whale is the
  //    GNO/USDC.e pool — deliberately NOT the WXDAI/USDC.e pool the swap routes
  //    through, so the traded pool's state stays exactly mainnet's.
  await rpc("anvil_setBalance", [USDCE_WHALE, "0x8ac7230489e80000"]); // 10 xDAI gas
  await rpc("anvil_impersonateAccount", [USDCE_WHALE]);
  await sendTx({
    from: USDCE_WHALE,
    to: USDCE,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [BUYER, BUYER_USDCE],
    }),
  });
  await rpc("anvil_stopImpersonatingAccount", [USDCE_WHALE]);

  const buyerUsdce = await forkClient.readContract({
    address: USDCE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [BUYER],
  });
  if (buyerUsdce < BUYER_USDCE) {
    throw new Error(`buyer USDC.e funding failed (balance ${buyerUsdce})`);
  }

  // Route-pool canary: the pinned WXDAI/USDC.e route must still have in-range
  // liquidity on the fork, else the pool migrated and the pinned route is stale.
  const liquidity = await forkClient.readContract({
    address: UNI_WXDAI_USDCE_POOL,
    abi: uniPoolAbi,
    functionName: "liquidity",
  });
  if (liquidity === 0n) {
    throw new Error("WXDAI/USDC.e 0.01% pool has zero in-range liquidity");
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify({ seriesId }, null, 2) + "\n");

  // 4. Production build against the committed REAL deployment.json, with the
  //    app's primary RPC pointed at the fork, served on the fork-suite port.
  if (!fs.existsSync(path.join(REPO_ROOT, "web", "node_modules"))) {
    run("npm", ["--prefix", "web", "install"]);
  }
  run("npm", ["--prefix", "web", "run", "build"], {
    env: {
      ...process.env,
      VITE_RPC_URL: FORK_RPC_URL,
      VITE_ALLOW_TEST_CHAIN: "1",
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
