#!/usr/bin/env node
/** Ephemeral local-chain proof using the upstream real PoolManager. All dollars/observations are test fixtures.
 * No private keys or production RPC/signers are read. Anvil's explicit unlocked local accounts sign locally. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPublicClient,createWalletClient,http,zeroAddress,encodeDeployData,getContractAddress,getCreate2Address,keccak256,toHex,parseAbi} from 'viem';
import {foundry} from 'viem/chains';
import {readV4State,ERC20_ABI} from './chain.mjs';
import {planV4Quotes} from './plan.mjs';
import {executeV4QuotePlan} from './direct.mjs';
import {sqrtRatioAtTick} from './math.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const port=8611,url=`http://127.0.0.1:${port}`;
// Ensure all external contracts used here have reproducible pinned artifacts.
execFileSync('forge',['build','lib/v4-periphery/src/lens/StateView.sol'],{cwd:root,stdio:'ignore'});
const artifact=async(name,file=name)=>JSON.parse(await readFile(`${root}/out/${file}.sol/${name}.json`,'utf8'));
const a={};for(const [name,file] of [['PoolManager'],['V4TestCurrency','RentV4.t'],['MockObservationOracle','Helpers'],
  ['RentV4Factory'],['RentV4Hook'],['RentV4Router'],['RentV4Market'],['StateView']])a[name]=await artifact(name,file);
const transport=http(url,{retryCount:0});
const publicClient=createPublicClient({chain:foundry,transport});
try { await publicClient.getBlockNumber(); throw new Error(`Refusing to use an occupied local proof port ${port}`); }
catch(e){if(e.message.startsWith('Refusing'))throw e;}
const anvil=spawn('anvil',['--port',String(port),'--chain-id','31337','--timestamp','1789642500','--gas-price','10000000','--base-fee','0','--silent'],{stdio:'ignore'});
try{
  let ready=false;for(let i=0;i<100;i++){try{await publicClient.getBlockNumber();ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.ok(ready,'ephemeral Anvil startup');
  const accounts=await publicClient.request({method:'eth_accounts'});
  const owner=accounts[0],buyer=accounts[1];
  const wallet=createWalletClient({chain:foundry,account:owner,transport});
  const buyerWallet=createWalletClient({chain:foundry,account:buyer,transport});
  const receipt=async hash=>{const r=await publicClient.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;};
  const deploy=async(name,args)=> (await receipt(await wallet.deployContract({abi:a[name].abi,bytecode:a[name].bytecode.object,args}))).contractAddress;
  const write=async(address,abi,functionName,args,w=wallet)=>receipt(await w.writeContract({address,abi,functionName,args}));
  const manager=await deploy('PoolManager',[zeroAddress]);
  const currency=await deploy('V4TestCurrency',[6]);
  const oracle=await deploy('MockObservationOracle',[]);
  const now=Number((await publicClient.getBlock()).timestamp);
  await write(oracle,a.MockObservationOracle.abi,'push',[BigInt(now-1),9288,toHex(1n,{size:32})]);
  const factoryAddress=getContractAddress({from:owner,nonce:BigInt(await publicClient.getTransactionCount({address:owner}))});
  const init=encodeDeployData({abi:a.RentV4Hook.abi,bytecode:a.RentV4Hook.bytecode.object,args:[manager,factoryAddress]});
  let salt;
  for(let i=0;i<160444;i++){
    const candidate=toHex(BigInt(i),{size:32});
    const hook=getCreate2Address({from:factoryAddress,salt:candidate,bytecodeHash:keccak256(init)});
    if((BigInt(hook)&0x3fffn)===0x2a80n){salt=candidate;break;}
  }
  assert.ok(salt,'CREATE2 permission salt');
  const factory=await deploy('RentV4Factory',[manager,currency,oracle,salt]);assert.equal(factory.toLowerCase(),factoryAddress.toLowerCase());
  const router=await deploy('RentV4Router',[factory]);
  const stateView=await deploy('StateView',[manager]);
  const marketPredicted=getContractAddress({from:factory,nonce:BigInt(await publicClient.getTransactionCount({address:factory}))});
  const rent0=BigInt(marketPredicted)<BigInt(currency),tick=Math.floor(Math.log(rent0?0.285:1/0.285)/Math.log(1.0001));
  const saleEnd=now+330*86400;
  const created=await write(factory,a.RentV4Factory.abi,'createMarket',[{
    baseObservationIndex:0n,baseRentCents:9288,strikeLowCents:9567,strikeHighCents:10031,
    saleEnd:BigInt(saleEnd),obsStart:BigInt(saleEnd),obsEnd:BigInt(saleEnd+30*86400),redeemEnd:BigInt(saleEnd+60*86400),
  },sqrtRatioAtTick(tick)]);
  const market=await publicClient.readContract({address:factory,abi:a.RentV4Factory.abi,functionName:'markets',args:[0n]});
  assert.equal(market.toLowerCase(),marketPredicted.toLowerCase());
  const hook=await publicClient.readContract({address:factory,abi:a.RentV4Factory.abi,functionName:'hook'});
  const target={chainId:31337,wallet:owner,market,currency,oracle,factory,router,poolManager:manager,stateView,hook,deploymentBlock:created.blockNumber};
  await write(currency,a.V4TestCurrency.abi,'mint',[owner,100000000n]);
  let state=await readV4State(publicClient,target),plan=planV4Quotes(state);
  assert.equal(plan.quotes.length,2);
  const nonceBefore=await publicClient.getTransactionCount({address:owner});
  const dry=await executeV4QuotePlan({plan,target,publicClient});assert.equal(dry.dryRun,true);
  assert.equal(await publicClient.getTransactionCount({address:owner}),nonceBefore,'dry run sent no transaction');
  const first=await executeV4QuotePlan({plan,target,publicClient,walletClient:wallet,execute:true});
  state=await readV4State(publicClient,target);assert.equal(state.positions.length,2);
  await assert.rejects(executeV4QuotePlan({plan,target,publicClient,walletClient:wallet,execute:true}),/Collateral|positions|Existing/);
  await write(currency,a.V4TestCurrency.abi,'mint',[buyer,1000000n]);
  await write(currency,ERC20_ABI,'approve',[router,1000000n],buyerWallet);
  await write(router,a.RentV4Router.abi,'swapExactInput',[{
    market,buyRent:true,amountIn:10000n,amountOutMinimum:1n,sqrtPriceLimitX96:0n,recipient:buyer,
    deadline:(await publicClient.getBlock()).timestamp+60n,
  }],buyerWallet);
  const bought=await publicClient.readContract({address:market,abi:ERC20_ABI,functionName:'balanceOf',args:[buyer]});assert.ok(bought>0n);
  state=await readV4State(publicClient,target);plan=planV4Quotes(state);
  assert.equal(plan.removals.length,2);
  const reprice=await executeV4QuotePlan({plan,target,publicClient,walletClient:wallet,execute:true});
  await publicClient.request({method:'evm_setNextBlockTimestamp',params:[saleEnd-800]});
  await publicClient.request({method:'evm_mine'});
  state=await readV4State(publicClient,target);plan=planV4Quotes(state);assert.equal(plan.quotes.length,0);
  const unwind=await executeV4QuotePlan({plan,target,publicClient,walletClient:wallet,execute:true});
  assert.equal((await readV4State(publicClient,target)).positions.length,0);
  await publicClient.request({method:'evm_setNextBlockTimestamp',params:[saleEnd]});await publicClient.request({method:'evm_mine'});
  assert.equal(planV4Quotes(await readV4State(publicClient,target)).refused,true);
  console.log(JSON.stringify({scope:'ephemeral local real PoolManager; mock dollars and oracle observations',
    dryRunSentTransactions:false,postedQuotePositions:2,buyerRentReceived:bought.toString(),repriceTransactions:reprice.receipts.length,
    initialTransactions:first.receipts.length,unwindTransactions:unwind.receipts.length,openPositionsAfterUnwind:0,
    observationWindowRefused:true,replayRefused:true,productionTransactions:0},null,2));
}finally{anvil.kill('SIGTERM');}
