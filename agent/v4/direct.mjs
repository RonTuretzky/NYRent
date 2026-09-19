import { ERC20_ABI, MARKET_ABI, ROUTER_ABI, TARGET_FIELDS, sameAddress, readV4State } from "./chain.mjs";
import { amountsForLiquidity, sqrtRatioAtTick } from "./math.mjs";

export const EXECUTION_CAPS = Object.freeze({
  maxGasPerTransaction: 1_000_000n, maxGasTotal: 5_000_000n,
  maxGasPriceWei: 1_000_000_000n, maxNativeCostWei: 5_000_000_000_000_000n,
});
const uint = (v) => { const n=BigInt(v); if(n<0n || n>(1n<<128n)-1n) throw new Error("Invalid uint128 amount"); return n; };
const positionId = p => `${p.tickLower}:${p.tickUpper}`;
const within = (a,b) => (a > b ? a-b : b-a) * 10000n <= b * 50n; // 0.5% sqrt ~= 1% price drift
const activeExecutions = new Set();

/** Re-derive every economic cap from current state. A hand-edited plan cannot widen pilot budgets. */
export function validateV4Plan(plan, live, target) {
  if (plan.version !== 1 || plan.refused) throw new Error("Plan is refused or has an unsupported version");
  for (const f of TARGET_FIELDS) if (!sameAddress(plan.target[f], target[f])) throw new Error(`Plan target mismatch: ${f}`);
  if (plan.target.chainId !== target.chainId || live.chainId !== target.chainId) throw new Error("Plan chain mismatch");
  if (!Number.isSafeInteger(plan.decidedAt) || !Number.isSafeInteger(plan.validUntil)
    || plan.decidedAt > live.timestamp || plan.validUntil <= live.timestamp || plan.validUntil-plan.decidedAt > 300
    || BigInt(plan.decidedAtBlock) > live.blockNumber) throw new Error("Stale or future plan");
  if (!within(BigInt(live.sqrtPriceX96), BigInt(plan.sqrtPriceX96))) throw new Error("Pool price moved; replan");
  for (const f of ["currency0","currency1","hooks"]) if (!sameAddress(plan.poolKey[f], live.poolKey[f])) throw new Error("Pool key mismatch");
  if (plan.poolKey.fee !== live.poolKey.fee || plan.poolKey.tickSpacing !== live.poolKey.tickSpacing) throw new Error("Pool parameters mismatch");
  if (!Array.isArray(plan.quotes) || !Array.isArray(plan.removals) || plan.quotes.length>2 || plan.removals.length>2) throw new Error("Too many positions");
  if (plan.removals.length && !live.removalOpen) throw new Error("Observation lock");
  const half = 10n**BigInt(live.decimals)/2n;
  const mint = uint(plan.mintAmount);
  if (mint > half || live.residualShares !== BigInt(plan.collateralBefore) || (mint>0n && live.residualShares+mint > 4n*half)) throw new Error("Collateral cap or stale collateral state");
  if ((mint || plan.quotes.length) && (!live.tradingOpen || live.timestamp+900 >= Number(live.saleEnd))) throw new Error("Trading cutoff reached");
  const rent0 = sameAddress(live.poolKey.currency0, target.market);
  let cash = live.currencyBalance, rent = live.rentBalance, spendCash = mint, spendRent = 0n;
  const removed = new Set(), quoted = new Set();
  for (const p of [...plan.removals,...plan.quotes]) {
    if (!Number.isInteger(p.tickLower) || !Number.isInteger(p.tickUpper) || p.tickLower%60 || p.tickUpper%60
      || p.tickLower >= p.tickUpper || p.tickLower < -887220 || p.tickUpper > 887220
      || uint(p.liquidity) === 0n || BigInt(p.liquidity) >= (1n<<127n)) throw new Error("Invalid quote position");
  }
  for (const p of plan.removals) {
    const id = positionId(p), existing = live.positions.find(x=>positionId(x)===id);
    if (removed.has(id) || !existing || existing.liquidity !== BigInt(p.liquidity)) throw new Error("Position changed; replan");
    removed.add(id);
    const amounts = amountsForLiquidity(live.sqrtPriceX96,p.tickLower,p.tickUpper,BigInt(p.liquidity));
    const minimums=[uint(p.amount0Minimum),uint(p.amount1Minimum)];
    // Floors must protect >=95% of current principal; LP fees may increase actual receipts.
    for(let i=0;i<2;i++) if(minimums[i] < amounts[i]*95n/100n || minimums[i]>amounts[i]) throw new Error("Unsafe withdrawal minimum");
    cash += minimums[rent0?1:0]; rent += minimums[rent0?0:1];
  }
  if (live.positions.some(p=>p.liquidity>0n && !removed.has(positionId(p)))) throw new Error("All open router positions must be explicitly replaced or unwound");
  for (const p of plan.quotes) {
    if (!['bid','ask'].includes(p.side) || quoted.has(p.side)) throw new Error("Duplicate or invalid quote side");
    quoted.add(p.side);
    const existing = live.positions.find(x=>positionId(x)===positionId(p));
    if (existing?.liquidity>0n && !removed.has(positionId(p))) throw new Error("Existing range must be explicitly replaced");
    const required=amountsForLiquidity(live.sqrtPriceX96,p.tickLower,p.tickUpper,BigInt(p.liquidity),true);
    const maxima=[uint(p.amount0Maximum),uint(p.amount1Maximum)];
    const rentIndex=rent0?0:1, cashIndex=1-rentIndex;
    for(let i=0;i<2;i++) if(required[i]>maxima[i]) throw new Error("LP funding exceeds signed maximum");
    if (p.side==='bid') {
      if (required[rentIndex]!==0n || maxima[rentIndex]!==0n || maxima[cashIndex]>half) throw new Error("Bid cash cap or crossed range");
      const acquired=amountsForLiquidity(sqrtRatioAtTick(rent0?p.tickLower:p.tickUpper),p.tickLower,p.tickUpper,BigInt(p.liquidity),true)[rentIndex];
      if(acquired>half) throw new Error("Bid RENT acquisition cap");
    } else if(required[cashIndex]!==0n || maxima[cashIndex]!==0n || maxima[rentIndex]>half) throw new Error("Ask inventory cap or crossed range");
    spendCash+=maxima[cashIndex]; spendRent+=maxima[rentIndex];
  }
  if(spendCash>cash || spendRent>rent+mint) throw new Error("Insufficient balances after bounded removals");
  return { mint, spendCash, spendRent };
}

