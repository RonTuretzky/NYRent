import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";
import {
  CREATOR_STEPS,
  POLICY_ERROR_COPY,
  RECORDER_STEPS,
  RENTER_STEPS,
  WAD,
  WEEK,
  alertRecipe,
  clearPendingTx,
  defaultMonth,
  loadPendingTx,
  monthOptions,
  policiesFor,
  premiumProblem,
  recorderStep,
  renterStep,
  savePendingTx,
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
  V1_RULES,
  V2_RULES,
  finalizeAtFor,
  policyLabel,
  policyPath,
  renterSteps,
  saleCloseOptions,
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

test("key dates are ordered and explained; the record window is a range", () => {
  const dates = policyDates(base);
  assert.deepEqual(dates.map((d) => d.label), ["Sales close", "Record window", "Claims open", "Claims close"]);
  assert.equal(dates[1].from, NOV_START);
  assert.equal(dates[1].at, FINALIZE);
  assert.equal(dates[0].from, undefined);
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
  const abi = ["../chain/apartmentsAbi.ts", "../chain/apartmentsV2Abi.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
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

test("month options default to the first month with a week of sales left and warn on short ones", () => {
  const nov30 = NOV_START + 29n * 86400n; // Nov 30: December starts tomorrow
  const options = monthOptions(nov30, 3);
  assert.deepEqual(options.map((o) => o.value), ["2026-12", "2027-01", "2027-02"]);
  assert.equal(options[0].salesLeft, 86400n);
  assert.ok(options[1].salesLeft >= WEEK);
  assert.equal(defaultMonth(options), "2027-01");
  assert.equal(defaultMonth(monthOptions(NOV_START + 86400n, 3)), "2026-12");
  // Dropdown and dates can never disagree: every option's start is after `now`.
  for (const o of options) assert.ok(o.start > nov30);
});

test("premium that rounds to zero is refused; 0% is allowed", () => {
  assert.equal(premiumProblem(100_000000n, 1000), null);
  assert.match(premiumProblem(100n, 1) ?? "", /rounds to zero/);
  assert.equal(premiumProblem(100n, 0), null);
});

test("pending transactions round-trip through storage and reject garbage", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const tx = { hash: `0x${"ab".repeat(32)}` as const, label: "Buy protection", chainId: 42161, at: 1 };
  savePendingTx(storage, "buy:0", tx);
  assert.deepEqual(loadPendingTx(storage, "buy:0"), tx);
  assert.equal(loadPendingTx(storage, "buy:1"), null);
  storage.setItem("rentsafe.policies.pending:buy:2", "{\"hash\":\"0x12\"}");
  assert.equal(loadPendingTx(storage, "buy:2"), null);
  storage.setItem("rentsafe.policies.pending:buy:3", "not json");
  assert.equal(loadPendingTx(storage, "buy:3"), null);
  clearPendingTx(storage, "buy:0");
  assert.equal(loadPendingTx(storage, "buy:0"), null);
});

test("policiesFor matches page hash and month only", () => {
  const slugHash = "0x" + "11".repeat(32) as `0x${string}`;
  const refs = [
    { id: 0n, slugHash: "0x4f5e3a5c7f3f7d3b5b6c2a9e0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c" as `0x${string}`, obsMonth: 202611 },
    { id: 1n, slugHash, obsMonth: 202611 },
  ];
  assert.deepEqual(policiesFor({ slug: "nowhere", yyyymm: 202611 }, refs), []);
  // keccak of the slug has to match.
  const eh = { id: 7n, slugHash: keccak256(toBytes("east-harlem-new-york-ny")), obsMonth: 202612 };
  assert.deepEqual(policiesFor({ slug: "east-harlem-new-york-ny", yyyymm: 202612 }, [...refs, eh]), [eh]);
  assert.deepEqual(policiesFor({ slug: "east-harlem-new-york-ny", yyyymm: 202611 }, [...refs, eh]), []);
});

test("renter step follows what the visitor can do now", () => {
  const b = { phase: "onSale" as const, held: 0n, claimWindow: false, fundsStage: "ready" as const, amountValid: true, justBought: false, justClaimed: false };
  assert.equal(renterStep(b).current, 4);
  assert.equal(renterStep({ ...b, fundsStage: "approve" }).current, 4);
  assert.equal(renterStep({ ...b, fundsStage: "connect" }).current, 3);
  assert.equal(renterStep({ ...b, fundsStage: "network" }).current, 3);
  assert.equal(renterStep({ ...b, fundsStage: "noFunds" }).current, 2);
  assert.equal(renterStep({ ...b, fundsStage: "noGas" }).current, 2);
  assert.equal(renterStep({ ...b, amountValid: false }).current, 1);
  assert.equal(renterStep({ ...b, justBought: true }).current, 5);
  assert.equal(renterStep({ ...b, held: 1n }).current, 5);
  assert.equal(renterStep({ ...b, held: 1n, phase: "readyToFinalize", claimWindow: true }).current, 6);
  assert.equal(renterStep({ ...b, held: 1n, phase: "settled", claimWindow: true }).current, 6);
  assert.match(renterStep({ ...b, held: 1n, phase: "claimsClosed" }).terminal ?? "", /closed/);
  assert.match(renterStep({ ...b, held: 1n, phase: "void", claimWindow: false }).terminal ?? "", /claim window closed/);
  assert.match(renterStep({ ...b, held: 1n, phase: "settled", claimWindow: false }).terminal ?? "", /claim window closed/);
  assert.equal(renterStep({ ...b, held: 1n, phase: "void", claimWindow: true }).terminal, undefined);
  assert.match(renterStep({ ...b, justClaimed: true }).done ?? "", /claimed/);
  assert.match(renterStep({ ...b, phase: "settled" }).terminal ?? "", /holds no protection/);
  assert.match(renterStep({ ...b, phase: "void" }).terminal ?? "", /holds no protection/);
  assert.match(renterStep({ ...b, phase: "soldOut" }).terminal ?? "", /Sold out/);
  assert.match(renterStep({ ...b, phase: "cancelled" }).terminal ?? "", /cancelled/);
});

test("recorder step starts at 1 and only advances when done", () => {
  assert.equal(recorderStep({ hasFile: false, parseFailed: false, qualifying: false, consent: false, confirmed: false }).current, 1);
  assert.equal(recorderStep({ hasFile: true, parseFailed: true, qualifying: false, consent: false, confirmed: false }).current, 2);
  assert.equal(recorderStep({ hasFile: true, parseFailed: false, qualifying: false, consent: false, confirmed: false }).current, 2);
  assert.equal(recorderStep({ hasFile: true, parseFailed: false, qualifying: true, consent: false, confirmed: false }).current, 3);
  assert.equal(recorderStep({ hasFile: true, parseFailed: false, qualifying: true, consent: true, confirmed: false }).current, 4);
  const done = recorderStep({ hasFile: true, parseFailed: false, qualifying: true, consent: true, confirmed: true });
  assert.equal(done.current, 5);
  assert.ok(done.done);
});

// ─────────────────────────────────────────────────────────────── two pools

const DAY = 86400n;
const DEC_START = NOV_END + 1n;
const DEC_END = 1798761599n; // 2026-12-31T23:59:59Z

test("pool rules: V1 keeps seven days of grace, V2 two", () => {
  assert.equal(finalizeAtFor(202611, V1_RULES), FINALIZE);
  assert.equal(finalizeAtFor(202611, V2_RULES), NOV_END + 1n + 2n * DAY);
  assert.equal(policyPath("v2", 12n), "/policies/12");
  assert.equal(policyPath("v1", 0n), "/policies/v1/0");
  assert.equal(policyLabel("v1", 0n), "V1 #0");
  assert.equal(policyLabel("v2", 3), "#3");
  assert.match(renterSteps(V1_RULES)[4].detail, /when the month starts/);
  assert.match(renterSteps(V1_RULES)[5].detail, /seven days/);
  assert.match(renterSteps(V2_RULES)[4].detail, /creator chose/);
  assert.match(renterSteps(V2_RULES)[5].detail, /two days/);
});

test("V2 status: sales into the month, stopped by a recorded rent", () => {
  const v2: PolicyRow = { ...base, saleEnd: NOV_START + 3n * DAY, finalizeAt: finalizeAtFor(202611, V2_RULES), redeemEnd: finalizeAtFor(202611, V2_RULES) + 30n * DAY };
  const opts = { rules: V2_RULES };
  const mid = NOV_START + DAY;
  assert.equal(policyStatus(v2, mid, false, opts).phase, "onSale");
  assert.match(policyStatus(v2, mid, false, opts).next, /creator chose/);
  const stopped = policyStatus(v2, mid, false, { ...opts, recorded: true });
  assert.equal(stopped.phase, "awaitingData");
  assert.equal(stopped.label, "Rent recorded");
  assert.match(stopped.next, /already recorded, so sales are closed/);
  assert.match(stopped.next, /two days/);
  // V1 never stops on a record; its copy keeps the earlier rules.
  assert.equal(policyStatus(base, NOV_START - 1n, false, { rules: V1_RULES, recorded: true }).phase, "onSale");
  assert.match(policyStatus(base, NOV_START, false, { rules: V1_RULES }).next, /seven days/);
  assert.match(policyStatus(base, NOV_START - 1n, false, { rules: V1_RULES }).next, /until the policy month starts/);
});

test("V2 key dates name the creator's close, the record stop and the two-day grace", () => {
  const terms = { saleEnd: DEC_START + 3n * DAY, finalizeAt: finalizeAtFor(202612, V2_RULES), redeemEnd: finalizeAtFor(202612, V2_RULES) + 30n * DAY, obsMonth: 202612 };
  const dates = policyDates(terms, V2_RULES);
  assert.match(dates[0].note, /chosen by the creator/);
  assert.match(dates[0].note, /stop as soon as the month's rent is recorded/);
  assert.match(dates[2].note, /^Two days after the month ends/);
  assert.equal(dates[2].at, DEC_END + 1n + 2n * DAY);
  assert.match(policyDates(base, V1_RULES)[0].note, /policy month starts right after/);
});

test("the current month is offered until its last day starts, and never by default", () => {
  const nov10 = NOV_START + 9n * DAY;
  const opts = monthOptions(nov10, 3, { includeCurrent: true });
  assert.deepEqual(opts.map((o) => o.value), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.equal(opts[0].current, true);
  assert.equal(opts[0].end, NOV_END);
  assert.equal(defaultMonth(opts), "2026-12");
  // From the first second of November 30 the current month is gone.
  assert.equal(monthOptions(NOV_END + 1n - DAY, 3, { includeCurrent: true })[0].value, "2026-12");
  assert.equal(monthOptions(NOV_END - DAY, 3, { includeCurrent: true })[0].value, "2026-11");
  // V1-style lists never include it.
  assert.equal(monthOptions(nov10, 3)[0].value, "2026-12");
});

test("sale-close options: future month starts at the month start, all within the month", () => {
  const nov10 = NOV_START + 9n * DAY;
  const { options, defaultId } = saleCloseOptions(202612, nov10);
  assert.deepEqual(options.map((o) => o.id), ["start", "1d", "3d", "7d", "end"]);
  assert.equal(defaultId, "start");
  assert.deepEqual(options.map((o) => o.at), [DEC_START, DEC_START + DAY, DEC_START + 3n * DAY, DEC_START + 7n * DAY, DEC_END]);
});

test("sale-close options: current month counts from now, capped at month end, never past it", () => {
  const nov10 = NOV_START + 9n * DAY;
  const early = saleCloseOptions(202611, nov10);
  assert.deepEqual(early.options.map((o) => o.id), ["1d", "3d", "7d", "end"]);
  assert.equal(early.defaultId, "3d");
  assert.equal(early.options[1].at, nov10 + 3n * DAY);
  // Two and a half days before the end: 3 and 7 days would overshoot, so only 1 day and month end remain.
  const late = NOV_END - (5n * DAY) / 2n;
  const near = saleCloseOptions(202611, late);
  assert.deepEqual(near.options.map((o) => o.id), ["1d", "end"]);
  assert.equal(near.defaultId, "end");
  // Every option, at any moment of the month, is strictly after now and at most month end.
  for (let t = NOV_START; t < NOV_END; t += 7n * 3600n) {
    for (const o of saleCloseOptions(202611, t).options) {
      assert.ok(o.at > t, `${o.id} at ${t}`);
      assert.ok(o.at <= NOV_END, `${o.id} past month end at ${t}`);
    }
  }
  assert.deepEqual(saleCloseOptions(202611, NOV_END).options, []);
});

test("RentAlreadyRecorded has the agreed copy", () => {
  assert.equal(POLICY_ERROR_COPY.RentAlreadyRecorded, "This month's rent is already recorded, so sales are closed.");
  assert.equal(policyError({ name: "RentAlreadyRecorded", kind: "revert", message: "x" }).message, POLICY_ERROR_COPY.RentAlreadyRecorded);
});
