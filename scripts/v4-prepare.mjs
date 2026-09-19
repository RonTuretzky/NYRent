#!/usr/bin/env node
/** Public-data-only preparation. This module never loads .env or signs transactions. */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { DEMO_BASE_CENTS, DEMO_STRIKE_LOW_CENTS, DEMO_STRIKE_HIGH_CENTS,
  DEMO_SALE_END, DEMO_OBS_START, DEMO_OBS_END, DEMO_REDEEM_END } from '../web/src/lib/market.ts';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../web/package.json', import.meta.url));
export const viem = require('viem');
export const accounts = require('viem/accounts');
export const { arbitrum, polygon } = require('viem/chains');
export const TARGETS = Object.freeze(JSON.parse(readFileSync(path.join(ROOT, 'web/src/chain/v4-targets.json'))));
export function targetOf(value = 'arbitrum') {
  const id = { arbitrum: 42161, polygon: 137 }[String(value)] ?? Number(value);
  const target = TARGETS[String(id)];
  if (!target) throw new Error(`Unsupported v4 target: ${value}`);
  return target;
}
export const C = targetOf();
export const chainFor = target => target.chainId === 137 ? polygon : arbitrum;
export const hasOracle = target => target.oracle !== viem.zeroAddress;
export const ARTIFACT_NAMES = ['ChunkedObservationSubmitter', 'RentV4Factory', 'RentV4Hook', 'RentV4Router', 'RentV4Market', 'CredailyRentOracle'];
export const MARKET_TERMS = Object.freeze({ baseRentCents: DEMO_BASE_CENTS, strikeLowCents: DEMO_STRIKE_LOW_CENTS,
  strikeHighCents: DEMO_STRIKE_HIGH_CENTS, saleEnd: DEMO_SALE_END, obsStart: DEMO_OBS_START,
  obsEnd: DEMO_OBS_END, redeemEnd: DEMO_REDEEM_END });
