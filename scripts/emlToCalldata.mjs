#!/usr/bin/env node
/**
 * emlToCalldata.mjs — turn a verified .eml into CredailyRentOracle.submitObservation
 * calldata (for manual submission, gas estimation, or debugging).
 *
 * Usage:
 *   node scripts/emlToCalldata.mjs [path/to/email.eml] [--out file.json] [--force] [--compact]
 *
 * Prints JSON: { emailId, cents, t, signedHeadersHex, canonBodyHex, sigHex, calldata, calldataBytes }.
 * Refuses to encode an email that fails preflight unless --force.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { emailkit, FIXTURE_EML, ORACLE_ABI, printChecklist, toHex, die } from "./_lib.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const compact = args.includes("--compact");
const outIdx = args.indexOf("--out");
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const emlPath = args.find((a, i) => !a.startsWith("--") && i !== outIdx + 1) ?? FIXTURE_EML;

const raw = new Uint8Array(readFileSync(emlPath));
const report = await emailkit.preflight(raw);
if (!report.ok) {
  printChecklist(report);
  if (!force) die("preflight failed — refusing to encode calldata (use --force to override)");
  console.error("WARNING: --force used, encoding calldata for a FAILING email");
}
const p = report.parsed ?? die("email could not be parsed at all; nothing to encode");

const signedHeadersHex = toHex(p.signedHeaders);
const canonBodyHex = toHex(p.canonBody);
const sigHex = toHex(p.sig);
const calldata = encodeFunctionData({
  abi: ORACLE_ABI,
  functionName: "submitObservation",
  args: [signedHeadersHex, canonBodyHex, sigHex],
});

const out = {
  function: "submitObservation(bytes signedHeaders, bytes canonBody, bytes sig)",
  emailId: p.emailId,
  cents: p.cents,
  t: Number(p.tags.t),
  valuePreview: p.valuePreview,
  signedHeadersBytes: p.signedHeaders.length,
  canonBodyBytes: p.canonBody.length,
  sigBytes: p.sig.length,
  calldataBytes: (calldata.length - 2) / 2,
  signedHeadersHex,
  canonBodyHex,
  sigHex,
  calldata,
};

const text = JSON.stringify(out, null, compact ? 0 : 2);
if (outPath) {
  writeFileSync(outPath, text + "\n");
  console.error(`wrote ${outPath} (${out.calldataBytes} calldata bytes, emailId ${out.emailId})`);
} else {
  console.log(text);
}
