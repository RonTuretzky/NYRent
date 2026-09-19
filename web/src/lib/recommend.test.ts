/** Unit tests for the /choose recommendation logic (lib/recommend.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capacityLeft,
  isOpenForSale,
  isStandard,
  premiumFor,
  recommend,
  riseFractionOf,
  targetMonths,
  usdToWei,
  weiToUsd,
  type CandidateSeries,
} from "./recommend.ts";

const NOW = 1_760_000_000n;

function series(over: Partial<CandidateSeries> = {}): CandidateSeries {
  return {
    id: 0,
    strikeLowCents: 8800,
    strikeHighCents: 9600, // 800-cent band → standard shape
    premiumRateBps: 1133,
    saleEnd: NOW + 86_400n,
    obsStart: NOW + 86_400n, // == saleEnd → standard shape
    obsEnd: NOW + 30n * 86_400n,
    escrow: 10n ** 24n, // 1,000,000 units at 18 decimals
    sold: 0n,
    paused: false,
    settled: false,
    cancelled: false,
    ...over,
  };
}

test("standard shape = 800-cent band with saleEnd == obsStart", () => {
  assert.equal(isStandard(series()), true);
  assert.equal(isStandard(series({ strikeHighCents: 9700 })), false);
  assert.equal(isStandard(series({ obsStart: NOW + 90_000n })), false);
});

test("open-for-sale gating", () => {
  assert.equal(isOpenForSale(series(), NOW), true);
  assert.equal(isOpenForSale(series({ paused: true }), NOW), false);
  assert.equal(isOpenForSale(series({ settled: true }), NOW), false);
  assert.equal(isOpenForSale(series({ cancelled: true }), NOW), false);
  assert.equal(isOpenForSale(series({ saleEnd: NOW - 1n }), NOW), false);
  assert.equal(isOpenForSale(series({ sold: series().escrow }), NOW), false);
});

test("cancelled series report zero capacity even with escrow recorded", () => {
  assert.equal(capacityLeft(series({ cancelled: true })), 0n);
});

test("usd/wei round-trips at both live decimal scales", () => {
  assert.equal(usdToWei(2181.82, 18), 2_181_820_000_000_000_000_000n);
  assert.equal(usdToWei(2181.82, 6), 2_181_820_000n);
  assert.equal(weiToUsd(2_181_820_000n, 6), 2181.82);
  assert.equal(usdToWei(0, 18), 0n);
  assert.equal(usdToWei(-5, 18), 0n);
});

test("premium math matches the pool (claim × bps / 1e4, truncating)", () => {
  assert.equal(premiumFor(10_000_000_000_000_000n, 2850), 2_850_000_000_000_000n);
  assert.equal(premiumFor(3n, 1133), 0n); // dust truncates like on-chain
});

test("recommend picks the cheapest standard series", () => {
  const rec = recommend({
    monthlyRentUsd: 2000,
    worry: "a-little",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 18,
    series: [
      series({ id: 0, premiumRateBps: 1500 }),
      series({ id: 1, premiumRateBps: 900 }),
      // cheaper but nonstandard — standard shape wins the pool
      series({ id: 2, premiumRateBps: 100, strikeHighCents: 9700 }),
    ],
  });
  assert.ok(rec);
  assert.equal(rec.seriesId, 1);
  assert.equal(rec.standard, true);
  assert.equal(rec.premiumRateBps, 900);
});

test("falls back to nonstandard series when no standard one is open", () => {
  const rec = recommend({
    monthlyRentUsd: 2000,
    worry: "a-little",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 18,
    series: [
      series({ id: 0, paused: true }),
      series({ id: 1, strikeHighCents: 9700, premiumRateBps: 700 }),
    ],
  });
  assert.ok(rec);
  assert.equal(rec.seriesId, 1);
  assert.equal(rec.standard, false);
});

test("horizon breaks premium ties by observation-window distance", () => {
  const near = series({ id: 0, obsEnd: NOW + 20n * 86_400n });
  const far = series({ id: 1, obsEnd: NOW + 200n * 86_400n });
  const base = {
    monthlyRentUsd: 2000,
    worry: "a-little" as const,
    nowSec: NOW,
    currencyDecimals: 18,
    series: [far, near],
  };
  assert.equal(recommend({ ...base, horizon: "this-window" })!.seriesId, 0);
  assert.equal(recommend({ ...base, horizon: "longer" })!.seriesId, 1);
});

test("band math sizes the claim from rent exposure", () => {
  // rise = 800/8800 ≈ 9.09%; monthly increase = 2000 × rise ≈ $181.82;
  // "a lot" worried → 12 months ≈ $2181.82.
  const rec = recommend({
    monthlyRentUsd: 2000,
    worry: "a-lot",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 18,
    series: [series()],
  });
  assert.ok(rec);
  assert.ok(Math.abs(rec.riseFraction - 800 / 8800) < 1e-12);
  const usd = weiToUsd(rec.suggestedClaimWei, 18);
  assert.ok(Math.abs(usd - 2181.82) < 0.01, `got ${usd}`);
  assert.ok(Math.abs(rec.monthsCovered - 12) < 0.01);
  assert.equal(rec.capacityLimited, false);
  assert.equal(rec.premiumWei, premiumFor(rec.suggestedClaimWei, 1133));
});

test("worry level scales the target months", () => {
  assert.equal(targetMonths("a-little"), 4);
  assert.equal(targetMonths("a-lot"), 12);
  const little = recommend({
    monthlyRentUsd: 2000,
    worry: "a-little",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 18,
    series: [series()],
  })!;
  assert.ok(Math.abs(little.monthsCovered - 4) < 0.01);
});

test("suggestion clamps to unsold capacity", () => {
  const tiny = series({ escrow: 10n ** 16n, sold: 0n }); // 0.01 units
  const rec = recommend({
    monthlyRentUsd: 2000,
    worry: "a-lot",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 18,
    series: [tiny],
  });
  assert.ok(rec);
  assert.equal(rec.capacityLimited, true);
  assert.equal(rec.suggestedClaimWei, 10n ** 16n);
  assert.ok(rec.monthsCovered < 1);
});

test("returns null when nothing is open for sale", () => {
  assert.equal(
    recommend({
      monthlyRentUsd: 2000,
      worry: "a-lot",
      horizon: "this-window",
      nowSec: NOW,
      currencyDecimals: 18,
      series: [series({ settled: true }), series({ id: 1, paused: true })],
    }),
    null,
  );
  assert.equal(
    recommend({
      monthlyRentUsd: 2000,
      worry: "a-lot",
      horizon: "this-window",
      nowSec: NOW,
      currencyDecimals: 18,
      series: [],
    }),
    null,
  );
});

test("6-decimal chains (Arbitrum USDC) size correctly", () => {
  const rec = recommend({
    monthlyRentUsd: 3200,
    worry: "a-little",
    horizon: "this-window",
    nowSec: NOW,
    currencyDecimals: 6,
    series: [series({ escrow: 10n ** 12n, sold: 0n })], // 1,000,000 USDC
  })!;
  // rise ≈ 9.09% → monthly increase ≈ $290.91 → 4 months ≈ $1163.64
  const usd = weiToUsd(rec.suggestedClaimWei, 6);
  assert.ok(Math.abs(usd - 1163.64) < 0.01, `got ${usd}`);
});