export const ERC20 = viem.parseAbi([
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
]);
export const ORACLE = viem.parseAbi([
  'function recorded(bytes32) view returns(bool)',
  'function observationCount() view returns(uint256)',
  'function observations(uint256) view returns(uint64,uint32,bytes32)',
  'function MODULUS_HASH() view returns(bytes32)',
]);
export const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
export function atomicJson(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename + '.tmp', json(value), { mode: 0o600 });
  renameSync(filename + '.tmp', filename);
}
export function argsOf(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    args[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}
export function artifacts() {
  return Object.fromEntries(ARTIFACT_NAMES.map(name => {
    const artifact = JSON.parse(readFileSync(path.join(ROOT, 'out', `${name}.sol`, `${name}.json`)));
    if (!artifact.bytecode.object || artifact.bytecode.object.includes('__')) throw new Error(`Build/link ${name} first`);
    return [name, artifact];
  }));
}
export function fixture() {
  const dir = path.join(ROOT, 'fixtures/credaily-2026-09-17');
  const body = readFileSync(path.join(dir, 'canon-body.bin'));
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json')));
  return {
    body, prefix: viem.toHex(body.subarray(0, 24000)), tail: viem.toHex(body.subarray(24000)),
    headers: viem.toHex(readFileSync(path.join(dir, 'signed-headers.bin'))),
    signature: viem.toHex(readFileSync(path.join(dir, 'sig.bin'))),
    modulus: meta.modulus_hex, hash: viem.sha256(viem.toHex(body)), modulusHash: viem.keccak256(meta.modulus_hex),
    timestamp: BigInt(meta.t), cents: 9288,
  };
}
export function publicClient(url = C.rpc, target = C) {
  return viem.createPublicClient({ chain: chainFor(target), transport: viem.http(url, { timeout: 60_000, retryCount: 1 }) });
}
export function sqrt(value) {
  if (value < 0n) throw new Error('Negative square root');
  if (value < 2n) return value;
  let x = value, next = (value + 1n) / 2n;
  while (next < x) { x = next; next = (x + value / x) / 2n; }
  return x;
}
export function initialSqrtPrice(market, priceNumerator = 285n, priceDenominator = 1000n, C = targetOf()) {
  const rentIs0 = market.toLowerCase() < C.currency.toLowerCase();
  return sqrt((rentIs0 ? priceNumerator : priceDenominator) * 2n ** 192n / (rentIs0 ? priceDenominator : priceNumerator));
}
export function liquidityFor(sqrtPrice, rentAddress, rent, dollars, C = targetOf()) {
  const Q = 2n ** 96n, lower = 4306310044n, upper = 1457652066949847389969617340386294118487833376468n;
  const [maximum0, maximum1] = rentAddress.toLowerCase() < C.currency.toLowerCase() ? [rent, dollars] : [dollars, rent];
  if (maximum0 <= 1n || maximum1 <= 1n) throw new Error('Seed size is too small');
  const l0 = (maximum0 - 1n) * sqrtPrice * upper / (Q * (upper - sqrtPrice));
  const l1 = (maximum1 - 1n) * Q / (sqrtPrice - lower);
  const liquidity = (l0 < l1 ? l0 : l1) * 99n / 100n;
  if (liquidity <= 0n) throw new Error('Seed liquidity rounds to zero');
  return { liquidity, maximum0, maximum1 };
}
export function mineHook(factory, artifact, C = targetOf()) {
  const bytecodeHash = viem.keccak256(viem.encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [C.poolManager, factory] }));
  for (let i = 0; i < 1_000_000; i++) {
    const salt = viem.toHex(i, { size: 32 });
    const hook = viem.getCreate2Address({ from: factory, salt, bytecodeHash });
    if ((BigInt(hook) & 0x3fffn) === 0x2a80n) return { hook, salt };
  }
  throw new Error('Hook salt search exceeded limit');
}
export async function findBase(client, f = fixture(), C = targetOf()) {
  if (!hasOracle(C)) return null;
  const recorded = await client.readContract({ address: C.oracle, abi: ORACLE, functionName: 'recorded', args: [f.hash] });
  if (!recorded) return null;
  const count = await client.readContract({ address: C.oracle, abi: ORACLE, functionName: 'observationCount' });
  if (count > 10_000n) throw new Error('Observation scan exceeds safe limit; use an indexed oracle query');
  for (let index = 0n; index < count; index++) {
    const [timestamp, cents, id] = await client.readContract({ address: C.oracle, abi: ORACLE, functionName: 'observations', args: [index] });
    if (id.toLowerCase() === f.hash.toLowerCase()) {
      if (timestamp !== f.timestamp || cents !== f.cents) throw new Error('Baseline observation mismatch');
      return index;
    }
  }
  throw new Error('Oracle replay mapping and observation log disagree');
}
export async function prepare(options = {}) {
  const C = targetOf(options.chain);
  const rpc = String(options.rpc || C.rpc);
  const deployer = viem.getAddress(String(options.deployer || C.deployer));
  const client = publicClient(rpc, C), a = artifacts(), f = fixture();
  const collateral = viem.parseUnits(String(options.collateral || '1'), 6);
  const lpCash = (collateral * 285n + 999n) / 1000n;
  const smoke = Boolean(options.smoke);
  const smokeInput = smoke ? 100n : 0n;
  if (collateral < 100n || collateral > 1000000n) throw new Error('This demo launch supports 0.0001–1 USDC collateral');
  const chainId = await client.getChainId();
  if (chainId !== C.chainId) throw new Error(`Expected ${C.name}, got ${chainId}`);
  const block = await client.getBlock();
  const [nativeBalance, usdcBalance, nonce, gasPrice, modulusHash, baseObservationIndex] = await Promise.all([
    client.getBalance({ address: deployer, blockNumber: block.number }),
    client.readContract({ address: C.currency, abi: ERC20, functionName: 'balanceOf', args: [deployer], blockNumber: block.number }),
    client.getTransactionCount({ address: deployer, blockTag: 'pending' }), client.getGasPrice(),
    hasOracle(C) ? client.readContract({ address: C.oracle, abi: ORACLE, functionName: 'MODULUS_HASH' }) : f.modulusHash, findBase(client, f, C),
  ]);
  if (modulusHash !== f.modulusHash) throw new Error('Existing oracle pinned key differs from verified fixture');
  for (const address of [C.poolManager, C.currency, C.stateView, C.quoter, ...(hasOracle(C) ? [C.oracle] : [])]) {
    const code = await client.getCode({ address });
    if (!code || code === '0x') throw new Error(`Missing canonical contract ${address}`);
  }
  const terms = MARKET_TERMS;
  if (block.timestamp >= terms.saleEnd) throw new Error('Market sale cutoff has already passed');
  const requiredCapital = collateral + lpCash + smokeInput;
  const observationSubmitter = options['observation-submitter'] ? viem.getAddress(String(options['observation-submitter'])) : null;
  if (observationSubmitter) {
    const code = await client.getCode({ address: observationSubmitter });
    if (code !== a.ChunkedObservationSubmitter.deployedBytecode.object) throw new Error('Existing observation submitter runtime differs from reviewed artifact');
  }
  const plan = {
    version: 2, preparedAt: new Date().toISOString(), chainId, upstreamRpc: rpc, deployer,
    forkBlock: block.number, forkBlockHash: block.hash, startingNonce: nonce, addresses: C, observationSubmitter,
    artifacts: Object.fromEntries(ARTIFACT_NAMES.map(name => [name, viem.keccak256(a[name].bytecode.object)])),
    baseline: { emailId: f.hash, timestamp: f.timestamp, cents: f.cents, baseObservationIndex },
    terms, collateral, lpCash, smoke, smokeInput, priceNumerator: '285', priceDenominator: '1000',
    snapshot: { nativeBalance, usdcBalance, gasPrice, requiredCapital,
      capitalShortfall: requiredCapital > usdcBalance ? requiredCapital - usdcBalance : 0n,
      oneDollarAlternative: { collateral: 1000000n, lpCash: 285000n,
        capitalShortfall: 1285000n > usdcBalance ? 1285000n - usdcBalance : 0n } },
  };
  return JSON.parse(json(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = argsOf();
  if (args.help) {
    console.log('node scripts/v4-prepare.mjs [--chain arbitrum|polygon] [--out broadcast/v4/plan.json] [--collateral 1] [--smoke] [--rpc URL]\nDefault desired launch: 1 USDC escrow + 0.285 USDC LP cash. Use --collateral 0.01 for a tiny fork proof. Public-data-only; does not sign, load .env, or broadcast.');
  } else {
    if (args.execute) throw new Error('Use v4-launch.mjs --execute with explicit budgets; prepare never broadcasts');
    const plan = await prepare(args);
    const output = path.resolve(String(args.out || path.join(ROOT, 'broadcast/v4/plan.json')));
    atomicJson(output, plan);
    console.log(json({ plan: output, chainId: plan.chainId, forkBlock: plan.forkBlock, deployer: plan.deployer, ...plan.snapshot }));
  }
}
