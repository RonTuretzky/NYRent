/**
 * targets.test.mjs — the frozen per-chain registry, the decimals matrix, and
 * the cross-check against the executor layer's registry (the two views of the
 * same 2026-09-19 deployments can never drift apart).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TARGETS,
  getTarget,
  rpcUrlsFor,
  fmtUnits,
  POOL_ABI,
} from "./targets.mjs";
import { TARGETS as EXEC_TARGETS } from "./executors/targets.mjs";
import { DEFAULT_CONFIG, milliunitsToUnits, dustUnits } from "./policy/decide.mjs";

// ---------------------------------------------------------------------------
// frozen deployments (the args are law)
// ---------------------------------------------------------------------------

const FROZEN = {
  gnosis: {
    chainId: 100,
    oracle: "0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43",
    token: "0x821d100Aa36Beec16D830C7E2B8D5249AF62C857",
    pool: "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3",
    router: "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b",
    currency: { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18 },
  },
  arbitrum: {
    chainId: 42161,
    oracle: "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3",
    token: "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E",
    pool: "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c",
    router: "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F",
    currency: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", symbol: "USDC", decimals: 6 },
  },
};

test("registry: exactly the two frozen targets, addresses byte-identical to the args", () => {
  assert.equal(TARGETS.length, 2);
  for (const [name, frozen] of Object.entries(FROZEN)) {
    const t = getTarget(name);
    assert.equal(t.chainId, frozen.chainId);
    for (const k of ["oracle", "token", "pool", "router"]) assert.equal(t[k], frozen[k], `${name}.${k}`);
    assert.deepEqual(t.currency, frozen.currency);
    assert.ok(Array.isArray(t.rpcs) && t.rpcs.length >= 1, `${name}.rpcs non-empty`);
    assert.ok(t.chain.id === t.chainId, `${name}: viem chain object matches chainId`);
  }
});

test("executor routing: gnosis -> direct (Bankr has no Gnosis), arbitrum -> bankr", () => {
  assert.equal(getTarget("gnosis").executor, "direct");
  assert.equal(getTarget("arbitrum").executor, "bankr");
});

test("cross-check: executors/targets.mjs describes the SAME deployments", () => {
  for (const t of TARGETS) {
    const e = EXEC_TARGETS[t.name];
    assert.ok(e, `executors registry has ${t.name}`);
    assert.equal(e.chainId, t.chainId);
    assert.equal(e.addresses.pool, t.pool);
    assert.equal(e.addresses.token, t.token);
    assert.equal(e.addresses.oracle, t.oracle);
    assert.equal(e.addresses.router, t.router);
    assert.equal(e.addresses.currency, t.currency.address);
    assert.equal(e.currency.decimals, t.currency.decimals);
    assert.equal(e.currency.symbol, t.currency.symbol);
  }
  // routing consistency: bankrSupported (executor layer) ⇔ executor "bankr" (runner)
  assert.equal(EXEC_TARGETS.gnosis.bankrSupported, false);
  assert.equal(EXEC_TARGETS.arbitrum.bankrSupported, true);
});

test("getTarget: by name, by chainId, unknown fails loud", () => {
  assert.equal(getTarget("gnosis").chainId, 100);
  assert.equal(getTarget(42161).name, "arbitrum");
  assert.equal(getTarget("100").name, "gnosis");
  assert.throws(() => getTarget("base"), /unknown target/);
});

test("rpcUrlsFor: env override is tried FIRST, registry defaults follow", () => {
  const t = getTarget("gnosis");
  const urls = rpcUrlsFor(t, { GNOSIS_RPC_URL: "https://example.com/KEYKEYKEY" });
  assert.equal(urls[0], "https://example.com/KEYKEYKEY");
  assert.deepEqual(urls.slice(1), t.rpcs);
  assert.deepEqual(rpcUrlsFor(t, {}), t.rpcs);
});

// ---------------------------------------------------------------------------
// decimals matrix — "0.5 units" must mean 5e17 on WXDAI and 5e5 on USDC
// ---------------------------------------------------------------------------

test("decimals matrix: the policy caps scale with each target's currency decimals", () => {
  const g = getTarget("gnosis");
  const a = getTarget("arbitrum");
  assert.equal(
    milliunitsToUnits(DEFAULT_CONFIG.MAX_SELL_ESCROW_MILLIUNITS, { decimals: g.currency.decimals }),
    500_000_000_000_000_000n, // 0.5 WXDAI
  );
  assert.equal(
    milliunitsToUnits(DEFAULT_CONFIG.MAX_SELL_ESCROW_MILLIUNITS, { decimals: a.currency.decimals }),
    500_000n, // 0.5 USDC
  );
  assert.equal(
    milliunitsToUnits(DEFAULT_CONFIG.MAX_BUY_NOTIONAL_MILLIUNITS, { decimals: a.currency.decimals }),
    500_000n,
  );
  assert.equal(dustUnits({ decimals: g.currency.decimals }), 10_000_000_000_000n); // 1e13 wei
  assert.equal(dustUnits({ decimals: a.currency.decimals }), 10n); // 1e-5 USDC
});

test("fmtUnits renders per-currency units for humans", () => {
  const g = getTarget("gnosis").currency;
  const a = getTarget("arbitrum").currency;
  assert.equal(fmtUnits(500_000_000_000_000_000n, g), "0.5 WXDAI");
  assert.equal(fmtUnits(500_000n, a), "0.5 USDC");
  assert.equal(fmtUnits(-1_250_000n, a), "-1.25 USDC");
  assert.equal(fmtUnits(0n, a), "0 USDC");
});

test("runner POOL_ABI carries the P&L events with indexed buyer/holder/creator", () => {
  for (const name of ["ProtectionBought", "Redeemed", "ResidualWithdrawn", "SeriesCreated", "SeriesCancelled", "SeriesSettled"]) {
    const ev = POOL_ABI.find((e) => e.type === "event" && e.name === name);
    assert.ok(ev, `event ${name} present`);
  }
  const bought = POOL_ABI.find((e) => e.type === "event" && e.name === "ProtectionBought");
  assert.equal(bought.inputs.find((i) => i.name === "buyer").indexed, true);
  const redeemed = POOL_ABI.find((e) => e.type === "event" && e.name === "Redeemed");
  assert.equal(redeemed.inputs.find((i) => i.name === "holder").indexed, true);
});
