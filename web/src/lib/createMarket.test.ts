import test from "node:test";
import assert from "node:assert/strict";
import { creationTerms } from "./createMarket.ts";
const valid = { low: "95.67", high: "100.32", saleEnd: "2027-08-30", obsStart: "2027-09-01", obsEnd: "2027-10-01", redeemEnd: "2027-10-08" };
test("exact cents and UTC boundaries", () => {
  const t = creationTerms(valid, 0n, 9288, 0);
  assert.equal(t.strikeLowCents, 9567);
  assert.equal(t.redeemEnd - t.obsEnd, 604800n);
});
test("reject invalid economic terms and stale dates", () => {
  for (const patch of [{ low: "1e2" }, { low: "0" }, { high: "95" }, { high: "42949673" }, { obsStart: valid.saleEnd }, { redeemEnd: "2027-10-07" }, { saleEnd: "" }]) {
    assert.throws(() => creationTerms({ ...valid, ...patch }, 0n, 9288, 0));
  }
  assert.throws(() => creationTerms(valid, 0n, 9288, 2000000000));
});
