import test from 'node:test';
import assert from 'node:assert/strict';
import {planV4Quotes} from './plan.mjs';
import {validateV4Plan,executeV4QuotePlan} from './direct.mjs';
import {sqrtRatioAtTick,amountsForLiquidity,liquidityForAmounts,rentPrice} from './math.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const NOW=1789642500;
function state(rent0=true,decimals=6){
  const unit=10n**BigInt(decimals), market=addr(rent0?1:20), currency=addr(10);
  const tick=Math.floor(Math.log(rent0?0.285:1/0.285)/Math.log(1.0001));
  return {chainId:31337,wallet:addr(100),market,currency,factory:addr(30),router:addr(40),poolManager:addr(50),
    oracle:addr(60),stateView:addr(70),hook:addr(80),blockNumber:100n,timestamp:NOW,decimals,
    poolKey:{currency0:rent0?market:currency,currency1:rent0?currency:market,fee:0x800000,tickSpacing:60,hooks:addr(80)},
    sqrtPriceX96:sqrtRatioAtTick(tick),tick,currencyBalance:10n*unit,rentBalance:0n,residualShares:0n,
    strikeLowCents:9567,strikeHighCents:10031,saleEnd:NOW+330*86400,obsStart:NOW+330*86400,obsEnd:NOW+360*86400,
    tradingOpen:true,removalOpen:true,prints:[{t:NOW-86400,cents:9288,verified:true}],positions:[]};
}
test('exact TickMath matches upstream golden vectors',()=>{
  assert.equal(sqrtRatioAtTick(0),1n<<96n);
  assert.equal(sqrtRatioAtTick(-887220),4306310044n);
  assert.equal(sqrtRatioAtTick(887220),1457652066949847389969617340386294118487833376468n);
  assert.equal(sqrtRatioAtTick(-887272),4295128739n);
  assert.equal(sqrtRatioAtTick(887272),1461446703485210103287273052203988822378723970342n);
});
for(const rent0 of [true,false])for(const decimals of [6,18]){
  test(`two single-sided capped Bachelier ranges, rent0=${rent0}, decimals=${decimals}`,()=>{
    const s=state(rent0,decimals),p=planV4Quotes(s),half=10n**BigInt(decimals)/2n;
    assert.equal(p.quotes.length,2);assert.ok(p.valuation.ratioBps>0);assert.ok(p.mintAmount<=half);
    validateV4Plan(p,s,p.target);
    for(const q of p.quotes){
      const a=amountsForLiquidity(s.sqrtPriceX96,q.tickLower,q.tickUpper,q.liquidity,true);
      assert.equal(a[(q.side==='ask')===rent0?1:0],0n);
      assert.ok(a[0]+a[1]<=half);
      if(q.side==='bid'){
        const end=sqrtRatioAtTick(rent0?q.tickLower:q.tickUpper);
        assert.ok(amountsForLiquidity(end,q.tickLower,q.tickUpper,q.liquidity,true)[rent0?0:1]<=half);
      }
    }
  });
}
test('inventory lean lowers quotes when RENT inventory is high',()=>{
  const s=state(),empty=planV4Quotes(s);s.rentBalance=500000n;const full=planV4Quotes(s);
  assert.ok(full.inventoryLeanBps>empty.inventoryLeanBps);
  assert.equal(full.mintAmount,0n);
  assert.ok(full.quotes.find(q=>q.side==='bid').tickUpper<empty.quotes.find(q=>q.side==='bid').tickUpper);
});
test('stale, unverified, future signals cannot create inventory or quotes',()=>{
  for(const signal of [{t:NOW-46*86400,cents:9288,verified:true},{t:NOW+1,cents:9288,verified:true},{t:NOW,cents:9288,verified:false}]){
    const s=state();s.prints=[signal];const p=planV4Quotes(s);assert.equal(p.mintAmount,0n);assert.deepEqual(p.quotes,[]);
  }
});
test('fresh latest observation retains older authentic history for Bachelier volatility',()=>{
  const s=state();s.prints=[9100,9200,9150,9288].map((cents,i)=>({t:NOW-(91-30*i)*86400,cents,verified:true}));
  const p=planV4Quotes(s);assert.equal(p.valuation.sigmaSource,'history');assert.equal(p.valuation.sigmaN,4);
});
test('cutoff creates unwind-only plan; observation blackout refuses every action',()=>{
  const s=state(),q=planV4Quotes(s).quotes[0];s.positions=[q];s.saleEnd=NOW+899;
  const close=planV4Quotes(s);assert.equal(close.quotes.length,0);assert.equal(close.removals.length,1);
  s.removalOpen=false;const locked=planV4Quotes(s);assert.equal(locked.refused,true);assert.equal(locked.removals.length,0);
});
test('executor rechecks target, freshness, aggregate collateral and acquisition caps',()=>{
  const s=state(),p=planV4Quotes(s);
  const mutate=f=>{const x=structuredClone(p);f(x);assert.throws(()=>validateV4Plan(x,s,p.target));};
  mutate(x=>x.target.wallet=addr(999));mutate(x=>x.target.chainId=42161);mutate(x=>x.validUntil=NOW-1);
  mutate(x=>x.mintAmount=500001n);mutate(x=>x.quotes[0].liquidity*=100n);
  mutate(x=>x.quotes[0].amount0Maximum=1000000n);mutate(x=>x.quotes.push(x.quotes[0]));
  mutate(x=>x.quotes[0].tickUpper+=1);mutate(x=>x.collateralBefore=1n);
});
test('unknown pre-existing LP ranges and replayed collateral are refused',()=>{
  const s=state(),p=planV4Quotes(s);s.positions=[{...p.quotes[0],liquidity:100n}];
  assert.throws(()=>validateV4Plan(p,s,p.target),/positions|Existing/);
  s.positions=[];s.residualShares=p.mintAmount;assert.throws(()=>validateV4Plan(p,s,p.target),/Collateral/);
});
test('integer liquidity never requires more than chosen token budgets across many prices',()=>{
  for(let tick=-50000;tick<50000;tick+=997){
    const p=sqrtRatioAtTick(tick),l=liquidityForAmounts(p,-60000,60000,500000n,500000n)*99n/100n;
    const [a,b]=amountsForLiquidity(p,-60000,60000,l,true);assert.ok(a<=500000n&&b<=500000n);
    assert.ok(rentPrice(p,true)>0);
  }
});
test('same-process concurrent execution is refused before any chain action and lock releases on failure',async()=>{
  const s=state(),p=planV4Quotes(s);
  let release;const barrier=new Promise(r=>release=r);
  const client={getTransactionCount:async()=>{await barrier;throw new Error('deliberate preflight failure');}};
  const first=executeV4QuotePlan({plan:p,target:p.target,publicClient:client,execute:true});
  await assert.rejects(executeV4QuotePlan({plan:p,target:p.target,publicClient:client,execute:true}),/process lock/);
  release();await assert.rejects(first,/deliberate preflight/);
  await assert.rejects(executeV4QuotePlan({plan:p,target:p.target,publicClient:client,execute:true}),/deliberate preflight/);
});
test('pending wallet transactions block execution before state reads or sends',async()=>{
  const s=state(),p=planV4Quotes(s);
  const client={getTransactionCount:async({blockTag})=>blockTag==='pending'?2:1};
  await assert.rejects(executeV4QuotePlan({plan:p,target:p.target,publicClient:client,execute:true}),/pending transactions/);
});
