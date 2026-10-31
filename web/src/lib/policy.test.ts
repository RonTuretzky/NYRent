import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CREATOR_STEPS,
  POLICY_ERROR_COPY,
  RECORDER_STEPS,
  RENTER_STEPS,
  WAD,
  alertRecipe,
  buyExample,
  creatorExample,
  fileProblem,
  humanDelta,
  parseAmount,
  parsePolicyId,
  parsePremiumPercent,
  parseRentDollars,
  payoutRatioWad,
  policyDates,
  policyError,
  policyStatus,
  ratioPercent,
  type PolicyRow,
} from "./policy.ts";

const NOV_START = 1793491200n;
const NOV_END = 1796083199n;
const FINALIZE = NOV_END + 1n + 7n * 86400n;
const REDEEM_END = FINALIZE + 30n * 86400n;

const base: PolicyRow = {
  creator: "0x1000000000000000000000000000000000000c01",
  strikeLowCents: 300000,
  strikeHighCents: 320000,
  premiumRateBps: 1000,
  obsMonth: 202611,
  settled: false,
  voided: false,
  cancelled: false,
  residualWithdrawn: false,
  saleEnd: NOV_START,
  finalizeAt: FINALIZE,
  redeemEnd: REDEEM_END,
  payoutRatioWad: 0n,
  observationT: 0n,
  escrow: 100_000000n,
  sold: 0n,
  premiumsAccrued: 0n,
  paidOut: 0n,
  slugHash: "0x00",
  emailId: "0x00",
};

test("status follows the contract lifecycle in order", () => {
  assert.equal(policyStatus(base, NOV_START - 1n).phase, "onSale");
  assert.equal(policyStatus(base, NOV_START - 1n, true).phase, "paused");
  assert.equal(policyStatus({ ...base, sold: base.escrow }, NOV_START - 1n).phase, "soldOut");
  assert.equal(policyStatus(base, NOV_START).phase, "awaitingData");
  assert.equal(policyStatus(base, FINALIZE).phase, "readyToFinalize");
  assert.equal(policyStatus(base, REDEEM_END + 1n).phase, "claimsClosed");
  assert.equal(policyStatus({ ...base, voided: true }, FINALIZE).phase, "void");
  assert.equal(policyStatus({ ...base, settled: true, payoutRatioWad: WAD / 2n }, FINALIZE).phase, "settled");
  assert.match(policyStatus({ ...base, settled: true, payoutRatioWad: WAD / 2n }, FINALIZE).next, /50%/);
  assert.match(policyStatus({ ...base, settled: true }, FINALIZE).next, /\$0/);
  assert.equal(policyStatus({ ...base, cancelled: true }, 0n).phase, "cancelled");
  for (const now of [0n, FINALIZE, REDEEM_END + 1n]) assert.ok(policyStatus(base, now).next.length > 20);
});

test("human deltas", () => {
  assert.equal(humanDelta(30n, 0n), "in under a minute");
  assert.equal(humanDelta(0n, 30n), "just now");
  assert.equal(humanDelta(3600n, 0n), "in 1 hour");
  assert.equal(humanDelta(5n * 86400n, 0n), "in 5 days");
  assert.equal(humanDelta(0n, 3n * 86400n), "3 days ago");
  assert.equal(humanDelta(120n, 0n), "in 2 minutes");
});

test("key dates are ordered and explained", () => {
  const dates = policyDates(base);
  assert.deepEqual(dates.map((d) => d.label), ["Sales close", "Record window", "Claims open", "Claims close"]);
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i].at >= dates[i - 1].at);
  for (const d of dates) assert.ok(d.note.length > 10);
});

test("worked buy example matches the contract arithmetic", () => {
  const ex = buyExample(20_000000n, 1000, 300000, 320000);
  assert.equal(ex.premium, 2_000000n);
  assert.equal(ex.midCents, 310000);
  assert.equal(ex.midPayout, 10_000000n);
  assert.equal(payoutRatioWad(299999, 300000, 320000), 0n);
  assert.equal(payoutRatioWad(300000, 300000, 320000), 0n);
  assert.equal(payoutRatioWad(320000, 300000, 320000), WAD);
  assert.equal(payoutRatioWad(305000, 300000, 320000), WAD / 4n);
  assert.equal(ratioPercent(WAD / 4n), 25);
});

test("creator best and worst case", () => {
  const ex = creatorExample(100_000000n, 1000);
  assert.equal(ex.bestCase, 10_000000n);
  assert.equal(ex.worstCase, -90_000000n);
});