/** Direct-only opt-in executor. No environment, keychain, Bankr, scheduler, or private-key access.
 * Dry run is the default. An explicit caller-supplied wallet client is required to send transactions. */
export async function executeV4QuotePlan({plan,target,publicClient,walletClient,execute=false}) {
  const lockKey=`${target.chainId}:${String(target.wallet).toLowerCase()}`;
  if(execute && activeExecutions.has(lockKey))throw new Error('Another execution already owns this chain/wallet process lock');
  if(execute)activeExecutions.add(lockKey);
  try {
    if(execute){
      const [latest,pending]=await Promise.all([
        publicClient.getTransactionCount({address:target.wallet,blockTag:'latest'}),
        publicClient.getTransactionCount({address:target.wallet,blockTag:'pending'}),
      ]);
      if(pending!==latest)throw new Error('Wallet has pending transactions; reconcile receipts before executing');
    }
    return await executeLocked({plan,target,publicClient,walletClient,execute});
  }finally{if(execute)activeExecutions.delete(lockKey);}
}

async function executeLocked({plan,target,publicClient,walletClient,execute}) {
  const tracked=[...new Map([...plan.removals,...plan.quotes].map(p=>[positionId(p),p])).values()];
  // readV4State's two-position cap applies to public planning; replacement can inspect four ranges here.
  const live=await readV4State(publicClient,target);
  for(const p of tracked) if(!live.positions.some(x=>positionId(x)===positionId(p))) {
    live.positions.push({...p,liquidity:await publicClient.readContract({address:target.router,abi:ROUTER_ABI,
      functionName:'liquidityOf',args:[target.wallet,target.market,p.tickLower,p.tickUpper],blockNumber:live.blockNumber})});
  }
  const {mint}=validateV4Plan(plan,live,target);
  const txs=[];
  const push=(address,abi,functionName,args,gasCeiling)=>txs.push({address,abi,functionName,args,gasCeiling});
  const lp=(p,add)=>push(target.router,ROUTER_ABI,'modifyLiquidity',[{
    market:target.market,tickLower:p.tickLower,tickUpper:p.tickUpper,
    liquidityDelta:add?BigInt(p.liquidity):-BigInt(p.liquidity),
    amount0Limit:BigInt(add?p.amount0Maximum:p.amount0Minimum),amount1Limit:BigInt(add?p.amount1Maximum:p.amount1Minimum),
    recipient:target.wallet,deadline:BigInt(plan.validUntil),
  }],800000n);
  for(const p of plan.removals) lp(p,false);
  const approve=async(token,spender,needed)=>{
    if(needed===0n)return;
    const current=await publicClient.readContract({address:token,abi:ERC20_ABI,functionName:'allowance',args:[target.wallet,spender]});
    if(current<needed)push(token,ERC20_ABI,'approve',[spender,needed],100000n);
  };
  if(mint) {await approve(target.currency,target.market,mint);push(target.market,MARKET_ABI,'depositAndMint',[mint,target.wallet],300000n);}
  const sums=[0n,0n];for(const p of plan.quotes){sums[0]+=BigInt(p.amount0Maximum);sums[1]+=BigInt(p.amount1Maximum);}
  await approve(live.poolKey.currency0,target.router,sums[0]);await approve(live.poolKey.currency1,target.router,sums[1]);
  for(const p of plan.quotes)lp(p,true);
  const gasCeiling=txs.reduce((sum,tx)=>sum+tx.gasCeiling,0n),gasPrice=await publicClient.getGasPrice();
  if(gasCeiling>EXECUTION_CAPS.maxGasTotal || gasPrice>EXECUTION_CAPS.maxGasPriceWei
    || gasCeiling*gasPrice>EXECUTION_CAPS.maxNativeCostWei)throw new Error('Gas budget exceeded');
  if(!execute)return {dryRun:true,transactions:txs,gasCeiling,maxNativeCost:gasCeiling*gasPrice,
    note:'Calldata and caps checked. Dependent transactions are simulated individually only after prior receipts in opt-in execution.'};
  if(!walletClient?.account || !sameAddress(typeof walletClient.account==='string'?walletClient.account:walletClient.account.address,target.wallet)
    || await walletClient.getChainId()!==target.chainId)throw new Error('Explicit signer does not match plan wallet/chain');
  if(await publicClient.getBalance({address:target.wallet})<gasCeiling*gasPrice)throw new Error('Insufficient native gas balance');
  const receipts=[];
  try {
    for(const tx of txs){
      const block=await publicClient.getBlock();if(Number(block.timestamp)>=plan.validUntil)throw new Error('Plan expired during execution');
      const {gasCeiling:ceiling,...request}=tx;
      const simulation=await publicClient.simulateContract({...request,account:walletClient.account});
      const estimate=await publicClient.estimateContractGas({...request,account:walletClient.account});
      const gas=(estimate*120n+99n)/100n;
      if(gas>ceiling || gas>EXECUTION_CAPS.maxGasPerTransaction)throw new Error('Transaction gas ceiling exceeded');
      const hash=await walletClient.writeContract({...simulation.request,account:walletClient.account,gas,gasPrice});
      const receipt=await publicClient.waitForTransactionReceipt({hash});receipts.push(receipt);
      if(receipt.status!=='success')throw new Error(`Transaction reverted: ${hash}`);
    }
  }catch(error){error.receipts=receipts;throw error;}
  return {dryRun:false,receipts,trackedPositions:plan.quotes.map(p=>({tickLower:p.tickLower,tickUpper:p.tickUpper}))};
}
