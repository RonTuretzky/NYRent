/**
 * emailkit golden + tamper tests (SPEC §3, §7 "JS (node --test)").
 *
 * Run: cd web && npm test   (node --test src/lib/emailkit.test.ts)
 * Goldens: byte-identical output vs fixtures/credaily-2026-09-17/*.bin (VERIFIED ground truth).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseEml,
  preflight,
  extractSnapshot,
  modulusToSpki,
  base64Encode,
  base64Decode,
  binaryToBytes,
  bytesToBinary,
  PINNED_MODULUS_HEX,
  type PreflightReport,
} from "./emailkit.ts";

const FIX = new URL("../../../fixtures/credaily-2026-09-17/", import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, FIX)));

const rawEml = read("credaily-cpace-2026-09-17.eml");
const goldenSignedHeaders = read("signed-headers.bin");
const goldenCanonBody = read("canon-body.bin");
const goldenSig = read("sig.bin");
const meta = JSON.parse(readFileSync(new URL("meta.json", FIX), "utf8"));
const rawStr = bytesToBinary(rawEml); // latin1-safe string view for tampering

function tamper(from: string, to: string): Uint8Array {
  const idx = rawStr.indexOf(from);
  assert.notEqual(idx, -1, `tamper target not found: ${from.slice(0, 40)}`);
  assert.equal(rawStr.indexOf(from, idx + 1), -1, `tamper target not unique: ${from.slice(0, 40)}`);
  return binaryToBytes(rawStr.slice(0, idx) + to + rawStr.slice(idx + from.length));
}

function check(report: PreflightReport, id: string) {
  const c = report.checks.find((c) => c.id === id);
  assert.ok(c, `check ${id} missing from report`);
  return c!;
}

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

test("golden: signedHeaders / canonBody / sig byte-identical to fixtures", async () => {
  const p = await parseEml(rawEml);
  assert.deepEqual(p.signedHeaders, goldenSignedHeaders, "signed-headers.bin mismatch");
  assert.deepEqual(p.canonBody, goldenCanonBody, "canon-body.bin mismatch");
  assert.deepEqual(p.sig, goldenSig, "sig.bin mismatch");
  assert.equal(p.canonBody.length, meta.canon_body_len);
});

test("golden: extracted value 9288 cents, unique anchor at meta offset", async () => {
  const p = await parseEml(rawEml);
  assert.equal(p.cents, 9288);
  assert.equal((p.cents / 100).toFixed(2), meta.value);
  assert.equal(p.anchorCount, 1);
  assert.equal(p.anchorOffset, meta.anchor_offset);
  assert.equal(p.valuePreview, "Manhattan Office Rent > Avg Effective > $92.88 / SF");
});

test("golden: tags and computed bh match meta.json", async () => {
  const p = await parseEml(rawEml);
  assert.equal(p.tags.d, meta.d);
  assert.equal(p.tags.s, meta.s);
  assert.equal(p.tags.t, meta.t);
  assert.equal(p.tags.a, "rsa-sha256");
  assert.equal(p.tags.c, "relaxed/relaxed");
  assert.equal(p.tags.hasL, false);
  assert.equal(p.bh, meta.bh_b64);
  assert.equal(p.tags.bh, meta.bh_b64);
  assert.equal(p.emailId.length, 66);
});

test("golden: preflight all nine checks pass on the fixture", async () => {
  const rep = await preflight(rawEml);
  for (const c of rep.checks) assert.ok(c.pass, `${c.id} failed: ${c.detail}`);
  assert.equal(rep.checks.length, 9);
  assert.ok(rep.ok);
});

test("golden: LF-only line endings normalize to identical bytes", async () => {
  const lfOnly = binaryToBytes(rawStr.replace(/\r\n/g, "\n"));
  const p = await parseEml(lfOnly);
  assert.deepEqual(p.signedHeaders, goldenSignedHeaders);
  assert.deepEqual(p.canonBody, goldenCanonBody);
  assert.ok((await preflight(lfOnly)).ok);
});

test("golden: SPKI built from pinned modulus equals fixtures/dkim-public-key.pem", () => {
  const pem = readFileSync(new URL("dkim-public-key.pem", FIX), "utf8").replace(
    /-----[^-]+-----|\s/g,
    "",
  );
  assert.equal(base64Encode(modulusToSpki(PINNED_MODULUS_HEX)), pem);
});

test("base64 round-trips the signature", () => {
  assert.deepEqual(base64Decode(base64Encode(goldenSig)), goldenSig);
});

// ---------------------------------------------------------------------------
// Tampers — each must trip its PRECISE check
// ---------------------------------------------------------------------------

test("tamper: body byte flip -> bh-match FAILS, rsa-verify still passes", async () => {
  const rep = await preflight(tamper("$92.88 / SF", "$93.88 / SF"));
  assert.equal(rep.ok, false);
  assert.equal(check(rep, "bh-match").pass, false);
  assert.equal(check(rep, "rsa-verify").pass, true, "headers untouched: RSA must still verify");
  assert.equal(check(rep, "tag-policy").pass, true);
  // the tampered value still extracts (mirrors on-chain behavior: bh gate rejects first)
  assert.equal(rep.parsed!.cents, 9388);
});

test("tamper: signed header byte flip -> rsa-verify FAILS, bh-match still passes", async () => {
  const rep = await preflight(tamper("Subject: C-PACE", "Subject: X-PACE"));
  assert.equal(rep.ok, false);
  assert.equal(check(rep, "rsa-verify").pass, false);
  assert.equal(check(rep, "bh-match").pass, true, "body untouched: bh must still match");
});

test("tamper: signature b= flip -> rsa-verify FAILS, everything else passes", async () => {
  const rep = await preflight(
    tamper("Ozp3R0UUZ8L3dV6J8xCg", "Ozp3R0UUZ8L3dV6J8xCh"),
  );
  assert.equal(rep.ok, false);
  assert.equal(check(rep, "rsa-verify").pass, false);
  for (const id of ["bh-match", "tag-policy", "structure", "from-domain", "extraction"]) {
    assert.equal(check(rep, id).pass, true, `${id} should be unaffected by sig flip`);
  }
});

test("tamper: wrong d= -> dkim-found FAILS (selection is by d= tag)", async () => {
  const rep = await preflight(tamper("d=newyork.credaily.com;", "d=newyork.credaily.dev;"));
  assert.equal(rep.ok, false);
  assert.equal(check(rep, "dkim-found").pass, false);
  assert.equal(rep.parsed, null);
});

test("tamper: l= tag injected -> tag-policy FAILS naming l=", async () => {
  const rep = await preflight(tamper("s=b37; t=1789642464;", "s=b37; l=100; t=1789642464;"));
  assert.equal(rep.ok, false);
  const c = check(rep, "tag-policy");
  assert.equal(c.pass, false);
  assert.match(c.detail, /l= tag present/);
});

test("tamper: b= emptied in raw email -> rsa-verify FAILS (no signature left)", async () => {
  // the b= value spans folded lines: excise from "b=IILs…" through the final "…Bbww=="
  const start = rawStr.indexOf("b=IILsFZPGPrTOHllc"); // long needle: avoids "header.b=IILsFZPG" in Authentication-Results
  const endMark = "xoeWa0285xBbww==";
  const end = rawStr.indexOf(endMark) + endMark.length;
  assert.ok(start !== -1 && end > start);
  const rep = await preflight(binaryToBytes(rawStr.slice(0, start) + "b=" + rawStr.slice(end)));
  assert.equal(rep.ok, false);
  // Chain-exact semantics: the canonical block carries b= EMPTY by construction, so
  // the tag policy is satisfied — what an emptied raw b= actually removes is the
  // signature itself, and rsa-verify is the check that must fail.
  assert.equal(check(rep, "tag-policy").pass, true);
  assert.equal(check(rep, "rsa-verify").pass, false);
});

test("tamper: truncated body -> bh-match FAILS", async () => {
  const truncated = rawEml.subarray(0, rawEml.length - 1000);
  const rep = await preflight(truncated);
  assert.equal(rep.ok, false);
  assert.equal(check(rep, "bh-match").pass, false);
});

test("tamper: future t= -> timestamp FAILS (via opts.now)", async () => {
  const rep = await preflight(rawEml, { now: Number(meta.t) - 2 * 86400 });
  assert.equal(rep.ok, false);
  const c = check(rep, "timestamp");
  assert.equal(c.pass, false);
  assert.match(c.detail, /ahead of now/);
});

test("garbage input: preflight reports failure without throwing", async () => {
  const rep = await preflight(binaryToBytes("this is not an email at all\nnope"));
  assert.equal(rep.ok, false);
  assert.equal(rep.parsed, null);
  assert.equal(check(rep, "dkim-found").pass, false);
});

// ---------------------------------------------------------------------------
// extractSnapshot unit tests (on canonical-body bytes)
// ---------------------------------------------------------------------------

test("extract: second anchor appended -> anchorCount 2 (AnchorNotUnique mirror)", () => {
  const doctored = binaryToBytes(bytesToBinary(goldenCanonBody) + "Manhattan Office Rent\r\n");
  const ex = extractSnapshot(doctored);
  assert.equal(ex.anchorCount, 2);
});

test("extract: QP soft breaks and =HH decoding inside the window", () => {
  const body = binaryToBytes(
    "Manhattan Office Rent x Avg Effec=\r\ntive =24 92.88 / SF\r\n", // $ as =24, split token
  );
  const ex = extractSnapshot(body);
  assert.equal(ex.cents, 9288);
  assert.equal(ex.anchorCount, 1);
});

test("extract: missing '/ SF' unit -> cents 0 with reason", () => {
  const ex = extractSnapshot(
    binaryToBytes("Manhattan Office Rent Avg Effective $92.88 per sqft\r\n"),
  );
  assert.equal(ex.cents, 0);
  assert.match(ex.error, /\/ SF/);
});

test("extract: 'Avg Effective' beyond 600 decoded bytes -> fails window", () => {
  const ex = extractSnapshot(
    binaryToBytes("Manhattan Office Rent" + "x".repeat(601) + "Avg Effective $92.88 / SF\r\n"),
  );
  assert.equal(ex.cents, 0);
  assert.match(ex.error, /600/);
});

test("extract: overflow digits rejected (< 2^31 cents)", () => {
  const ex = extractSnapshot(
    binaryToBytes("Manhattan Office Rent Avg Effective $99999999999.99 / SF\r\n"),
  );
  assert.equal(ex.cents, 0);
  assert.match(ex.error, /overflow/);
});

test("extract: single-decimal value rejected (needs exactly two)", () => {
  const ex = extractSnapshot(binaryToBytes("Manhattan Office Rent Avg Effective $92.8 / SF\r\n"));
  assert.equal(ex.cents, 0);
  assert.match(ex.error, /two decimal/);
});

// ---------------------------------------------------------------------------
// Review-fix parity tests: the TS extractor and tag policy must match the
// chain's budget machine and byte-exact policy (findings: extraction window
// semantics drift, tag-policy drift, t=0, b=-position, from-suffix).
// ---------------------------------------------------------------------------
import { evaluateChainTagPolicy, WINDOW_BYTES, ANCHOR } from "./emailkit.ts";

const bodyOf = (s: string) => binaryToBytes(s);

function snapshotBody(padAfterAnchor: number, padAfterLabel: number, tail = " $92.88 / SF"): Uint8Array {
  return bodyOf(ANCHOR + "x".repeat(padAfterAnchor) + "Avg Effective" + "x".repeat(padAfterLabel) + tail + "\r\n");
}

test("extractor: label completing exactly at the 600-byte budget passes; one past fails", () => {
  // label occupies fed bytes pad+1 .. pad+13; completion at 600 → pad = 587
  assert.equal(extractSnapshot(snapshotBody(587, 0)).cents, 9288);
  assert.equal(extractSnapshot(snapshotBody(588, 0)).cents, 0);
});

test("extractor: '$' at fed byte 600 after label passes; 601 fails", () => {
  // after the label the budget resets; fed bytes are padAfterLabel x's, ' ', '$',
  // so '$' sits at fed position padAfterLabel + 2
  assert.equal(extractSnapshot(snapshotBody(0, 598, " $92.88 / SF")).cents, 9288); // $ at 600
  assert.equal(extractSnapshot(snapshotBody(0, 599, " $92.88 / SF")).cents, 0); // $ at 601
});

test("extractor: number + suffix share one 600-byte budget from '$'", () => {
  const pass = ANCHOR + "Avg Effective" + "$" + " ".repeat(585) + "92.88 / SF" + "\r\n";
  const fail = ANCHOR + "Avg Effective" + "$" + " ".repeat(595) + "92.88 / SF" + "\r\n";
  assert.equal(extractSnapshot(bodyOf(pass)).cents, 9288);
  assert.equal(extractSnapshot(bodyOf(fail)).cents, 0);
});

test("extractor: unbounded spaces no longer accepted before '/ SF'", () => {
  const b = ANCHOR + "Avg Effective $92.88" + " ".repeat(650) + "/ SF\r\n";
  assert.equal(extractSnapshot(bodyOf(b)).cents, 0);
});

test("chain tag policy: byte-exact values, no normalization", () => {
  const mk = (tags: string) => `dkim-signature:${tags}`;
  const good = mk(
    "v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; s=b37; bh=XO8VsgH6yzZkDP1Z0WZojXMdOoa4j1i17epBk4K5SOE=; t=1789642464; b=",
  );
  assert.equal(evaluateChainTagPolicy(good, undefined, undefined, 1789700000).ok, true);
  // internal space in d= (fold artifact) — chain compares byte-exact
  const spaceD = good.replace("d=newyork.credaily.com", "d=newyork .credaily.com");
  assert.equal(evaluateChainTagPolicy(spaceD, undefined, undefined, 1789700000).ok, false);
  // uppercase algorithm
  const upperA = good.replace("a=rsa-sha256", "a=RSA-SHA256");
  assert.equal(evaluateChainTagPolicy(upperA, undefined, undefined, 1789700000).ok, false);
  // valueless segment → chain reverts MalformedTag
  const garbage = good.replace("; t=", "; garbage; t=");
  assert.equal(evaluateChainTagPolicy(garbage, undefined, undefined, 1789700000).ok, false);
  // duplicate known tag
  const dup = good + "; d=newyork.credaily.com";
  assert.equal(evaluateChainTagPolicy(dup, undefined, undefined, 1789700000).ok, false);
  // t=0 → chain reverts BadTimestamp
  const t0 = good.replace("t=1789642464", "t=0");
  assert.equal(evaluateChainTagPolicy(t0, undefined, undefined, 1789700000).ok, false);
  // b= not the last tag is FINE (position-independent, unlike the old preflight)
  const bMid = mk(
    "v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; s=b37; b=; bh=XO8VsgH6yzZkDP1Z0WZojXMdOoa4j1i17epBk4K5SOE=; t=1789642464",
  );
  assert.equal(evaluateChainTagPolicy(bMid, undefined, undefined, 1789700000).ok, true);
});

test("real fixture still fully passes preflight after parity changes", async () => {
  const report = await preflight(rawEml, { now: Number(meta.t) + 3600 });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.pass)));
  assert.equal(report.parsed?.extraction.cents, 9288);
});
