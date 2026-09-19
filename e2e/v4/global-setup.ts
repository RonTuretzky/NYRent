import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, encodeAbiParameters, getContractAddress, getCreate2Address, keccak256, concat, pad, toHex, type Address, type Abi, zeroAddress } from "viem";
import { foundry } from "viem/chains";
import { ART, HERE, ROOT, RPC, PREVIEW, CREATOR, BUYER, BASE_TIME, START_TIME, OBS_START, OBS_END, CLAIM_END, SETTLE_TIME, UNIT } from "./constants";
import { signedFixture } from "./fixtures";
import cleanup from "./global-teardown";

const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: CREATOR });
const artifact = (name: string): {abi: Abi; bytecode: {object: `0x${string}`}} => JSON.parse(fs.readFileSync(path.join(ART, "out", name === "V4E2ECurrency" ? "Contracts.sol" : `${name}.sol`, `${name}.json`), "utf8"));
function run(cmd: string, args: string[], env = process.env) {
  const r = spawnSync(cmd, args, {cwd: ROOT, env, stdio: "inherit"});
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}
async function waitFor(fn: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 160; i++) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 28_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment failed`);
  return receipt.contractAddress;
}
async function write(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
  const hash = await wallet.writeContract({address, abi, functionName, args, gas: 25_000_000n});
  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return receipt;
}
function sqrt(n: bigint) { let x = n; let y = (x + 1n) / 2n; while (y < x) {x = y; y = (x + n / x) / 2n;} return x; }

export default async function setup() {
  fs.mkdirSync(ART, {recursive: true});
  if (await publicClient.getChainId().then(() => true).catch(() => false)) throw new Error("Port 8559 is already occupied; refusing to reuse another chain");
  if (await fetch(PREVIEW).then(() => true).catch(() => false)) throw new Error("Port 5199 is already occupied");
  const pids: {anvil?: number; preview?: number} = {};
  const save = () => fs.writeFileSync(path.join(ART, "pids.json"), JSON.stringify(pids));
  try {
    const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", "8559", "--chain-id", "31337", "--gas-limit", "30000000", "--timestamp", START_TIME.toString(), "--silent"], {cwd: ROOT, detached: true, stdio: "ignore"});
    anvil.unref(); pids.anvil = anvil.pid; save();
    await waitFor(() => publicClient.getChainId().then(id => id === 31337), "isolated Anvil");
    run("forge", ["build", "e2e/v4/Contracts.sol", "--out", path.join(ART, "out"), "--cache-path", path.join(ART, "cache")]);
    const poolManager = await deploy("PoolManager", [zeroAddress]);
    const currency = await deploy("V4E2ECurrency");
    const key = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/testkey/meta.json"), "utf8"));
    const oracle = await deploy("CredailyRentOracle", [key.modulus_hex]);
    const stateView = await deploy("StateView", [poolManager]);
    const quoter = await deploy("V4Quoter", [poolManager]);
    const base = signedFixture(9288, BASE_TIME);
    await write(oracle, artifact("CredailyRentOracle").abi, "submitObservation", base.args);
    const nonce = await publicClient.getTransactionCount({address: CREATOR});
    const predictedFactory = getContractAddress({from: CREATOR, nonce: BigInt(nonce)});
    const initHash = keccak256(concat([artifact("RentV4Hook").bytecode.object, encodeAbiParameters([{type:"address"},{type:"address"}], [poolManager, predictedFactory])]));
    let hook = zeroAddress as Address, salt = pad("0x0", {size: 32});
    for (let i = 0; i < 1_000_000; i++) {
      salt = pad(toHex(i), {size: 32});
      hook = getCreate2Address({from: predictedFactory, salt, bytecodeHash: initHash});
      if ((BigInt(hook) & 0x3fffn) === 0x2a80n) break;
      if (i === 999_999) throw new Error("Hook mining exhausted");
    }
    const factory = await deploy("RentV4Factory", [poolManager, currency, oracle, salt]);
    if (factory.toLowerCase() !== predictedFactory.toLowerCase()) throw new Error("Factory nonce prediction failed");
    const router = await deploy("RentV4Router", [factory]);
    const marketNonce = await publicClient.getTransactionCount({address: factory});
    const market = getContractAddress({from: factory, nonce: BigInt(marketNonce)});
    const rentIs0 = BigInt(market) < BigInt(currency);
    const sqrtPriceX96 = sqrt((1n << 192n) * (rentIs0 ? 285n : 1000n) / (rentIs0 ? 1000n : 285n));
    await write(factory, artifact("RentV4Factory").abi, "createMarket", [{baseObservationIndex: 0n, baseRentCents: 9288, strikeLowCents: 9567, strikeHighCents: 10031, saleEnd: OBS_START, obsStart: OBS_START, obsEnd: OBS_END, redeemEnd: CLAIM_END}, sqrtPriceX96]);
    const actual = await publicClient.readContract({address: factory, abi: artifact("RentV4Factory").abi, functionName: "markets", args: [0n]}) as Address;
    if (actual.toLowerCase() !== market.toLowerCase()) throw new Error("Market address prediction failed");
    for (const who of [CREATOR, BUYER]) await write(currency, artifact("V4E2ECurrency").abi, "mint", [who, 100_000n * UNIT]);
    const poolKey = {currency0: rentIs0 ? market : currency, currency1: rentIs0 ? currency : market, fee: 8388608, tickSpacing: 60, hooks: hook};
    const manifest = {chainId: 31337, market, factory, hook, router, poolManager, stateView, quoter, oracle, currency, decimals: 6, symbol: "USDC", deploymentBlock: "0", baseObservationIndex: 0, poolKey};
    fs.writeFileSync(path.join(ART, "v4-deployments.json"), JSON.stringify({"31337": manifest}, null, 2));
    fs.writeFileSync(path.join(ART, "legacy-deployment.json"), JSON.stringify({chainId: 31337, oracle, pool: market, token: market, currency, seriesIds: []}, null, 2));
    fs.writeFileSync(path.join(ART, "settlement-test-only.eml"), signedFixture(9799, SETTLE_TIME).eml);
    fs.writeFileSync(path.join(ART, "base-test-only.eml"), base.eml);
    run(path.join(ROOT, "web/node_modules/.bin/vite"), ["build", "--config", path.join(HERE, "vite.config.ts")], {...process.env, VITE_ALLOW_TEST_CHAIN: "1", VITE_RPC_URL: RPC});
    const preview = spawn(path.join(ROOT, "web/node_modules/.bin/vite"), ["preview", "--config", path.join(HERE, "vite.config.ts")], {cwd: ROOT, detached: true, stdio: "ignore", env: {...process.env, VITE_ALLOW_TEST_CHAIN: "1", VITE_RPC_URL: RPC}});
    preview.unref(); pids.preview = preview.pid; save();
    await waitFor(() => fetch(PREVIEW).then(r => r.ok), "isolated preview");
  } catch (e) { await cleanup(); throw e; }
}
