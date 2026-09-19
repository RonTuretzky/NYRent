/** Per-chain decimals formatting (chain/format.ts): the same helpers must be
 * exact for 18-dec WXDAI (Gnosis) and 6-dec USDC (Arbitrum) — decimals and
 * symbol are REQUIRED (no defaults), always the active deployment's currency. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCurrency, parseCurrency } from "../chain/format.ts";

// ------------------------------------------------------------ formatCurrency

test("format: 18-dec WXDAI", () => {
  assert.equal(
    formatCurrency(1_500_000_000_000_000_000n, {
      symbol: "WXDAI",
      decimals: 18,
    }),
    "1.5 WXDAI",
  );
  assert.equal(
    formatCurrency(1_133_000_000_000_000n, { symbol: "WXDAI", decimals: 18 }),
    "0.001133 WXDAI",
  );
});

test("format: 6-dec USDC — the same wei count means a million times more", () => {
  assert.equal(
    formatCurrency(1_500_000n, { symbol: "USDC", decimals: 6 }),
    "1.5 USDC",
  );
  assert.equal(
    formatCurrency(92_880_000n, { symbol: "USDC", decimals: 6 }),
    "92.88 USDC",
  );
  // one USDC wei renders exactly, not as 0
  assert.equal(formatCurrency(1n, { symbol: "USDC", decimals: 6 }), "0.000001 USDC");
});

test("format: zero and undefined", () => {
  assert.equal(formatCurrency(0n, { symbol: "USDC", decimals: 6 }), "0 USDC");
  assert.equal(formatCurrency(undefined, { symbol: "USDC", decimals: 6 }), "—");
});

test("format: tiny 18-dec amounts below precision render exactly", () => {
  assert.equal(
    formatCurrency(1_000_000_000n, { symbol: "WXDAI", decimals: 18 }),
    "0.000000001 WXDAI",
  );
});

// ------------------------------------------------------------- parseCurrency

test("parse: same input string, per-chain wei", () => {
  assert.equal(parseCurrency("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(parseCurrency("1.5", 6), 1_500_000n);
  assert.equal(parseCurrency("0.000001", 6), 1n);
});

test("parse: sub-wei precision rounds (callers gate on > 0n)", () => {
  // 7 decimal places cannot be represented in 6-dec USDC wei: viem's
  // parseUnits rounds, so this becomes 0n and the buy flow's `> 0n` guard
  // treats it as no amount entered.
  assert.equal(parseCurrency("0.0000001", 6), 0n);
  // the same string is exact in 18-dec WXDAI
  assert.equal(parseCurrency("0.0000001", 18), 100_000_000_000n);
});

test("parse: rejects malformed input", () => {
  assert.equal(parseCurrency("", 6), null);
  assert.equal(parseCurrency(".", 6), null);
  assert.equal(parseCurrency("1,5", 6), null);
  assert.equal(parseCurrency("1e5", 6), null);
  assert.equal(parseCurrency("-1", 6), null);
});
