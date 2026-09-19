#!/usr/bin/env node
/**
 * Default: launch only on a fresh local Arbitrum fork and emit a receipt-backed budget.
 * Mainnet: --execute --plan FILE --report FORK_REPORT --max-gas-eth N --max-capital-usdc N.
 * Only --execute invokes the existing secure environment loader. Keys are never persisted.
 */
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../agent/executors/chain.mjs';
import { ROOT, C, MARKET_TERMS, viem, accounts, arbitrum, ERC20, ORACLE, argsOf, artifacts, fixture, publicClient,
  atomicJson, json, prepare, findBase, mineHook, initialSqrtPrice, liquidityFor } from './v4-prepare.mjs';

const lower = -887220, upper = 887220;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashJson = object => viem.keccak256(viem.toHex(json(object)));
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const read = filename => JSON.parse(readFileSync(filename));
const max = (a, b) => a > b ? a : b;
function publicReceipt(r) {
  return { hash: r.transactionHash, blockNumber: r.blockNumber, status: r.status,
    gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, contractAddress: r.contractAddress };
}
function requestFromJson(r) {
  return { ...r, value: BigInt(r.value), gas: BigInt(r.gas), gasPrice: BigInt(r.gasPrice) };
}
async function startFork(plan, port) {
  const url = `http://127.0.0.1:${port}`;
  try {
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }), signal: AbortSignal.timeout(500) });
    if (result.ok) throw new Error(`Port ${port} already has an RPC service; choose another --port`);
  } catch (error) { if (error.message.startsWith('Port ')) throw error; }
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(C.chainId),
    '--fork-url', plan.upstreamRpc, '--fork-block-number', plan.forkBlock, '--silent'], {
    cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let stderr = '', spawnError;
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
  child.on('error', error => { spawnError = error; });
  const client = publicClient(url);
  for (let i = 0; i < 150; i++) {
    if (spawnError || child.exitCode !== null) throw new Error(`Anvil did not start: ${spawnError?.message || stderr}`);
    try {
      const version = await client.request({ method: 'web3_clientVersion' });
      if (!version.toLowerCase().includes('anvil')) throw new Error('Local rehearsal RPC is not Anvil');
      if (await client.getChainId() !== C.chainId) throw new Error('Fork chain mismatch');
      return { child, url, client };
    } catch { await wait(200); }
  }
  child.kill('SIGTERM');
  throw new Error('Anvil startup timed out');
}

