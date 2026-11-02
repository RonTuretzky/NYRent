/**
 * The app's DKIM parse (emailkit/bridge.ts, used by Record a rent) must hand
 * the oracle exactly the bytes emailkit's full parseEml produces, without
 * pulling in the office-newsletter extraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEmailBytes, toHex } from "../emailkit/bridge.ts";
import { parseEml } from "./emailkit.ts";

const DIR = new URL("../../../fixtures/credaily-2026-09-17/", import.meta.url);
const read = (f: string) => new Uint8Array(readFileSync(new URL(f, DIR)));
const eml = read("credaily-cpace-2026-09-17.eml");

test("bridge parse matches emailkit parseEml and the pinned fixture bytes", async () => {
  const domain = "newyork.credaily.com";
  const mine = await parseEmailBytes(eml, { domain });
  const full = await parseEml(eml, { domain });
  assert.deepEqual(mine.signedHeaders, full.signedHeaders);
  assert.deepEqual(mine.canonBody, full.canonBody);
  assert.deepEqual(mine.sig, full.sig);
  assert.equal(mine.emailId, full.emailId);
  assert.deepEqual(mine.tags, full.tags);
  assert.deepEqual(mine.signedHeaders, read("signed-headers.bin"));
  assert.deepEqual(mine.canonBody, read("canon-body.bin"));
  assert.deepEqual(mine.sig, read("sig.bin"));
});

test("an email without a signature from the requested domain is refused", async () => {
  await assert.rejects(parseEmailBytes(eml, { domain: "google.com" }), /no dkim-signature with d=google.com/);
  await assert.rejects(parseEmailBytes(new TextEncoder().encode("hello"), { domain: "google.com" }), /not an email/);
});

test("toHex is 0x-prefixed lowercase hex", () => {
  assert.equal(toHex(new Uint8Array([0, 171, 255])), "0x00abff");
});
