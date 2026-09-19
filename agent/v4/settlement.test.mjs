import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSettlementWindow, scanVerifiedEmails, splitObservationBody } from "./settlement.mjs";

test("large canonical bodies use the fewest 24k prefix chunks", () => {
  const body = new Uint8Array(102197);
  const split = splitObservationBody(body);
  assert.deepEqual(split.chunks.map((chunk) => chunk.length), [22197]);
  assert.equal(split.inlineTail.length, 80000);
  assert.equal(split.chunks[0].length + split.inlineTail.length, body.length);
});

test("settlement window structurally excludes trading on the known result", () => {
  assert.doesNotThrow(() => assertSettlementWindow({
    now: 200, saleEnd: 100, obsStart: 100, obsEnd: 300, tradingOpen: false, emailTimestamp: 150,
  }));
  assert.throws(() => assertSettlementWindow({
    now: 99, saleEnd: 100, obsStart: 100, obsEnd: 300, tradingOpen: true, emailTimestamp: 150,
  }), /Trading is still open/);
  assert.throws(() => assertSettlementWindow({
    now: 200, saleEnd: 201, obsStart: 200, obsEnd: 300, tradingOpen: false, emailTimestamp: 220,
  }), /Unsafe market terms/);
});

test("inbox scan verifies the authentic fixture", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const inbox = path.resolve(here, "../../fixtures/credaily-2026-09-17");
  const out = await scanVerifiedEmails(inbox);
  assert.equal(out.verified.length, 1);
  assert.equal(out.rejected.length, 0);
  assert.equal(out.verified[0].parsed.cents, 9288);
  assert.equal(out.verified[0].parsed.canonBody.length, 102197);
});
