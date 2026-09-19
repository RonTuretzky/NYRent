/**
 * _shared.mjs — common plumbing for the rent-scout collectors.
 *
 * Every collector exports an async function that NEVER throws and resolves to
 *
 *   { ok: true,  signals: Signal[] }            on (possibly partial) success
 *   { ok: false, error: string, source: string } on total failure
 *
 * Signal (the one typed unit every collector emits):
 *   {
 *     source: string   — collector id ("credaily" | "kalshi" | "cushman" | ...)
 *     asOf:   string   — ISO-8601 timestamp the datum refers to (publish date,
 *                        market update time, observation time — NOT fetch time);
 *                        null when the source timestamp is missing (unknown-age
 *                        — consumers must treat the datum as stale, never fresh)
 *     kind:   string   — machine-readable metric id (see each collector)
 *     value:  number   — the numeric payload (cents, price, pct, count, ...)
 *     detail: string   — human-readable context
 *     url:    string   — provenance URL (page / API endpoint / explorer link)
 *   }
 *
 * Conventions (matches scripts/ discipline): plain ESM .mjs, no deps beyond
 * viem (used only by oracle.mjs), hard timeouts via AbortController, zero
 * retries, explicit user-agent, no secrets.
 */

export const USER_AGENT =
  "Mozilla/5.0 (compatible; nyrent-agent/0.1; +https://github.com/RonTuretzky/nyrent-cover)";

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Build a Signal, filling defaults so every field is always present. */
export function signal({ source, asOf, kind, value, detail = "", url = "" }) {
  return { source, asOf, kind, value, detail, url };
}

/** Uniform total-failure result. */
export const fail = (source, error) => ({ ok: false, source, error: String(error) });

/**
 * fetch with a hard timeout and zero retries. Resolves to
 * { ok:true, status, text } or { ok:false, error } — never throws.
 */
export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, accept = "*/*" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} for ${url}` };
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, error: `${err?.cause?.message ?? err?.message ?? err} for ${url}` };
  } finally {
    clearTimeout(timer);
  }
}

/** fetchText + JSON.parse, same non-throwing contract. */
export async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, { accept: "application/json", ...opts });
  if (!r.ok) return r;
  try {
    return { ok: true, status: r.status, json: JSON.parse(r.text) };
  } catch (err) {
    return { ok: false, error: `invalid JSON from ${url}: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Plain-string HTML helpers (no regex, no cheerio — mirrors the repo's
// "no heavy parsing deps" rule; the on-chain extractor is a byte machine too)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
};

/**
 * Decode an HTML document/fragment to visible text: tags are replaced by a
 * single space, entities are decoded, whitespace runs collapse to one space
 * (the analogue of the relaxed-canonical body the on-chain extractor sees).
 * <script>/<style> contents are dropped entirely.
 */
export function htmlToText(html) {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const c = html[i];
    if (c === "<") {
      // skip script/style bodies wholesale
      const low = html.slice(i + 1, i + 7).toLowerCase();
      if (low.startsWith("script") || low.startsWith("style")) {
        const closer = low.startsWith("script") ? "</script" : "</style";
        const end = html.toLowerCase().indexOf(closer, i);
        i = end === -1 ? n : html.indexOf(">", end) + 1 || n;
        out += " ";
        continue;
      }
      const end = html.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      out += " ";
    } else if (c === "&") {
      const semi = html.indexOf(";", i);
      if (semi !== -1 && semi - i <= 10) {
        const name = html.slice(i + 1, semi);
        if (name.startsWith("#x") || name.startsWith("#X")) {
          const cp = Number.parseInt(name.slice(2), 16);
          out += Number.isFinite(cp) ? String.fromCodePoint(cp) : "&" + name + ";";
          i = semi + 1;
          continue;
        }
        if (name.startsWith("#")) {
          const cp = Number.parseInt(name.slice(1), 10);
          out += Number.isFinite(cp) ? String.fromCodePoint(cp) : "&" + name + ";";
          i = semi + 1;
          continue;
        }
        if (name in NAMED_ENTITIES) {
          out += NAMED_ENTITIES[name];
          i = semi + 1;
          continue;
        }
      }
      out += "&";
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  // collapse all whitespace runs to a single space
  let collapsed = "";
  let inWs = false;
  for (const ch of out) {
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") {
      if (!inWs) collapsed += " ";
      inWs = true;
    } else {
      collapsed += ch;
      inWs = false;
    }
  }
  return collapsed.trim();
}

