#!/usr/bin/env node
/** Integration test ONLY. Nested local forks isolate synthetic funding from mainnet readiness.
 * The outer fork transfers real Polygon USDC bytecode's balances locally to the operator;
 * the inner fork exercises the exact prepare/launch path with a fresh authentic oracle.
 * No key, secret, upstream transaction, or production manifest is used.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ROOT, targetOf, publicClient, viem, chainFor, prepare, atomicJson } from './v4-prepare.mjs';
import { launch } from './v4-launch.mjs';
const target = targetOf('polygon');
const port = Number(process.env.V4_POLYGON_PROOF_PORT || 8617);
const rpc = `http://127.0.0.1:${port}`;
const out = path.join(ROOT, 'broadcast/v4', `polygon-integration-${Date.now()}`);
const upstream = process.env.V4_POLYGON_RPC_URL || target.rpc;
const live = publicClient(upstream, target);
if (await live.getChainId() !== target.chainId) throw new Error('Polygon upstream required');
const block = await live.getBlockNumber();
try {
  await fetch(rpc, { signal: AbortSignal.timeout(300) });
  throw new Error('Proof port is occupied');
} catch (error) { if (error.message === 'Proof port is occupied') throw error; }
const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '137', '--fork-url', upstream, '--fork-block-number', String(block), '--silent'],
  { cwd: os.tmpdir(), stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
try {
  const client = publicClient(rpc, target);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Integration Anvil exited');
    try {
      const version = await client.request({ method: 'web3_clientVersion' });
      if (!version.toLowerCase().includes('anvil') || await client.getChainId() !== 137) throw new Error('Not the local Polygon fork');
      ready = true; break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) throw new Error('Integration Anvil startup timed out');
  await client.request({ method: 'anvil_impersonateAccount', params: [target.poolManager] });
  await client.request({ method: 'anvil_setBalance', params: [target.poolManager, viem.toHex(viem.parseEther('1'))] });
  const wallet = viem.createWalletClient({ account: target.poolManager, chain: chainFor(target), transport: viem.http(rpc) });
  const hash = await wallet.writeContract({ address: target.currency, abi: viem.parseAbi(['function transfer(address,uint256) returns(bool)']), functionName: 'transfer', args: [target.deployer, 2_000_000n] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Local-only USDC fixture funding failed');
  await client.request({ method: 'anvil_stopImpersonatingAccount', params: [target.poolManager] });
  const plan = await prepare({ chain: 'polygon', rpc, smoke: true });
  plan.integrationOnly = 'Synthetic 2 USDC transfer from canonical PoolManager on an outer local fork; synthetic POL gas funding; authentic signed baseline. This is not real operator funding or a launch-ready proof.';
  const planFile = path.join(out, 'plan.json');
  atomicJson(planFile, plan);
  const result = await launch({ plan: planFile, out: path.join(out, 'rehearsal'), port: port + 1 });
  const liveGasPrice = await live.getGasPrice();
  const projectedGas = BigInt(result.totalEstimatedGas) * liveGasPrice * 13n / 10n;
  console.log('Read-only live gas projection (POL, not a funded launch):', viem.formatEther(projectedGas));
  console.log('Polygon integration complete:', result.rows.length, 'successful transactions; production is unchanged.');
} finally { child.kill('SIGTERM'); }
