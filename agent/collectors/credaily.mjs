/**
 * credaily.mjs — CRE Daily newsletter web archive collector (the PRIMARY
 * source: the only feed that publishes the settlement metric itself).
 *
 * The on-chain oracle (src/CredailyRentOracle.sol) settles on the DKIM-signed
 * CRE Daily email. The same issues are republished on the web at
 *   https://www.credaily.com/newsletters/new-york/issue/[slug]/
 * so this collector discovers recent New York issues from the archive index
 * and extracts "Manhattan Office Rent … Avg Effective … $XX.XX / SF" with the
 * SAME anchor discipline as src/lib/Dkim.sol `extractSnapshot` (docs/SPEC.md
 * §2.1): on the decoded text stream, count `Manhattan Office Rent` anchors;
 * after the FIRST anchor, `Avg Effective` must complete within ≤600 decoded
 * chars, then `$` within ≤600 more, then digits `.` two digits, optional
 * spaces, then `/ SF` — and the oracle's acceptance rule anchors==1 && cents>0
 * is enforced here too. (The web page is HTML instead of quoted-printable
 * email; "decoding" is tag-stripping + entity decoding + whitespace collapse
 * instead of QP decoding — the anchor sequence and windows are identical.)
 *
 * Verified 2026-09-18: the 2026-09-17 issue ("NYC C-PACE Revamp…") shows
 * $92.88 / SF — byte-identical value to on-chain observation #0 (9288 cents)
 * recorded from the DKIM email.
 */
import {
  fetchText,
  signal,
  fail,
  htmlToText,
  countOccurrences,
  between,
  parseDollarCents,
  isMain,
  printResult,
} from "./_shared.mjs";

export const CREDAILY_BASE = "https://www.credaily.com";
export const NY_INDEX_URL = `${CREDAILY_BASE}/newsletters/new-york/`;

// Anchor grammar — keep in lockstep with src/lib/Dkim.sol (ANCHOR/LABEL/SUFFIX/WINDOW)
export const ANCHOR = "Manhattan Office Rent";
export const LABEL = "Avg Effective";
export const SUFFIX = "/ SF";
export const WINDOW = 600;

/**
 * Ordered, deduped list of New York issue URLs found in the archive index
 * HTML (the index lists newest first — verified against published_time).
 * Plain string scanning, no regex.
 */
export function discoverIssueUrls(indexHtml, { region = "new-york" } = {}) {
  const marker = `/newsletters/${region}/issue/`;
  const urls = [];
  const seen = new Set();
  let i = 0;
  for (;;) {
    i = indexHtml.indexOf(marker, i);
    if (i === -1) break;
    // walk back to the start of the URL (href="https://www.credaily.com/…")
    let start = i;
    while (start > 0 && indexHtml[start - 1] !== '"' && indexHtml[start - 1] !== "'" && indexHtml[start - 1] !== "(") {
      start -= 1;
    }
    const quote = indexHtml[start - 1] ?? '"';
    const end = indexHtml.indexOf(quote === "(" ? ")" : quote, i);
    if (end === -1) break;
    let url = indexHtml.slice(start, end);
    if (url.startsWith("/")) url = CREDAILY_BASE + url;
    if (url.startsWith("http") && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    i = end;
  }
  return urls;
}

/**
 * Run the Dkim.sol anchor state machine over DECODED text.
 * Returns { cents, anchorCount } — cents is 0 whenever the pattern breaks or
 * a window is exceeded, exactly like the on-chain value machine parking in
 * ST_FAILED. Window accounting matches the contract: a token must COMPLETE
 * within WINDOW decoded chars counted from the char after the previous
 * token's last char (the number + suffix share a fresh window after '$').
 */
export function extractSnapshot(text) {
  const anchorCount = countOccurrences(text, ANCHOR);
  const failed = { cents: 0, anchorCount };
  const a = text.indexOf(ANCHOR);
  if (a === -1) return failed;
  const anchorEnd = a + ANCHOR.length;

  // LABEL must complete within WINDOW of the anchor
  const li = text.indexOf(LABEL, anchorEnd);
  if (li === -1 || li + LABEL.length - anchorEnd > WINDOW) return failed;
  const labelEnd = li + LABEL.length;

  // '$' must appear within WINDOW of the label; number completes in a fresh window
  const di = text.indexOf("$", labelEnd);
  if (di === -1 || di + 1 - labelEnd > WINDOW) return failed;
  const amount = parseDollarCents(text, di, WINDOW);
  if (!amount || amount.cents === 0) return failed;

  // optional spaces, then the literal SUFFIX, still inside the '$' window
  let k = amount.end;
  while (text[k] === " ") k += 1;
  if (!text.startsWith(SUFFIX, k)) return failed;
  if (k + SUFFIX.length - (di + 1) > WINDOW) return failed;

  return { cents: amount.cents, anchorCount };
}

/**
 * Parse one issue page: published time, title, snapshot value, CompStak data
 * window. `valid` mirrors the oracle acceptance rule (anchors==1, cents>0).
 */
export function parseIssue(html, url = "") {
  const publishedAt = between(html, 'property="article:published_time" content="', '"');
  const title = htmlToText(between(html, "<title>", "</title>"));
  const text = htmlToText(html);
  const { cents, anchorCount } = extractSnapshot(text);
  // footnote: "*Office metrics courtesy of CompStak ; data from 3/01/26 to 5/31/26."
  const dataWindow = between(text, "data from ", ".").trim();
  return {
    valid: cents > 0 && anchorCount === 1,
    cents,
    anchorCount,
    publishedAt,
    title,
    dataWindow,
    url,
  };
}

/**
 * Collector: discover the most recent New York issues and extract the
 * settlement metric from each. Never throws.
 */
export async function collectCredaily({ limit = 3 } = {}) {
  const source = "credaily";
  const idx = await fetchText(NY_INDEX_URL, { accept: "text/html" });
  if (!idx.ok) return fail(source, `index fetch failed: ${idx.error}`);

  const urls = discoverIssueUrls(idx.text).slice(0, limit);
  if (urls.length === 0) return fail(source, "no New York issue links found in the archive index");

  const signals = [];
  const errors = [];
  for (const url of urls) {
    const page = await fetchText(url, { accept: "text/html" });
    if (!page.ok) {
      errors.push(page.error);
      continue;
    }
    const issue = parseIssue(page.text, url);
    if (!issue.valid) {
      errors.push(`${url}: extraction failed (anchors=${issue.anchorCount}, cents=${issue.cents})`);
      continue;
    }
    signals.push(
      signal({
        source,
        // NEVER stamp fetch time: a missing article:published_time meta tag
        // must not turn an arbitrarily old value into a "fresh" print. asOf
        // null marks the signal unknown-age — decide.mjs treats such prints
        // as stale (corroboration only, never strike anchoring).
        asOf: issue.publishedAt || null,
        kind: "manhattan_office_avg_effective_cents",
        value: issue.cents,
        detail:
          `"${issue.title}" — Avg Effective $${(issue.cents / 100).toFixed(2)} / SF` +
          ` (anchors=${issue.anchorCount}${issue.dataWindow ? `; CompStak data ${issue.dataWindow}` : ""})`,
        url,
      }),
    );
  }
  if (signals.length === 0) return fail(source, `all issues failed: ${errors.join(" | ")}`);
  return { ok: true, signals, errors };
}

if (isMain(import.meta.url)) {
  const res = await collectCredaily();
  printResult("credaily", res);
  if (res.ok && res.errors?.length) console.log(`  (non-fatal: ${res.errors.join(" | ")})`);
  process.exit(res.ok ? 0 : 1);
}