/** All slice positions of `needle` in `haystack` (non-overlapping). */
export function countOccurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  for (;;) {
    i = haystack.indexOf(needle, i);
    if (i === -1) return count;
    count += 1;
    i += needle.length;
  }
}

/** Text between two markers, or "" when either is missing. */
export function between(text, after, before, from = 0) {
  const a = text.indexOf(after, from);
  if (a === -1) return "";
  const start = a + after.length;
  const b = text.indexOf(before, start);
  if (b === -1) return "";
  return text.slice(start, b);
}

const isDigit = (c) => c >= "0" && c <= "9";

/**
 * Parse the first "$<digits>.<dd>" amount that COMPLETES within `window`
 * characters of `from` — same window discipline as Dkim.sol's value machine
 * (optional spaces after '$', integer digits, '.', exactly two cent digits).
 * Returns { cents, end } (end = index after the last cent digit) or null.
 */
export function parseDollarCents(text, from, window = 600) {
  const limit = Math.min(text.length, from + window);
  let i = text.indexOf("$", from);
  if (i === -1 || i >= limit) return null;
  i += 1;
  while (i < limit && text[i] === " ") i += 1;
  let dollars = 0;
  let sawDigit = false;
  while (i < limit && (isDigit(text[i]) || text[i] === ",")) {
    if (text[i] !== ",") {
      dollars = dollars * 10 + (text.charCodeAt(i) - 48);
      sawDigit = true;
    }
    i += 1;
  }
  if (!sawDigit || text[i] !== ".") return null;
  i += 1;
  if (i + 1 >= text.length || !isDigit(text[i]) || !isDigit(text[i + 1])) return null;
  if (i + 1 >= limit) return null; // the amount must complete inside the window
  const cents = dollars * 100 + (text.charCodeAt(i) - 48) * 10 + (text.charCodeAt(i + 1) - 48);
  return { cents, end: i + 2 };
}

/**
 * Parse the first "<digits>(.<digits>)?%" percentage completing within
 * `window` characters of `from`. Returns { pct, end } or null.
 */
export function parsePercent(text, from, window = 600) {
  const limit = Math.min(text.length, from + window);
  for (let i = from; i < limit; i++) {
    if (!isDigit(text[i])) continue;
    let j = i;
    let intPart = 0;
    while (j < limit && isDigit(text[j])) {
      intPart = intPart * 10 + (text.charCodeAt(j) - 48);
      j += 1;
    }
    let frac = 0;
    let scale = 1;
    if (text[j] === "." && isDigit(text[j + 1] ?? "")) {
      j += 1;
      while (j < limit && isDigit(text[j])) {
        frac = frac * 10 + (text.charCodeAt(j) - 48);
        scale *= 10;
        j += 1;
      }
    }
    if (text[j] === "%") return { pct: intPart + frac / scale, end: j + 1 };
    i = j; // resume after this non-percentage number
  }
  return null;
}

/** True when this module file is being run directly (`node collectors/x.mjs`). */
export function isMain(importMetaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  return importMetaUrl === new URL(`file://${arg}`).href || importMetaUrl.endsWith(arg.split("/").pop());
}

/** Pretty-print a collector result for live runs. */
export function printResult(name, res) {
  if (!res.ok) {
    console.log(`${name}: FAILED — ${res.error}`);
    return;
  }
  console.log(`${name}: ${res.signals.length} signal(s)`);
  for (const s of res.signals) {
    console.log(`  [${s.kind}] ${s.value}  asOf=${s.asOf}  ${s.detail.slice(0, 110)}`);
  }
}
