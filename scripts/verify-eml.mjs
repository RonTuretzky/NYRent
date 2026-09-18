#!/usr/bin/env node
/**
 * verify-eml.mjs — anyone-can-run local DKIM verification of a CRE Daily .eml
 * against the PINNED key (docs/VERIFICATION.md evidence chain).
 *
 * Usage:
 *   node scripts/verify-eml.mjs [path/to/email.eml] [--json] [--no-golden]
 *
 * With no path it verifies the checked-in fixture AND does the golden
 * byte-for-byte comparison against fixtures/credaily-2026-09-17/*.bin.
 * Exit code 0 iff every check passes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { emailkit, FIXTURE_EML, ROOT, printChecklist, toHex, die } from "./_lib.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const noGolden = args.includes("--no-golden");
const emlPath = args.find((a) => !a.startsWith("--")) ?? FIXTURE_EML;
const isFixture = path.resolve(emlPath) === FIXTURE_EML;

const raw = new Uint8Array(readFileSync(emlPath));
const report = await emailkit.preflight(raw);
const p = report.parsed;

const goldens = [];
if (isFixture && !noGolden && p) {
  const fixDir = path.dirname(FIXTURE_EML);
  const bin = (n) => new Uint8Array(readFileSync(path.join(fixDir, n)));
  const meta = JSON.parse(readFileSync(path.join(fixDir, "meta.json"), "utf8"));
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  goldens.push(["signed-headers.bin byte-identical", eq(p.signedHeaders, bin("signed-headers.bin"))]);
  goldens.push(["canon-body.bin byte-identical", eq(p.canonBody, bin("canon-body.bin"))]);
  goldens.push(["sig.bin byte-identical", eq(p.sig, bin("sig.bin"))]);
  goldens.push(["value == 9288 cents", p.cents === 9288]);
  goldens.push([`anchor offset == ${meta.anchor_offset}`, p.anchorOffset === meta.anchor_offset]);
  goldens.push([`bh == ${meta.bh_b64}`, p.bh === meta.bh_b64]);
}

const goldenOk = goldens.every(([, pass]) => pass);
const allOk = report.ok && goldenOk;

if (json) {
  console.log(
    JSON.stringify(
      {
        ok: allOk,
        eml: path.relative(ROOT, path.resolve(emlPath)),
        checks: report.checks,
        goldens: goldens.map(([label, pass]) => ({ label, pass })),
        summary: p
          ? { emailId: p.emailId, cents: p.cents, t: p.tags.t, d: p.tags.d, s: p.tags.s, bh: p.bh, valuePreview: p.valuePreview }
          : null,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`verify-eml: ${emlPath}`);
  printChecklist(report);
  if (goldens.length) {
    console.log("\n  Golden fixture comparison:");
    for (const [label, pass] of goldens) console.log(`    [${pass ? "PASS" : "FAIL"}] ${label}`);
  }
  if (p) {
    console.log("\n  Summary:");
    console.log(`    emailId (sha256 canon body): ${p.emailId}`);
    console.log(`    value: ${p.valuePreview || "(extraction failed)"} => ${p.cents} cents`);
    console.log(`    dkim: d=${p.tags.d} s=${p.tags.s} t=${p.tags.t}`);
    console.log(`    signedHeaders=${p.signedHeaders.length}B canonBody=${p.canonBody.length}B sig=${p.sig.length}B`);
    console.log(`    sig (first 16B): ${toHex(p.sig.subarray(0, 16))}…`);
  }
  console.log(`\n${allOk ? "VERIFIED: email is authentic and parseable." : "FAILED: see checks above."}`);
}

if (!allOk) die("verification failed");
