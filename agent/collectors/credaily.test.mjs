/**
 * Parser unit tests for credaily.mjs against REAL captured responses in
 * agent/fixtures/ (see fixtures/CAPTURE.md for capture provenance).
 * Run: node --test agent/collectors/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverIssueUrls, parseIssue, extractSnapshot } from "./credaily.mjs";
import { htmlToText } from "./_shared.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const CPACE_URL = "https://www.credaily.com/newsletters/new-york/issue/nyc-c-pace-revamp-could-unlock-more-cre-capital/";

test("discoverIssueUrls: real archive index lists NY issues, newest first, deduped", () => {
  const urls = discoverIssueUrls(read("credaily-ny-index.html"));
  assert.ok(urls.length >= 20, `expected >= 20 NY issue urls, got ${urls.length}`);
  assert.equal(urls[0], CPACE_URL); // 2026-09-17 issue, the newest at capture time
  for (const u of urls) assert.ok(u.includes("/newsletters/new-york/issue/"), u);
  assert.equal(new Set(urls).size, urls.length, "urls must be deduped");
});

test("parseIssue: 2026-09-17 issue extracts 9288 cents — matches on-chain observation #0", () => {
  const issue = parseIssue(read("credaily-issue-nyc-c-pace-revamp.html"), CPACE_URL);
  assert.equal(issue.valid, true);
  assert.equal(issue.cents, 9288); // $92.88 / SF, same value the DKIM email settled on-chain
  assert.equal(issue.anchorCount, 1); // oracle acceptance rule: anchors == 1
  assert.ok(issue.publishedAt.startsWith("2026-09-17"), issue.publishedAt);
  assert.ok(issue.title.includes("C-PACE"), issue.title);
});

test("parseIssue: 2026-07-14 issue extracts the older value 8503 cents", () => {
  const issue = parseIssue(read("credaily-issue-brookfield-ai-office-hub.html"));
  assert.equal(issue.valid, true);
  assert.equal(issue.cents, 8503); // $85.03 / SF (CompStak window 3/01/26–5/31/26)
  assert.equal(issue.anchorCount, 1);
  assert.ok(issue.publishedAt.startsWith("2026-07-14"), issue.publishedAt);
});

test("parseIssue: missing article:published_time yields empty publishedAt (collector passes asOf null, never fetch time)", () => {
  const html = read("credaily-issue-nyc-c-pace-revamp.html").replace(
    'property="article:published_time"',
    'property="article:published_time_gone"',
  );
  const issue = parseIssue(html, CPACE_URL);
  assert.equal(issue.publishedAt, "");
  assert.equal(issue.valid, true, "the value still extracts — only its age is unknown");
  assert.equal(issue.cents, 9288);
});

test("cross-fixture: web archive value equals the recorded on-chain observation", () => {
  const issue = parseIssue(read("credaily-issue-nyc-c-pace-revamp.html"));
  const oracle = JSON.parse(read("oracle-observations.json"));
  assert.equal(issue.cents, oracle.observations[0].cents);
});

// --- anchor-machine discipline (pure-function edge cases, Dkim.sol grammar) ---

test("extractSnapshot: happy path on minimal decoded text", () => {
  const r = extractSnapshot("x Manhattan Office Rent y Avg Effective z $92.88 / SF w");
  assert.deepEqual(r, { cents: 9288, anchorCount: 1 });
});

test("extractSnapshot: optional spaces after '$' are allowed", () => {
  const r = extractSnapshot("Manhattan Office Rent Avg Effective $  92.88 / SF");
  assert.equal(r.cents, 9288);
});

test("extractSnapshot: no anchor -> cents 0, anchorCount 0", () => {
  assert.deepEqual(extractSnapshot("Avg Effective $92.88 / SF"), { cents: 0, anchorCount: 0 });
});

test("extractSnapshot: counts every anchor (oracle requires exactly 1)", () => {
  const text = "Manhattan Office Rent Avg Effective $92.88 / SF and Manhattan Office Rent again";
  const r = extractSnapshot(text);
  assert.equal(r.anchorCount, 2);
  // parseIssue marks this invalid even though a value parsed
  assert.equal(r.cents, 9288);
});

test("extractSnapshot: label beyond the 600-char window -> failed", () => {
  const r = extractSnapshot("Manhattan Office Rent " + "x".repeat(600) + " Avg Effective $92.88 / SF");
  assert.equal(r.cents, 0);
  assert.equal(r.anchorCount, 1);
});

test("extractSnapshot: broken pattern (missing '/ SF' suffix) -> failed", () => {
  assert.equal(extractSnapshot("Manhattan Office Rent Avg Effective $92.88 per year").cents, 0);
});

test("extractSnapshot: single cent digit -> failed (grammar wants exactly .dd)", () => {
  assert.equal(extractSnapshot("Manhattan Office Rent Avg Effective $92.8 / SF").cents, 0);
});

test("htmlToText: strips the fixture's stat-block markup into the decoded stream", () => {
  const html = read("credaily-issue-nyc-c-pace-revamp.html");
  const text = htmlToText(html);
  assert.ok(text.includes("Manhattan Office Rent Avg Effective"), "tags between anchor and label collapse to spaces");
  assert.ok(text.includes("$92.88 / SF"));
});
