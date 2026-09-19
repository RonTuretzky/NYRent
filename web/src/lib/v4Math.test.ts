import test from "node:test";
import assert from "node:assert/strict";
import { fullRangeAmounts, fullRangeLiquidity, quoteFullRangeDeposit, minimumOutput, quotePriceImpact, spotOutput, rentPoolId, rentSpotPrice, type RentPoolKey } from "../chain/v4Math.ts";

const key: RentPoolKey = { currency0: "0x0000000000000000000000000000000000000001", currency1: "0x0000000000000000000000000000000000000002", fee: 8388608, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000003a80" };
test("pool identity includes hook, fee and tick spacing", () => {
  assert.notEqual(rentPoolId(key), rentPoolId({ ...key, fee: 3000 }));
  assert.notEqual(rentPoolId(key), rentPoolId({ ...key, tickSpacing: 10 }));
});
test("RENT price respects sorted token order", () => {
  assert.equal(rentSpotPrice(2n ** 95n, key, key.currency0), .25);
  assert.equal(rentSpotPrice(2n ** 95n, key, key.currency1), 4);
});
test("slippage bounds protect exact bigint amounts including values above Number precision", () => {
  const large = 123456789012345678901234567890n;
  assert.equal(minimumOutput(large), large * 99n / 100n);
  assert.throws(() => minimumOutput(0n));
  assert.throws(() => minimumOutput(1n));
  assert.throws(() => minimumOutput(100n, 10000));
});
test("full range fits both budgets at prices above and below parity with large integer balances", () => {
  for (const sqrt of [2n ** 94n, 2n ** 96n, 2n ** 98n]) {
    for (const [maximum0, maximum1] of [[10000n, 2850n], [10n ** 24n, 2n * 10n ** 23n]]) {
      const liquidity = fullRangeLiquidity(sqrt, maximum0, maximum1);
      const [amount0, amount1] = fullRangeAmounts(sqrt, liquidity);
      assert.ok(liquidity > 0n && amount0 > 0n && amount1 > 0n);
      assert.ok(amount0 < maximum0 && amount1 < maximum1);
    }
  }
  assert.equal(fullRangeLiquidity(1n, 100n, 100n), 0n);
  assert.equal(fullRangeLiquidity(2n ** 96n, 0n, 100n), 0n);
});

test("RENT-only liquidity calculates matching USDC in either token order", () => {
  for (const [sqrt, rentIs0] of [[2n ** 95n, true], [2n ** 97n, false]] as const) {
    const quote = quoteFullRangeDeposit(sqrt, 500_000000n, rentIs0)!;
    assert.equal(quote.rentAmount, 500_000000n);
    assert.equal(quote.cashAmount, 125_000000n);
    assert.equal(quote.cashMaximum, 126_250000n);
    assert.equal(quote.rentMaximum, 500_000000n);
  }
});

test("deposit debits round up exactly as v4 and never exceed the entered RENT", () => {
  for (const sqrt of [2n ** 90n, 2n ** 95n, 2n ** 96n, 2n ** 100n]) {
    for (const rentIs0 of [true, false]) for (const rent of [1000n, 123_456789n, 10n ** 27n]) {
      const quote = quoteFullRangeDeposit(sqrt, rent, rentIs0)!;
      assert.ok(quote.liquidity > 0n);
      assert.ok(quote.rentAmount <= rent);
      assert.ok(quote.cashMaximum >= quote.cashAmount);
      const next = fullRangeAmounts(sqrt, quote.liquidity + 1n, true);
      assert.ok(next[rentIs0 ? 0 : 1] > rent, "liquidity must be the largest amount that fits the RENT ceiling");
      const floor = fullRangeAmounts(sqrt, quote.liquidity);
      const ceil = fullRangeAmounts(sqrt, quote.liquidity, true);
      for (const i of [0, 1]) assert.ok(ceil[i] >= floor[i] && ceil[i] - floor[i] <= 1n);
    }
  }
});

test("a reviewed USDC maximum excludes an adverse price move and permits a cheaper deposit", () => {
  const q96 = 1n << 96n;
  for (const rentIs0 of [true, false]) {
    const reviewed = quoteFullRangeDeposit(q96, 100_000000n, rentIs0)!;
    const expensive = quoteFullRangeDeposit(rentIs0 ? q96 * 102n / 100n : q96 * 98n / 100n, reviewed.rentMaximum, rentIs0)!;
    const cheaper = quoteFullRangeDeposit(rentIs0 ? q96 * 98n / 100n : q96 * 102n / 100n, reviewed.rentMaximum, rentIs0)!;
    assert.ok(expensive.cashAmount > reviewed.cashMaximum);
    assert.ok(cheaper.cashAmount < reviewed.cashAmount);
    assert.equal(expensive.rentMaximum, reviewed.rentMaximum);
    assert.equal(cheaper.rentMaximum, reviewed.rentMaximum);
  }
});

test("invalid or unrepresentable RENT-only liquidity quotes are unavailable", () => {
  assert.equal(quoteFullRangeDeposit(1n, 100n, true), null);
  assert.equal(quoteFullRangeDeposit(2n ** 96n, 0n, true), null);
  assert.equal(quoteFullRangeDeposit(2n ** 96n, 2n ** 128n, true), null);
  assert.equal(quoteFullRangeDeposit(2n ** 95n, 1n, true), null);
  assert.throws(() => quoteFullRangeDeposit(2n ** 96n, 100n, true, -1));
});


test("spot conversion uses exact token order for buy and sell", () => {
  const sqrt = 2n ** 95n; // token1 costs 4 token0; inverse is 0.25
  assert.equal(spotOutput(100_000000n, sqrt, false), 400_000000n);
  assert.equal(spotOutput(100_000000n, sqrt, true), 25_000000n);
  const large = 10n ** 30n;
  assert.equal(spotOutput(large, sqrt, false), large * 4n);
});

test("quote impact blocks a huge spend into a tiny pool in either token order", () => {
  const buy = quotePriceImpact(100_000000n, 499000n, 2n ** 95n, false);
  assert.equal(buy.atSpot, 400_000000n);
  assert.ok(buy.bps! > 9900n);
  assert.equal(buy.blocked, true);
  assert.equal(quotePriceImpact(100_000000n, 499000n, 2n ** 97n, true).blocked, true);
  assert.equal(quotePriceImpact(4_000000n, 500000n, 2n ** 95n, true).blocked, true);
});

test("quote limit includes fees and protects the exact ten-percent boundary", () => {
  const sqrt = 1n << 96n;
  assert.equal(quotePriceImpact(1_000000n, 990000n, sqrt, true).blocked, false);
  assert.equal(quotePriceImpact(1_000000n, 900000n, sqrt, true).blocked, false);
  assert.equal(quotePriceImpact(1_000000n, 899999n, sqrt, true).blocked, true);
  assert.equal(quotePriceImpact(100n, 101n, sqrt, true).bps, 0n);
  assert.equal(quotePriceImpact(1n, 1n, sqrt, true).blocked, true);
  assert.equal(quotePriceImpact(0n, 0n, sqrt, true).blocked, true);
});