export async function launch(options = {}) {
  const execute = options.execute === true;
  if (options.execute && !execute) throw new Error('--execute is a boolean flag, never a key or RPC URL');
  if (execute && (!options.plan || !options.report || !options['max-gas-eth'] || !options['max-capital-usdc'])) {
    throw new Error('Execution requires --plan, --report, --max-gas-eth, and --max-capital-usdc');
  }
  const plan = options.plan ? read(path.resolve(String(options.plan))) : await prepare(options);
  const planHash = hashJson(plan), a = artifacts(), f = fixture();
  if (plan.version !== 1 || plan.chainId !== C.chainId) throw new Error('Unsupported plan');
  if (hashJson(plan.terms) !== hashJson(MARKET_TERMS)) throw new Error('Prepared dates/strikes differ from the shared frontend market; create a fresh plan and proof');
  for (const [key, expected] of Object.entries(C)) {
    if (key !== 'rpc' && key !== 'deployer' && String(plan.addresses[key]).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(`Canonical configuration changed: ${key}`);
    }
  }
  for (const name of Object.keys(a)) if (viem.keccak256(a[name].bytecode.object) !== plan.artifacts[name]) {
    throw new Error(`Artifact ${name} changed: rebuild plan and fork proof`);
  }
  if (plan.baseline.emailId !== f.hash || plan.baseline.cents !== f.cents) throw new Error('Fixture or baseline changed');
  const runDir = path.resolve(String(options.out || path.join(ROOT, 'broadcast/v4', execute ? 'mainnet-42161' : `fork-${Date.now()}`)));
  mkdirSync(runDir, { recursive: true });
  const lockFile = path.join(runDir, 'operator.lock');
  let lockFd;
  try { lockFd = openSync(lockFile, 'wx', 0o600); }
  catch { throw new Error(`Operator lock exists at ${lockFile}; verify no live operator before removing it`); }
  const checkpointFile = path.join(runDir, 'checkpoint.json');
  let fork, wallet, nativeBefore, usdcBefore, gasBudget, globalLockFd, globalLockFile;
  const checkpoint = existsSync(checkpointFile) ? read(checkpointFile) : {
    version: 1, mode: execute ? 'mainnet' : 'local-fork', planHash, steps: {}, addresses: {}, startedAt: new Date().toISOString(),
  };
  const save = () => atomicJson(checkpointFile, checkpoint);
  if (checkpoint.planHash !== planHash || checkpoint.mode !== (execute ? 'mainnet' : 'local-fork')) {
    closeSync(lockFd); unlinkSync(lockFile); throw new Error('Checkpoint belongs to a different plan or execution mode');
  }
  if (!execute && Object.keys(checkpoint.steps).length) {
    closeSync(lockFd); unlinkSync(lockFile); throw new Error('A fresh fork requires a new output directory; never reuse mainnet/fork checkpoints across chain resets');
  }
  atomicJson(path.join(runDir, 'plan.json'), plan);
  save();
  try {
    const upstream = publicClient(plan.upstreamRpc);
    let client;
    if (execute) {
      client = upstream;
      globalLockFile = path.join(ROOT, 'broadcast/v4', `operator-42161-${plan.deployer.toLowerCase()}.lock`);
      try { globalLockFd = openSync(globalLockFile, 'wx', 0o600); }
      catch { throw new Error('Another launch may be active for this deployer; inspect the global operator lock before continuing'); }
      const activeFile = path.join(ROOT, 'broadcast/v4', `active-42161-${plan.deployer.toLowerCase()}.json`);
      if (existsSync(activeFile)) {
        const active = read(activeFile);
        if (!existsSync(active.checkpointFile)) throw new Error('Active launch checkpoint is missing; restore it before any new broadcast');
        if (active.checkpointFile !== checkpointFile || active.planHash !== planHash) throw new Error('A different launch journal already owns this deployer; resume its exact plan and output directory');
      }
      if ((await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Error('Execution RPC is a local simulator');
      const proof = read(path.resolve(String(options.report)));
      if (!proof.complete || proof.mode !== 'local-fork' || proof.planHash !== planHash) throw new Error('Matching completed fork proof required');
      if (Date.now() - Date.parse(proof.completedAt) > 24 * 3600 * 1000) throw new Error('Fork proof is older than 24 hours; rehearse again');
      gasBudget = viem.parseEther(String(options['max-gas-eth']));
      const capBudget = viem.parseUnits(String(options['max-capital-usdc']), 6);
      if (BigInt(plan.snapshot.requiredCapital) > capBudget) throw new Error('Planned collateral + LP cash + smoke exceeds capital budget');
      const gasPrice = await client.getGasPrice();
      let completedEstimatedGas = 0n, priorGasSpent = 0n;
      for (const row of proof.rows) {
        const prior = checkpoint.steps[row.name];
        if (!prior?.hash || prior.status !== 'confirmed') continue;
        const receipt = await client.getTransactionReceipt({ hash: prior.hash });
        if (receipt.status !== 'success') throw new Error(`Prior ${row.name} receipt is not confirmed successful`);
        completedEstimatedGas += BigInt(row.estimate);
        priorGasSpent += receipt.gasUsed * receipt.effectiveGasPrice;
      }
      const remainingEstimatedGas = max(0n, BigInt(proof.totalEstimatedGas) - completedEstimatedGas);
      const required = remainingEstimatedGas * gasPrice * 13n / 10n;
      nativeBefore = await client.getBalance({ address: plan.deployer });
      usdcBefore = await client.readContract({ address: C.currency, abi: ERC20, functionName: 'balanceOf', args: [plan.deployer] });
      // On restart the step journal already records capital spent; individual steps verify fresh balances.
      if (nativeBefore < required || gasBudget < priorGasSpent + required) {
        throw new Error(`Remaining gas buffer needs ${viem.formatEther(required)} ETH; wallet ${viem.formatEther(nativeBefore)}, cumulative cap ${viem.formatEther(gasBudget)}`);
      }
      if (!Object.keys(checkpoint.steps).length && usdcBefore < BigInt(plan.snapshot.requiredCapital)) throw new Error('Insufficient native USDC for whole launch');
      // This is the ONLY branch that reads the user's secure environment/key.
      loadEnv();
      let key = process.env.DEPLOYER_PRIVATE_KEY;
      if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is required only for explicit execution');
      if (!key.startsWith('0x')) key = `0x${key}`;
      let account;
      try { account = accounts.privateKeyToAccount(key); }
      catch { throw new Error('Invalid secure deployer key; no key material was logged'); }
      key = undefined;
      if (!same(account.address, plan.deployer)) throw new Error('Secure signer does not match reviewed deployer');
      wallet = viem.createWalletClient({ account, chain: arbitrum, transport: viem.http(plan.upstreamRpc, { retryCount: 0 }) });
      atomicJson(activeFile, { planHash, checkpointFile });
    } else {
      fork = await startFork(plan, Number(options.port || 8599));
      client = fork.client;
      nativeBefore = await client.getBalance({ address: plan.deployer });
      usdcBefore = await client.readContract({ address: C.currency, abi: ERC20, functionName: 'balanceOf', args: [plan.deployer] });
      if (usdcBefore < BigInt(plan.snapshot.requiredCapital)) throw new Error('Fork inherits insufficient real USDC; reduce collateral or fund the real deployer before replanning');
      await client.request({ method: 'anvil_impersonateAccount', params: [plan.deployer] });
      // Gas-only top-up allows a complete cost measurement even if the real wallet is short.
      // No USDC, oracle storage, or contract code is mocked or overwritten.
      await client.request({ method: 'anvil_setBalance', params: [plan.deployer, viem.toHex(viem.parseEther('1'))] });
      checkpoint.syntheticGasFunding = '1 ETH on the local fork only; real funding measured separately';
      wallet = viem.createWalletClient({ account: plan.deployer, chain: arbitrum, transport: viem.http(fork.url, { retryCount: 0 }) });
    }
    if (await client.getChainId() !== C.chainId) throw new Error('Connected chain changed');
    if (!checkpoint.initialBalances) {
      checkpoint.initialBalances = { native: nativeBefore.toString(), usdc: usdcBefore.toString() };
      checkpoint.actionDeadline = (BigInt((await client.getBlock()).timestamp) + 3600n).toString();
      save();
    }
    const pinned = await client.readContract({ address: C.oracle, abi: ORACLE, functionName: 'MODULUS_HASH' });
    if (pinned !== f.modulusHash) throw new Error('Connected oracle key mismatch');
    if (!Object.keys(checkpoint.steps).length) {
      const nonce = await client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' });
      if (nonce !== plan.startingNonce) throw new Error(`Nonce moved from ${plan.startingNonce} to ${nonce}; create a fresh reviewed plan`);
    }
    const feePrice = max(BigInt(plan.snapshot.gasPrice), await client.getGasPrice());
    const encode = (name, functionName, args) => viem.encodeFunctionData({ abi: a[name].abi, functionName, args });
    const readMarket = (address, functionName, args = []) => client.readContract({ address, abi: a.RentV4Market.abi, functionName, args });

    async function step(name, to, data) {
      let item = checkpoint.steps[name];
      const intentHash = hashJson({ to: to?.toLowerCase() || null, data });
      if (item && item.intentHash !== intentHash) throw new Error(`Step ${name} differs from checkpoint; never overwrite a pending transaction`);
      if (!item) {
        const nonce = await client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' });
        const estimate = await client.estimateGas({ account: plan.deployer, ...(to ? { to } : {}), data, value: 0n });
        const gas = estimate * 12n / 10n + 1000n;
        const gasPrice = execute ? max(feePrice, await client.getGasPrice()) * 11n / 10n : feePrice;
        const request = { chainId: C.chainId, nonce, type: 'legacy', ...(to ? { to } : {}), data,
          value: '0', gas: gas.toString(), gasPrice: gasPrice.toString() };
        item = checkpoint.steps[name] = { intentHash, estimate: estimate.toString(), request, status: 'prepared', preparedAtBlock: String(await client.getBlockNumber()) };
        save();
      }
      let knownPending = false;
      if (item.hash) {
        try {
          const receipt = await client.getTransactionReceipt({ hash: item.hash });
          if (receipt.status !== 'success') throw new Error(`Recorded transaction ${name} reverted: ${item.hash}`);
          item.status = 'confirmed'; item.receipt = publicReceipt(receipt); save();
          return receipt;
        } catch (error) { if (error.message.startsWith('Recorded transaction')) throw error; }
        try { await client.getTransaction({ hash: item.hash }); knownPending = true; } catch { /* Safe deterministic resubmission below. */ }
      }
      const request = requestFromJson(item.request);
      const consumedNonce = await client.getTransactionCount({ address: plan.deployer, blockTag: 'latest' });
      if (consumedNonce > request.nonce) throw new Error(`Nonce ${request.nonce} was consumed without a matching confirmed checkpoint; inspect chain before continuing`);
      if (execute && !knownPending) {
        const spent = Object.values(checkpoint.steps).reduce((sum, row) => sum + (row.receipt ? BigInt(row.receipt.gasUsed) * BigInt(row.receipt.effectiveGasPrice) : 0n), 0n);
        const maximumFee = request.gas * request.gasPrice;
        if (spent + maximumFee > gasBudget) throw new Error(`Step ${name} exceeds cumulative gas budget`);
        if (await client.getBalance({ address: plan.deployer }) < maximumFee) throw new Error(`Step ${name} lacks gas funding`);
        const signed = await wallet.account.signTransaction(request);
        if ((signed.length - 2) / 2 >= 95000) throw new Error(`Serialized ${name} transaction exceeds Nitro admission budget`);
        const hash = viem.keccak256(signed);
        if (item.hash && item.hash !== hash) throw new Error('Checkpoint signature hash changed');
        item.hash = hash; item.status = 'signed'; save(); // Persist hash BEFORE network submission.
        await wallet.sendRawTransaction({ serializedTransaction: signed });
      } else if (!execute && !knownPending) {
        item.hash = await wallet.sendTransaction({ ...request, account: plan.deployer });
        item.status = 'submitted'; save();
      }
      const receipt = await client.waitForTransactionReceipt({ hash: item.hash, confirmations: execute ? 2 : 1, timeout: 120_000 });
      item.receipt = publicReceipt(receipt); item.status = receipt.status === 'success' ? 'confirmed' : 'reverted'; save();
      if (receipt.status !== 'success') throw new Error(`Transaction reverted at ${name}: ${item.hash}`);
      console.log(`${execute ? 'MAINNET' : 'FORK'} ${name}: ${receipt.gasUsed} gas · ${item.hash}`);
      return receipt;
    }
    async function deploy(name, contractName, args) {
      const artifact = a[contractName];
      const receipt = await step(name, null, viem.encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }));
      const code = receipt.contractAddress ? await client.getCode({ address: receipt.contractAddress }) : undefined;
      if (!receipt.contractAddress || !code || code === '0x') throw new Error(`Missing deployed code for ${name}`);
      checkpoint.addresses[name] = receipt.contractAddress; save();
      return receipt.contractAddress;
    }
    function event(receipt, abi, eventName) {
      for (const log of receipt.logs) {
        try {
          const decoded = viem.decodeEventLog({ abi, data: log.data, topics: log.topics });
          if (decoded.eventName === eventName) return decoded.args;
        } catch { /* Other contracts emit during the same transaction. */ }
      }
      throw new Error(`Missing ${eventName} event`);
    }
    async function approve(name, token, spender, amount) {
      return step(name, token, viem.encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }));
    }

    let baseObservationIndex = await findBase(client, f);
    // Future large authentic observations need this transport even when the base was recorded earlier.
    let observationSubmitter = plan.observationSubmitter;
    if (observationSubmitter) {
      if (await client.getCode({ address: observationSubmitter }) !== a.ChunkedObservationSubmitter.deployedBytecode.object) {
        throw new Error('Existing observation submitter runtime changed');
      }
    } else observationSubmitter = await deploy('deployObservationSubmitter', 'ChunkedObservationSubmitter', []);
    if (baseObservationIndex === null) {
      const stored = await step('storeBodyPrefix', observationSubmitter, encode('ChunkedObservationSubmitter', 'store', [f.prefix]));
      const chunk = event(stored, a.ChunkedObservationSubmitter.abi, 'ChunkStored').chunk;
      if ((await client.getCode({ address: chunk })).toLowerCase() !== ('0x00' + f.prefix.slice(2)).toLowerCase()) throw new Error('Stored body prefix differs');
      checkpoint.addresses.bodyPrefix = chunk; save();
      const data = encode('ChunkedObservationSubmitter', 'submit', [C.oracle, [chunk], f.hash, f.headers, f.signature, f.tail]);
      if ((data.length - 2) / 2 > 90000) throw new Error('Hybrid calldata exceeds reviewed admission budget');
      await step('submitAuthenticBaseline', observationSubmitter, data);
      baseObservationIndex = await findBase(client, f);
      if (baseObservationIndex === null) throw new Error('Authentic baseline was not recorded');
    }
    checkpoint.baseObservationIndex = baseObservationIndex.toString(); save();
    const factoryNonce = checkpoint.steps.deployFactory?.request.nonce
      ?? await client.getTransactionCount({ address: plan.deployer, blockTag: 'pending' });
    const predictedFactory = viem.getContractAddress({ from: plan.deployer, nonce: BigInt(factoryNonce) });
    const mined = mineHook(predictedFactory, a.RentV4Hook);
    const factory = await deploy('deployFactory', 'RentV4Factory', [C.poolManager, C.currency, C.oracle, mined.salt]);
    if (!same(factory, predictedFactory)) throw new Error('Factory address prediction failed');
    const hook = await client.readContract({ address: factory, abi: a.RentV4Factory.abi, functionName: 'hook' });
    if (!same(hook, mined.hook) || (BigInt(hook) & 0x3fffn) !== 0x2a80n) throw new Error('Hook permission address differs');
    const router = await deploy('deployRouter', 'RentV4Router', [factory]);

    let predictedMarket = checkpoint.addresses.predictedMarket;
    if (!predictedMarket) {
      predictedMarket = viem.getContractAddress({ from: factory, nonce: BigInt(await client.getTransactionCount({ address: factory })) });
      checkpoint.addresses.predictedMarket = predictedMarket; save();
    }
    const sqrtPriceX96 = initialSqrtPrice(predictedMarket);
    const terms = { ...plan.terms, baseObservationIndex, saleEnd: BigInt(plan.terms.saleEnd),
      obsStart: BigInt(plan.terms.obsStart), obsEnd: BigInt(plan.terms.obsEnd), redeemEnd: BigInt(plan.terms.redeemEnd) };
    const created = await step('createMarket', factory, encode('RentV4Factory', 'createMarket', [terms, sqrtPriceX96]));
    const market = event(created, a.RentV4Factory.abi, 'MarketCreated').market;
    if (!same(market, predictedMarket)) throw new Error('Market address prediction failed');
    checkpoint.addresses.market = market; save();
    const collateral = BigInt(plan.collateral), lpCash = BigInt(plan.lpCash);
    await approve('approveEscrow', C.currency, market, collateral);
    await step('depositAndMint', market, encode('RentV4Market', 'depositAndMint', [collateral, plan.deployer]));
    await approve('approveRentLiquidity', market, router, collateral);
    await approve('approveCashLiquidity', C.currency, router, lpCash + BigInt(plan.smokeInput));
    const sizing = liquidityFor(sqrtPriceX96, market, collateral, lpCash);
    const deadline = BigInt(checkpoint.actionDeadline);
    const lpRequest = { market, tickLower: lower, tickUpper: upper, liquidityDelta: sizing.liquidity,
      amount0Limit: sizing.maximum0, amount1Limit: sizing.maximum1, recipient: plan.deployer, deadline };
    await step('seedLiquidity', router, encode('RentV4Router', 'modifyLiquidity', [lpRequest]));
    if (plan.smoke) {
      const key = await client.readContract({ address: factory, abi: a.RentV4Factory.abi, functionName: 'poolKey', args: [market] });
      const quoterAbi = viem.parseAbi([
        'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
        'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
        'function quoteExactInputSingle(QuoteExactSingleParams params) returns(uint256 amountOut,uint256 gasEstimate)',
      ]);
      async function smokeRequest(name, buyRent, amountIn) {
        if (!checkpoint[name]) {
          const quoted = await client.simulateContract({ address: C.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
            args: [{ poolKey: key, zeroForOne: buyRent === same(key.currency1, market), exactAmount: amountIn, hookData: '0x' }] });
          const minimum = quoted.result[0] * 99n / 100n;
          if (minimum < 1n) throw new Error('Smoke quote rounds to zero');
          checkpoint[name] = { market, buyRent, amountIn: amountIn.toString(), amountOutMinimum: minimum.toString(),
            sqrtPriceLimitX96: '0', recipient: plan.deployer, deadline: deadline.toString() };
          save();
        }
        const stored = checkpoint[name];
        return { ...stored, amountIn: BigInt(stored.amountIn), amountOutMinimum: BigInt(stored.amountOutMinimum),
          sqrtPriceLimitX96: BigInt(stored.sqrtPriceLimitX96), deadline: BigInt(stored.deadline) };
      }
      const buyRequest = await smokeRequest('smokeBuyRequest', true, BigInt(plan.smokeInput));
      const bought = await step('smokeBuy', router, encode('RentV4Router', 'swapExactInput', [buyRequest]));
      const amountOut = event(bought, a.RentV4Router.abi, 'SwapExecuted').amountOut;
      if (amountOut <= 0n) throw new Error('Smoke buy had no output');
      await approve('approveSmokeSell', market, router, amountOut);
      const sellRequest = await smokeRequest('smokeSellRequest', false, amountOut);
      await step('smokeSell', router, encode('RentV4Router', 'swapExactInput', [sellRequest]));
    }
    const poolKey = await client.readContract({ address: factory, abi: a.RentV4Factory.abi, functionName: 'poolKey', args: [market] });
    const poolId = viem.keccak256(viem.encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
    const stateAbi = viem.parseAbi(['function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns(uint128)']);
    const [supply, deposited, escrow, baseEmailId, slot, liquidity, usdcAfter] = await Promise.all([
      readMarket(market, 'totalSupply'), readMarket(market, 'totalDeposited'), readMarket(market, 'escrowAccounted'), readMarket(market, 'baseEmailId'),
      client.readContract({ address: C.stateView, abi: stateAbi, functionName: 'getSlot0', args: [poolId] }),
      client.readContract({ address: C.stateView, abi: stateAbi, functionName: 'getLiquidity', args: [poolId] }),
      client.readContract({ address: C.currency, abi: ERC20, functionName: 'balanceOf', args: [plan.deployer] }),
    ]);
    if (supply !== collateral || deposited !== collateral || escrow !== collateral || baseEmailId !== f.hash || liquidity <= 0n) throw new Error('Final collateral/provenance/liquidity invariant failed');
    const actualEscrow = await client.readContract({ address: C.currency, abi: ERC20, functionName: 'balanceOf', args: [market] });
    if (actualEscrow !== collateral) throw new Error('Escrow token balance differs from accounting');
    const manifest = { chainId: C.chainId, market, factory, hook, router, poolManager: C.poolManager,
      stateView: C.stateView, quoter: C.quoter, ...(observationSubmitter ? { observationSubmitter } : {}),
      oracle: C.oracle, currency: C.currency, decimals: 6, symbol: 'USDC', deploymentBlock: created.blockNumber.toString(),
      baseObservationIndex: Number(baseObservationIndex), poolKey };
    const rows = Object.entries(checkpoint.steps).map(([name, row]) => ({ name, ...row.receipt, estimate: row.estimate }));
    const totalGasUsed = rows.reduce((sum, row) => sum + BigInt(row.gasUsed), 0n);
    const totalEstimatedGas = rows.reduce((sum, row) => sum + BigInt(row.estimate), 0n);
    const actualFee = rows.reduce((sum, row) => sum + BigInt(row.gasUsed) * BigInt(row.effectiveGasPrice), 0n);
    const liveGasPrice = await upstream.getGasPrice();
    const bufferedGasBudget = totalEstimatedGas * liveGasPrice * 13n / 10n;
    const freshBalance = await upstream.getBalance({ address: plan.deployer });
    const report = { version: 1, complete: true, mode: execute ? 'mainnet' : 'local-fork', planHash,
      completedAt: new Date().toISOString(), upstreamForkBlock: plan.forkBlock, upstreamForkBlockHash: plan.forkBlockHash,
      proof: execute ? 'Production receipts on Arbitrum One' : 'Local Anvil receipts against canonical Arbitrum state; synthetic ETH gas funding only; authentic oracle baseline; no future outcome invented',
      manifest, manifestFile: path.join(runDir, 'v4-deployments.json'), poolId, terms, rows,
      totalGasUsed, totalEstimatedGas, actualFee, feeMeasurement: execute ? 'Actual Arbitrum receipt fees' : 'Anvil EVM receipt gas; Nitro L1 data fees are not reproduced by Anvil',
      liveGasPrice, bufferedGasBudget, freshNativeBalance: freshBalance,
      gasShortfall: bufferedGasBudget > freshBalance ? bufferedGasBudget - freshBalance : 0n,
      startingRealNativeBalance: checkpoint.initialBalances.native, startingRealUsdcBalance: checkpoint.initialBalances.usdc, endingUsdcBalance: usdcAfter,
      capitalSpent: BigInt(checkpoint.initialBalances.usdc) - usdcAfter, collateral, liquidity, sqrtPriceX96: slot[0],
      fullRangeLiquidity: sizing.liquidity, oneDollarAlternative: plan.snapshot.oneDollarAlternative,
      frontendActivation: execute ? 'Review production manifest, verify sources and live reads before activating frontend registry' : 'DO NOT publish these fork addresses to the production frontend registry',
    };
    atomicJson(path.join(runDir, 'v4-deployments.json'), { [C.chainId]: manifest });
    atomicJson(path.join(runDir, 'report.json'), report);
    checkpoint.complete = true; save();
    console.log(json({ report: path.join(runDir, 'report.json'), mode: report.mode, totalGasUsed, totalEstimatedGas,
      bufferedGasBudgetETH: viem.formatEther(bufferedGasBudget), gasShortfallETH: viem.formatEther(report.gasShortfall),
      capitalSpentUSDC: viem.formatUnits(report.capitalSpent, 6), poolId, market }));
    return report;
  } finally {
    if (fork) fork.child.kill('SIGTERM');
    if (globalLockFd !== undefined) { closeSync(globalLockFd); unlinkSync(globalLockFile); }
    closeSync(lockFd); unlinkSync(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = argsOf();
  if (options.help) console.log(`Default local-fork proof (never loads keys):
  node scripts/v4-launch.mjs --smoke --collateral 0.01 [--port 8599]
  node scripts/v4-launch.mjs --plan broadcast/v4/plan.json --out broadcast/v4/rehearsal
Mainnet, explicitly gated and restart-safe:
  node scripts/v4-launch.mjs --execute --plan PLAN --report FORK_REPORT --max-gas-eth CAP --max-capital-usdc CAP
Outputs are public-data checkpoints under broadcast/v4; manifests are never automatically installed in the web app.
The desired launch defaults to 1 USDC collateral; smaller proof capital must be selected explicitly.
Re-run execution with the SAME plan and output directory to resume its signed transaction hashes.`);
  else await launch(options).catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
}
