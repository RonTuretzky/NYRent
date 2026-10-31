import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractAlertResults, monthBounds, payoutFraction, policyTerms, publishedRecipient } from "./googleAlert.ts";

const fixture = (name: string, file: string) =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/google-alert-synthetic/${name}/${file}`, import.meta.url)));
const T = 1793620800;

test("reads the same values as the contract", () => {
  assert.deepEqual(extractAlertResults(fixture("ok-single", "canon-body.bin"), T), [
    { slug: "east-harlem-new-york-ny", yyyymm: 202611, cents: 301000 },
  ]);
  assert.equal(extractAlertResults(fixture("ok-multi", "canon-body.bin"), T).length, 2);
});

test("ignores injected queries and bad templates", () => {
  assert.equal(extractAlertResults(fixture("ok-query-injection", "canon-body.bin"), T)[0].cents, 301000);
  for (const name of ["bad-wrong-host", "bad-joined-widgets", "bad-name-mismatch", "bad-month-mismatch"]) {
    assert.deepEqual(extractAlertResults(fixture(name, "canon-body.bin"), T), [], name);
  }
});

test("rejects a signature outside the named month", () => {
  assert.deepEqual(extractAlertResults(fixture("ok-single", "canon-body.bin"), monthBounds(202610).end), []);
});

test("surfaces the recipient that will be published", () => {
  assert.equal(publishedRecipient(fixture("ok-single", "signed-headers.bin")), "synthetic@example.com");
});

test("derives contract terms", () => {
  const terms = policyTerms({ slug: "east-harlem-new-york-ny", month: "2026-12", lowDollars: 3000, highDollars: 3200, premiumPercent: 12.5 }, T);
  assert.ok(typeof terms !== "string");
  assert.equal(terms.obsMonth, 202612);
  assert.equal(terms.strikeLowCents, 300000);
  assert.equal(terms.premiumRateBps, 1250);
  assert.equal(terms.saleEnd, 1796083200n);
  assert.equal(terms.finalizeAt, 1798761600n + 7n * 86400n);
});

test("refuses months that already started and inverted strikes", () => {
  const base = { slug: "a-b", month: "2026-11", lowDollars: 1, highDollars: 2, premiumPercent: 1 };
  assert.equal(typeof policyTerms(base, T), "string");
  assert.equal(typeof policyTerms({ ...base, month: "2026-12", highDollars: 1 }, T), "string");
});

test("payout is linear between the strikes", () => {
  assert.equal(payoutFraction(100, 100, 200), 0);
  assert.equal(payoutFraction(150, 100, 200), 0.5);
  assert.equal(payoutFraction(250, 100, 200), 1);
});