test("amount parsing rejects every malformed input with a reason", () => {
  assert.deepEqual(parseAmount("25", 6), { ok: true, value: 25_000000n });
  assert.deepEqual(parseAmount("12.50", 6), { ok: true, value: 12_500000n });
  assert.deepEqual(parseAmount("1,000", 6), { ok: true, value: 1000_000000n });
  assert.deepEqual(parseAmount("0.000001", 6), { ok: true, value: 1n });
  for (const bad of ["", " ", ".", "abc", "1e3", "-5", "1.2.3", "$5", "0", "0.0", "0.0000001", "1.1234567"]) {
    const r = parseAmount(bad, 6);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.ok(r.error.length > 5, bad);
  }
  const r = parseAmount("1.1234567", 6);
  if (!r.ok) assert.match(r.error, /6 decimal/);
  assert.equal(parseAmount("999999999999999999999999999999999999999", 6).ok, false);
});

test("rent and premium parsing", () => {
  assert.deepEqual(parseRentDollars("3,100"), { ok: true, value: 310000 });
  assert.deepEqual(parseRentDollars("$3100.50"), { ok: true, value: 310050 });
  for (const bad of ["", "abc", "-3", "3100.555", "0"]) assert.equal(parseRentDollars(bad).ok, false, bad);
  assert.deepEqual(parsePremiumPercent("7.5"), { ok: true, value: 750 });
  assert.deepEqual(parsePremiumPercent("0"), { ok: true, value: 0 });
  assert.deepEqual(parsePremiumPercent("100%"), { ok: true, value: 10000 });
  for (const bad of ["", "abc", "101", "-1", "1.234"]) assert.equal(parsePremiumPercent(bad).ok, false, bad);
});

test("policy ids never throw", () => {
  assert.equal(parsePolicyId("0"), 0n);
  assert.equal(parsePolicyId("17"), 17n);
  for (const bad of [undefined, "", "abc", "1.5", "-1", "0x10", "1e3", " 1", "99999999999999999999999"]) {
    assert.equal(parsePolicyId(bad), null, String(bad));
  }
});

test("upload checks", () => {
  assert.equal(fileProblem({ name: "alert.eml", size: 40_000, type: "" }), null);
  assert.equal(fileProblem({ name: "weird", size: 40_000, type: "message/rfc822" }), null);
  assert.match(fileProblem({ name: "notes.txt", size: 10, type: "text/plain" }) ?? "", /not an email file/);
  assert.match(fileProblem({ name: "scan.pdf", size: 10, type: "application/pdf" }) ?? "", /Download message/);
  assert.match(fileProblem({ name: "alert.eml", size: 0, type: "" }) ?? "", /empty/);
  assert.match(fileProblem({ name: "alert.eml", size: 3 * 1024 * 1024, type: "" }) ?? "", /3\.0 MB/);
});

test("alert recipe uses the exact page and as-it-happens delivery", () => {
  const r = alertRecipe("east-harlem-new-york-ny");
  assert.equal(r.query, "https://www.apartments.com/rent-market-trends/east-harlem-new-york-ny/");
  assert.equal(r.howOften, "As-it-happens");
  assert.equal(r.howMany, "All results");
});

test("every custom error in the deployed ABIs has policy copy", () => {
  const abi = readFileSync(new URL("../chain/apartmentsAbi.ts", import.meta.url), "utf8");
  const names = new Set([...abi.matchAll(/"type":\s*"error",\s*"name":\s*"(\w+)"/g)].map((m) => m[1]));
  assert.ok(names.size >= 30);
  for (const name of names) assert.ok(POLICY_ERROR_COPY[name], `missing copy for ${name}`);
  for (const copy of Object.values(POLICY_ERROR_COPY)) assert.doesNotMatch(copy, /0x[0-9a-f]{8}/i);
});

test("policyError rewrites wallet, network, gas and allowance failures", () => {
  assert.match(policyError({ name: "UserRejected", kind: "rejected", message: "x" }).message, /nothing was charged/);
  assert.match(policyError({ name: "Network", kind: "network", message: "x" }).message, /could not be reached/);
  const gas = policyError({ name: "Error", kind: "unknown", message: "insufficient funds for gas * price + value" });
  assert.equal(gas.name, "NoGas");
  assert.match(gas.message, /ETH/);
  assert.match(policyError({ name: "Error", kind: "unknown", message: "x", detail: "ERC20: transfer amount exceeds allowance" }).message, /Approve again/);
  assert.equal(policyError({ name: "SaleClosed", kind: "revert", message: "legacy" }).message, POLICY_ERROR_COPY.SaleClosed);
  const untouched = { name: "Mystery", kind: "unknown" as const, message: "something else" };
  assert.deepEqual(policyError(untouched), untouched);
});

test("journeys have the required shape", () => {
  for (const steps of [RENTER_STEPS, CREATOR_STEPS, RECORDER_STEPS]) {
    assert.ok(steps.length >= 5);
    for (const s of steps) assert.ok(s.title && s.detail.length > 20);
  }
  assert.match(RECORDER_STEPS[0].detail, /As-it-happens/);
  assert.match(RECORDER_STEPS[1].detail, /Download message/);
});
