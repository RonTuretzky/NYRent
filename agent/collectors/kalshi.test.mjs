/**
 * Parser unit tests for kalshi.mjs against REAL captured API responses in
 * agent/fixtures/ (see fixtures/CAPTURE.md). Run: node --test agent/collectors/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { marketsToSignals, filterNycRentSeries, pickVacancyMarket, DEFAULT_SERIES } from "./kalshi.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readJson = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

test("marketsToSignals: KXMANOFFVAC (Manhattan office vacancy, C&W-settled)", () => {
  const signals = marketsToSignals("KXMANOFFVAC", readJson("kalshi-markets-KXMANOFFVAC.json"));
  assert.equal(signals.length, 1);
  const s = signals[0];
  assert.equal(s.source, "kalshi");
  assert.equal(s.kind, "kalshi_yes_price");
  assert.equal(s.value, 0.52); // last_price_dollars "0.5200" at capture
  assert.ok(s.detail.includes("KXMANOFFVAC-27JAN31-T18.0"), s.detail);
  assert.ok(s.detail.includes("Manhattan"), s.detail);
  assert.ok(s.detail.includes("status=active"), s.detail);
  assert.equal(s.asOf, "2026-08-18T18:00:01.813986Z"); // market updated_time
  assert.equal(s.url, "https://kalshi.com/markets/kxmanoffvac");
});

test("marketsToSignals: KXNYCRENTSY ladder (8 strikes)", () => {
  const signals = marketsToSignals("KXNYCRENTSY", readJson("kalshi-markets-KXNYCRENTSY.json"));
  assert.equal(signals.length, 8);
  const t6 = signals.find((s) => s.detail.includes("KXNYCRENTSY-26-T6"));
  assert.ok(t6, "T6 strike present");
  assert.equal(t6.value, 0.74);
  for (const s of signals) {
    assert.equal(s.kind, "kalshi_yes_price");
    assert.ok(s.value >= 0 && s.value <= 1, `price in [0,1]: ${s.value}`);
  }
});

test("marketsToSignals: finalized KXMANHATTANRENT markets keep status/result in detail", () => {
  const signals = marketsToSignals("KXMANHATTANRENT", readJson("kalshi-markets-KXMANHATTANRENT.json"));
  assert.equal(signals.length, 11);
  assert.ok(signals.every((s) => s.detail.includes("status=finalized")));
  assert.ok(signals.some((s) => s.detail.includes("result=")), "settled markets expose result");
});

test("marketsToSignals: signals carry structured market metadata for selection", () => {
  const signals = marketsToSignals("KXMANOFFVAC", readJson("kalshi-markets-KXMANOFFVAC.json"));
  const m = signals[0].market;
  assert.equal(m.ticker, "KXMANOFFVAC-27JAN31-T18.0");
  assert.equal(m.status, "active");
  assert.equal(m.openInterest, 500);
  assert.equal(m.volume, 775);
  assert.equal(m.expirationTime, "2027-02-07T15:00:00Z");
});

test("pickVacancyMarket: active + nonzero-OI + nearest-expiry wins; junk markets are ignored", () => {
  const mk = (ticker, status, expirationTime, openInterest, value) => ({
    kind: "kalshi_yes_price",
    value,
    detail: ticker,
    asOf: expirationTime,
    market: { ticker, status, expirationTime, openInterest, volume: 0 },
  });
  const signals = [
    mk("KXMANOFFVAC-26DEC31-T20.0", "finalized", "2026-12-31T15:00:00Z", 900, 0), // closed — last price meaningless
    mk("KXMANOFFVAC-28JAN31-T18.0", "active", "2028-02-07T15:00:00Z", 50, 0.61), // active but farther expiry
    mk("KXMANOFFVAC-27JAN31-T16.0", "active", "2027-02-07T15:00:00Z", 0, 0.1), // zero open interest
    mk("KXMANOFFVAC-27JAN31-T18.0", "active", "2027-02-07T15:00:00Z", 500, 0.52), // the one
    mk("KXNYCRENTSY-26-T6", "active", "2026-12-31T15:00:00Z", 100, 0.74), // wrong series
  ];
  const picked = pickVacancyMarket(signals);
  assert.equal(picked.market.ticker, "KXMANOFFVAC-27JAN31-T18.0");
  assert.equal(picked.value, 0.52);
  // no eligible market -> null (signal absent), never first-in-API-order junk
  assert.equal(pickVacancyMarket([signals[0], signals[2], signals[4]]), null);
  assert.equal(pickVacancyMarket([]), null);
  // real fixture: the single active market is picked
  const fixture = marketsToSignals("KXMANOFFVAC", readJson("kalshi-markets-KXMANOFFVAC.json"));
  assert.equal(pickVacancyMarket(fixture).value, 0.52);
});

test("filterNycRentSeries: finds the NYC rent/office series in the real Economics listing", () => {
  const tickers = filterNycRentSeries(readJson("kalshi-series-economics.json"));
  for (const core of DEFAULT_SERIES) {
    assert.ok(tickers.includes(core), `core series ${core} discovered`);
  }
  assert.ok(tickers.includes("KXNYCRENTSM"), "monthly NYC rent series discovered too");
  assert.ok(!tickers.includes("KXMEDIANRENTMIA"), "Miami rent excluded");
  assert.ok(!tickers.includes("KXSFRENTSY"), "SF rent excluded");
  assert.ok(!tickers.includes("KXAAAGASDNY"), "NY gas prices excluded");
});
