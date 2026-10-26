// Read-only live-chain simulation. Never loads keys or broadcasts transactions.
import {createPublicClient,http,parseAbi} from '../web/node_modules/viem/_esm/index.js';
import fs from 'node:fs';
const configs=JSON.parse(fs.readFileSync(new URL('../web/src/chain/v4-deployments.json',import.meta.url)));
const abi=parseAbi(['function oracle() view returns(address)','function createMarket((uint256 baseObservationIndex,uint32 baseRentCents,uint32 strikeLowCents,uint32 strikeHighCents,uint64 saleEnd,uint64 obsStart,uint64 obsEnd,uint64 redeemEnd) terms,uint160 sqrtPriceX96) returns(address)']);
const results=[];
for(const [id,url] of [[137,'https://polygon-bor-rpc.publicnode.com'],[42161,'https://arb1.arbitrum.io/rpc']]){
 const c=createPublicClient({transport:http(url,{timeout:20000,retryCount:0})}); const d=configs[id];
 try{
 const block=await c.getBlock(); const oracle=await c.readContract({address:d.factory,abi,functionName:'oracle'});
 if(oracle.toLowerCase()!==d.oracle.toLowerCase()) throw Error('Oracle mismatch');
 const base=await c.readContract({address:oracle,abi:parseAbi(['function observations(uint256) view returns(uint64,uint32,bytes32)']),functionName:'observations',args:[0n]});
 const start=block.timestamp+86400n*30n;
 const simulation=await c.simulateContract({address:d.factory,abi,functionName:'createMarket',account:'0x0000000000000000000000000000000000001234',args:[{baseObservationIndex:0n,baseRentCents:base[1],strikeLowCents:9567,strikeHighCents:10032,saleEnd:start,obsStart:start+86400n,obsEnd:start+86400n*31n,redeemEnd:start+86400n*38n},2n**96n]});
 results.push({chainId:id,block:block.number.toString(),factory:d.factory,oracle,baseCents:base[1],arbitraryCallerSimulation:'passed',predictedAddress:simulation.result,broadcast:false});
 }catch(e){results.push({chainId:id,error:e.shortMessage||e.message,broadcast:false});}
}
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.error)) process.exitCode=1;
