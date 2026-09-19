#!/usr/bin/env node
// Read-only CLI. Sending is deliberately available only through the explicit signer-injection API.
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {createPublicClient,http} from 'viem';
import {readV4State} from './chain.mjs';
import {planV4Quotes} from './plan.mjs';
import {executeV4QuotePlan} from './direct.mjs';
const {values}=parseArgs({options:{target:{type:'string'},rpc:{type:'string'},help:{type:'boolean'}},strict:true});
if(values.help || !values.target || !values.rpc){
  console.log('Read-only: node agent/v4/run.mjs --target PUBLIC_TARGET.json --rpc RPC_URL\nTarget fields: chainId,wallet,market,currency,oracle,factory,hook,router,poolManager,stateView,deploymentBlock.\nNo keys are read. Direct sending requires executeV4QuotePlan({execute:true,walletClient,...}) with an explicitly supplied signer.');
  process.exit(values.help?0:1);
}
const target=JSON.parse(await readFile(values.target,'utf8'));
const publicClient=createPublicClient({transport:http(values.rpc)});
const state=await readV4State(publicClient,target);
const plan=planV4Quotes(state);
const result=plan.refused?{dryRun:true,refused:true}:await executeV4QuotePlan({plan,target,publicClient});
console.log(JSON.stringify({plan,result},(_k,v)=>typeof v==='bigint'?v.toString():v,2));
