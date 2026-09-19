/**
 * Parser unit tests for reports.mjs against REAL captured responses in
 * agent/fixtures/ (see fixtures/CAPTURE.md). Run: node --test agent/collectors/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCushman,
  findQuarter,
  quarterEndIso,
  parseRssItems,
  scoreHeadline,
  feedToSignals,
  parseBls,
} from "./reports.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

// --- Cushman & Wakefield Manhattan Office MarketBeat ---

test("parseCushman: Q2 2026 vacancy 19.3% and overall asking rent $72.83/SF", () => {
  const r = parseCushman(read("cushman-manhattan-office.html"));
  assert.equal(r.quarter, "Q2 2026");
  assert.equal(r.vacancyPct, 19.3); // "overall vacancy rate declined by 60 bps ... to 19.3%"
  assert.equal(r.askingRentCents, 7283); // "asking rents dipped by $0.29 to $72.83 per square foot"
});

test("quarterEndIso maps quarters to their reference end date", () => {
  assert.equal(quarterEndIso("Q2 2026"), "2026-06-30T00:00:00Z");
  assert.equal(quarterEndIso("Q4 2026"), "2026-12-31T00:00:00Z");
  assert.equal(quarterEndIso(""), "");
});

test("findQuarter skips 'Q3 2021'-style back-references only after the first mention", () => {
  assert.equal(findQuarter("covering market conditions in Q2 2026 and Q3 2021"), "Q2 2026");
  assert.equal(findQuarter("no quarter here"), "");
});

// --- RSS feeds ---

test("parseRssItems: Commercial Observer feed has 17 items with title/link/pubDate", () => {
  const items = parseRssItems(read("commercialobserver-feed.xml"));
  assert.equal(items.length, 17);
  assert.equal(items[0].title, "Asian-American Deli Café Hestia Signs 8K-SF Lease at 570 Lexington Avenue");
  for (const it of items) {
    assert.ok(it.link.startsWith("http"), it.link);
    assert.ok(!Number.isNaN(new Date(it.pubDate).getTime()), it.pubDate);
    assert.ok(!it.title.includes("CDATA"), "CDATA wrappers stripped");
  }
});

test("parseRssItems: The Real Deal NY feed has 10 items", () => {
  const items = parseRssItems(read("therealdeal-new-york-feed.xml"));
  assert.equal(items.length, 10);
  assert.equal(items[0].title, "Council tees up expansion to rent protection program");
});

test("scoreHeadline counts office-market keywords", () => {
  assert.equal(scoreHeadline("Massive Office Lease: Landlord Wins"), 3); // office, lease, landlord
  assert.equal(scoreHeadline("Weather tomorrow"), 0);
});

test("feedToSignals: CO fixture yields 4 matched headlines + rollup count", () => {
  const { signals, itemCount } = feedToSignals("commercialobserver", read("commercialobserver-feed.xml"), "feed-url");
  assert.equal(itemCount, 17);
  const rollup = signals.find((s) => s.kind === "nyc_office_headline_count");
  const headlines = signals.filter((s) => s.kind === "news_headline");
  assert.equal(headlines.length, 4);
  assert.equal(rollup.value, 4);
  assert.equal(rollup.url, "feed-url");
  for (const h of headlines) {
    assert.ok(h.value >= 1);
    assert.ok(h.asOf.startsWith("2026-09-18"), h.asOf);
  }
});

test("feedToSignals: TRD fixture matches the rent-protection headline", () => {
  const { signals } = feedToSignals("therealdeal", read("therealdeal-new-york-feed.xml"), "feed-url");
  const headlines = signals.filter((s) => s.kind === "news_headline");
  assert.equal(headlines.length, 1);
  assert.ok(headlines[0].detail.includes("rent protection"), headlines[0].detail);
});

// --- BLS ---

test("parseBls: latest NYC rent CPI datum and YoY from the real payload", () => {
  const p = parseBls(JSON.parse(read("bls-CUURS12ASEHA.json")));
  assert.equal(p.latestValue, 509.228); // August 2026
  assert.equal(p.latest.year, "2026");
  assert.equal(p.latest.period, "M08");
  assert.ok(Math.abs(p.yoyPct - 4.025) < 0.01, `yoy ~= 4.03, got ${p.yoyPct}`);
});

test("parseBls: rejects non-success payloads", () => {
  assert.equal(parseBls({ status: "REQUEST_NOT_PROCESSED" }), null);
  assert.equal(parseBls(undefined), null);
});
