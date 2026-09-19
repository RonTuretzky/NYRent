import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { targetOf, chainFor, hasOracle, initialSqrtPrice, liquidityFor, publicClient } from './v4-prepare.mjs';
import { launch } from './v4-launch.mjs';

test('target chain, transport and USDC identity agree with the frontend', () => {
  const registry = JSON.parse(readFileSync(new URL('../web/src/chain/deployments.json', import.meta.url)));
  for (const name of ['arbitrum', 'polygon']) {
    const t = targetOf(name);
    assert.equal(chainFor(t).id, t.chainId);
    assert.equal(publicClient(t.rpc, t).chain.id, t.chainId);
    assert.equal(t.currency.toLowerCase(), registry[t.chainId].currency.address.toLowerCase());
    assert.equal(registry[t.chainId].currency.decimals, 6);
  }
  assert.equal(targetOf(137), targetOf('polygon'));
  assert.equal(chainFor(targetOf('polygon')).nativeCurrency.symbol, 'POL');
  assert.equal(hasOracle(targetOf('polygon')), false);
  assert.equal(hasOracle(targetOf('arbitrum')), true);
  assert.throws(() => targetOf(1), /Unsupported/);
});

test('price and liquidity use the selected USDC address for token ordering', () => {
  // This address falls between Polygon USDC and Arbitrum USDC.
  const rent = '0x5000000000000000000000000000000000000000';
  const arb = initialSqrtPrice(rent, 285n, 1000n, targetOf('arbitrum'));
  const poly = initialSqrtPrice(rent, 285n, 1000n, targetOf('polygon'));
  assert.ok(arb < 2n ** 96n && poly > 2n ** 96n);
  const sizing = liquidityFor(poly, rent, 1_000_000n, 285_000n, targetOf('polygon'));
  assert.equal(sizing.maximum0, 285_000n);
  assert.equal(sizing.maximum1, 1_000_000n);
  assert.ok(sizing.liquidity > 0n);
});

test('wrong-chain and ETH-denominated Polygon launches fail before reading keys or broadcasting', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rentsafe-target-test-'));
  const plan = path.join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify({ chainId: 137 }));
  try {
    await assert.rejects(launch({ plan, chain: 'arbitrum' }), /Requested chain differs/);
    await assert.rejects(launch({ plan, 'max-gas-eth': '1' }), /Arbitrum-only/);
    await assert.rejects(launch({ execute: true, plan }), /Execution requires/);
    writeFileSync(plan, JSON.stringify({ chainId: 137, integrationOnly: 'synthetic funding' }));
    await assert.rejects(launch({ execute: true, plan, report: 'unused', 'max-gas-native': '1', 'max-capital-usdc': '2' }), /Integration-only plans cannot execute/);
  } finally { rmSync(dir, { recursive: true }); }
});
