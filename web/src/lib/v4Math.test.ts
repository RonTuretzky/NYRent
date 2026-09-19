import test from "node:test";
import assert from "node:assert/strict";
import { fullRangeAmounts, fullRangeLiquidity, minimumOutput, rentPoolId, rentSpotPrice, type RentPoolKey } from "../chain/v4Math.ts";

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
