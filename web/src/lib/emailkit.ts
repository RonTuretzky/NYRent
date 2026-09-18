/**
 * emailkit — TS port of the locally verified CRE Daily DKIM canonicalization pipeline.
 *
 * SPEC §3. No dependencies beyond WebCrypto (globalThis.crypto.subtle) — runs in the
 * browser and in Node >= 22 unchanged.
 *
 * Pipeline (byte-identical to fixtures/credaily-2026-09-17/*.bin):
 *   raw .eml (CRLF or LF)                     → normalize CRLF
 *   header block                              → unfold, parse
 *   dkim-signature selection                  → by d= tag (default newyork.credaily.com)
 *   relaxed canonicalization (RFC 6376 §3.4)  → headers + body
 *   h= consumption                            → LAST unused instance first; oversigning ok
 *   trailing canonical dkim-signature line    → b= value emptied, NO trailing CRLF
 *   quoted-printable value extraction         → "Manhattan Office Rent … Avg Effective … $NN.NN / SF"
 *   preflight()                               → named-check checklist for the UI
 */

// ---------------------------------------------------------------------------
// Pinned constants (mirror fixtures/credaily-2026-09-17/meta.json and the
// on-chain CredailyRentOracle pins)
// ---------------------------------------------------------------------------

export const DKIM_DOMAIN = "newyork.credaily.com";
export const DKIM_SELECTOR = "b37";
export const PINNED_EXPONENT = 65537;
export const PINNED_MODULUS_HEX =
  "c15e025112ce8c92cedd01fe1a3d01807cfa31e2df4799f20943b76d2cc7986c" +
  "f2865595389fc711b417683fd3ce73e236d8580d189d65e3a16dba730a0e0dfd" +
  "5c87f0cef6ceca6475841bfce91ee54f0c2c0e884885fdc6f331dacbd696c3d7" +
  "dfccfbb299d56f16ff70ea3e238ee1d970e42deeb9708e3fa1fec1d87aed43eb" +
  "fe1906f11429fb21f40845582600af95dae7d6ada635da21a7c97b62712d507e" +
  "4d04cc651fa53b347d983e8697fa02136bcc8d5dd169a9d7432b2f1f83aa26be" +
  "45494e6575864b6f7f9bcc451c41a88015de26250ee127089d92294f4592fb11" +
  "715c8e33df07f784c79879467363605fe133ea941f13eb4b5f9e9555cdca9fdd";

export const FROM_ADDRESS = `<mail@${DKIM_DOMAIN}>`;

export const ANCHOR = "Manhattan Office Rent";
export const NEEDLE_AVG = "Avg Effective";
export const NEEDLE_UNIT = "/ SF";
export const WINDOW_BYTES = 600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeaderEntry {
  /** Original-cased header name. */
  name: string;
  /** Raw value: everything after the first ':', folds (CRLF + WSP) preserved. */
  rawValue: string;
}

export interface DkimTags {
  /** Raw tag map, values trimmed of surrounding WSP, internal FWS preserved. */
  raw: Record<string, string>;
  v: string;
  a: string;
  c: string;
  d: string;
  s: string;
  bh: string;
  t: string;
  h: string[];
  hasL: boolean;
  hasB: boolean;
  /** true iff some tag name appeared twice (the contract reverts on this). */
  duplicate: boolean;
}

export interface Extraction {
  /** Parsed value in cents (9288 for the fixture); 0 when the pattern fails. */
  cents: number;
  /** Total occurrences of the anchor in the decoded stream. */
  anchorCount: number;
  /** RAW canonical-body byte offset of the first anchor (-1 if absent). */
  anchorOffset: number;
  /** Human preview: "Manhattan Office Rent > Avg Effective > $92.88 / SF". */
  valuePreview: string;
  /** Why extraction failed, empty when cents > 0. */
  error: string;
}

export interface ParsedEmail {
  /** Relaxed-canonicalized signed header block, b=-emptied dkim line last, no trailing CRLF. */
  signedHeaders: Uint8Array;
  /** Relaxed-canonicalized body. */
  canonBody: Uint8Array;
  /** RSA signature bytes (decoded b= tag). */
  sig: Uint8Array;
  tags: DkimTags;
  /** base64(sha256(canonBody)) — computed, compare with tags.bh. */
  bh: string;
  /** 0x-hex sha256(canonBody) == on-chain emailId. */
  emailId: string;
  valuePreview: string;
  anchorCount: number;
  anchorOffset: number;
  cents: number;
  extraction: Extraction;
  headers: HeaderEntry[];
}

export interface PreflightCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  parsed: ParsedEmail | null;
}

export interface PreflightOptions {
  modulusHex?: string;
  exponent?: number;
  domain?: string;
  selector?: string;
  /** Unix seconds "now" for the timestamp check (default: Date.now()/1000). */
  now?: number;
}

// ---------------------------------------------------------------------------
// Byte/string helpers (latin1 <-> bytes keeps arbitrary octets intact)
// ---------------------------------------------------------------------------

export function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Canonicalization primitives (RFC 6376 relaxed/relaxed)
// ---------------------------------------------------------------------------

/** Normalize any mix of CRLF / LF / CR line endings to CRLF. */
export function normalizeCrlf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

/** Split a CRLF-normalized message into header block and body (after first empty line). */
export function splitHeadersBody(msg: string): { headerBlock: string; body: string } {
  const idx = msg.indexOf("\r\n\r\n");
  if (idx === -1) return { headerBlock: msg, body: "" };
  return { headerBlock: msg.slice(0, idx), body: msg.slice(idx + 4) };
}

/** Parse a header block into ordered entries, folds preserved in rawValue. */
export function parseHeaderBlock(headerBlock: string): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  const lines = headerBlock.split("\r\n");
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && entries.length > 0) {
      entries[entries.length - 1].rawValue += "\r\n" + line;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue; // lenient: skip malformed non-continuation line
    entries.push({ name: line.slice(0, colon), rawValue: line.slice(colon + 1) });
  }
  return entries;
}

/**
 * RFC 6376 §3.4.2 relaxed header canonicalization:
 * lowercase name, unfold, collapse WSP runs to single SP, strip WSP around ':',
 * strip trailing WSP. Returns "name:value" with NO trailing CRLF.
 */
export function relaxedHeaderCanon(name: string, rawValue: string): string {
  let v = rawValue.replace(/\r\n/g, ""); // unfold
  v = v.replace(/[ \t]+/g, " "); // collapse WSP
  v = v.replace(/^ +| +$/g, ""); // trim around colon / line end
  return name.toLowerCase() + ":" + v;
}

/** RFC 6376 §3.4.4 relaxed body canonicalization. */
export function relaxedBodyCanon(body: string): string {
  if (body === "") return "";
  const lines = body.split("\r\n");
  const canon = lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/g, ""));
  while (canon.length > 0 && canon[canon.length - 1] === "") canon.pop();
  if (canon.length === 0) return "";
  return canon.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// DKIM tag parsing + header selection
// ---------------------------------------------------------------------------

const stripWs = (s: string) => s.replace(/[ \t\r\n]+/g, "");

export function parseDkimTags(rawValue: string): DkimTags {
  const unfolded = rawValue.replace(/\r\n/g, "");
  const raw: Record<string, string> = {};
  let duplicate = false;
  for (const part of unfolded.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue; // ignore empty / malformed segments
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "") continue;
    if (k in raw) duplicate = true;
    raw[k] = v;
  }
  return {
    raw,
    v: stripWs(raw["v"] ?? ""),
    a: stripWs(raw["a"] ?? "").toLowerCase(),
    c: stripWs(raw["c"] ?? "").toLowerCase(),
    d: stripWs(raw["d"] ?? "").toLowerCase(),
    s: stripWs(raw["s"] ?? ""),
    bh: stripWs(raw["bh"] ?? ""),
    t: stripWs(raw["t"] ?? ""),
    h: (raw["h"] ?? "")
      .split(":")
      .map((x) => stripWs(x).toLowerCase())
      .filter((x) => x !== ""),
    hasL: "l" in raw,
    hasB: "b" in raw && stripWs(raw["b"]) !== "",
    duplicate,
  };
}

/** Result of {@link evaluateChainTagPolicy}. */
export interface ChainTagPolicy {
  ok: boolean;
  problems: string[];
  bh: string;
  t: number;
  bPresent: boolean;
  bEmpty: boolean;
}

const KNOWN_TAGS = ["v", "a", "c", "d", "s", "t", "bh", "l", "b"];

/**
 * Byte-exact port of the ORACLE's tag machine over the CANONICAL trailing
 * `dkim-signature:` line (Dkim.parseDkimTags + CredailyRentOracle policy).
 * Unlike {@link parseDkimTags} (lenient, used for header selection/display),
 * this performs NO whitespace-stripping or lowercasing of compared values,
 * flags valueless segments (chain: MalformedTag) and duplicates of the nine
 * known tags (chain: DuplicateTag), and applies the exact t= rules.
 */
export function evaluateChainTagPolicy(
  lastLine: string,
  domain: string = DKIM_DOMAIN,
  selector: string = DKIM_SELECTOR,
  now: number = Math.floor(Date.now() / 1000),
): ChainTagPolicy {
  const problems: string[] = [];
  const prefix = "dkim-signature:";
  if (!lastLine.startsWith(prefix)) {
    return {
      ok: false,
      problems: ["trailing line does not start with dkim-signature:"],
      bh: "",
      t: 0,
      bPresent: false,
      bEmpty: false,
    };
  }
  const wsp = (c: string) => c === " " || c === "\t";
  const vals: Record<string, string> = {};
  let hasL = false;
  let bPresent = false;
  let bEmpty = false;
  let tRaw: string | undefined;
  const seen = new Set<string>();
  for (const seg of lastLine.slice(prefix.length).split(";")) {
    let a = 0;
    let b = seg.length;
    while (a < b && wsp(seg[a])) a++;
    while (b > a && wsp(seg[b - 1])) b--;
    if (a === b) continue; // empty segment ok
    const s2 = seg.slice(a, b);
    const eq = s2.indexOf("=");
    if (eq === -1) {
      problems.push(`tag segment without '=' (chain reverts MalformedTag): "${s2.slice(0, 30)}"`);
      continue;
    }
    let name = s2.slice(0, eq);
    while (name.length > 0 && wsp(name[name.length - 1])) name = name.slice(0, -1);
    let val = s2.slice(eq + 1);
    while (val.length > 0 && wsp(val[0])) val = val.slice(1);
    if (name === "") {
      problems.push("value without a tag name (chain reverts MalformedTag)");
      continue;
    }
    if (!KNOWN_TAGS.includes(name)) continue; // unknown tags ignored, verbatim chain rule
    if (seen.has(name)) {
      problems.push(`duplicate ${name}= tag (chain reverts DuplicateTag)`);
      continue;
    }
    seen.add(name);
    if (name === "l") hasL = true;
    else if (name === "b") {
      bPresent = true;
      bEmpty = val === "";
    } else if (name === "t") tRaw = val;
    else vals[name] = val;
  }
  // Byte-exact policy — the oracle compares keccak256 of the raw value bytes.
  if ((vals["v"] ?? "") !== "1") problems.push(`v="${vals["v"] ?? ""}" (want exactly "1")`);
  if ((vals["a"] ?? "") !== "rsa-sha256") problems.push(`a="${vals["a"] ?? ""}" (byte-exact lowercase "rsa-sha256")`);
  if ((vals["c"] ?? "") !== "relaxed/relaxed") problems.push(`c="${vals["c"] ?? ""}" (byte-exact "relaxed/relaxed")`);
  if ((vals["d"] ?? "") !== domain) problems.push(`d="${vals["d"] ?? ""}" (byte-exact "${domain}")`);
  if ((vals["s"] ?? "") !== selector) problems.push(`s="${vals["s"] ?? ""}" (want "${selector}")`);
  if (hasL) problems.push("l= tag present (chain reverts BadTagPolicy(l))");
  if (!bPresent || !bEmpty) problems.push("b= must be present with an EMPTY value in the canonical block");
  let t = 0;
  if (tRaw === undefined) {
    problems.push("t= missing (chain reverts BadTimestamp)");
  } else if (!/^[0-9]+$/.test(tRaw) || tRaw.length > 20) {
    problems.push(`t="${tRaw}" is not a strict uint64 decimal (chain reverts BadTimestampTag)`);
  } else {
    t = parseInt(tRaw, 10);
    if (!(t > 0)) problems.push("t=0 (chain reverts BadTimestamp)");
    else if (t > now + 86400) problems.push(`t=${t} is more than 1 day ahead of now=${now}`);
  }
  return { ok: problems.length === 0, problems, bh: vals["bh"] ?? "", t, bPresent, bEmpty };
}

/** Select the dkim-signature header whose d= equals `domain` (case-insensitive). */
export function selectDkimHeader(
  headers: HeaderEntry[],
  domain: string = DKIM_DOMAIN,
): { index: number; entry: HeaderEntry; tags: DkimTags } | null {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].name.toLowerCase() !== "dkim-signature") continue;
    const tags = parseDkimTags(headers[i].rawValue);
    if (tags.d === domain.toLowerCase()) return { index: i, entry: headers[i], tags };
  }
  return null;
}

/** Empty the b= tag VALUE in an already-canonicalized dkim-signature line. */
export function emptyBTag(canonLine: string): string {
  const colon = canonLine.indexOf(":");
  const head = canonLine.slice(0, colon + 1);
  const parts = canonLine.slice(colon + 1).split(";");
  const out = parts.map((p) => (/^\s*b=/.test(p) ? p.replace(/^(\s*b=)[\s\S]*$/, "$1") : p));
  return head + out.join(";");
}

/**
 * Build the signed header block: for each name in h= (in order) consume the LAST
 * not-yet-used instance of that header (RFC 6376 §5.4.2); oversigned names that
 * find no unused instance consume nothing. The dkim-signature header being
 * verified is never a consumption candidate. The block is terminated by the
 * canonical dkim-signature line with the b= value emptied and NO trailing CRLF.
 */
export function buildSignedHeaders(headers: HeaderEntry[], dkimIndex: number, hNames: string[]): string {
  const lower = headers.map((h) => h.name.toLowerCase());
  const used = new Array(headers.length).fill(false);
  const pieces: string[] = [];
  for (const name of hNames) {
    for (let j = headers.length - 1; j >= 0; j--) {
      if (j === dkimIndex || used[j] || lower[j] !== name) continue;
      used[j] = true;
      pieces.push(relaxedHeaderCanon(headers[j].name, headers[j].rawValue) + "\r\n");
      break;
    }
    // no unused instance -> oversigned name, consumes nothing
  }
  const dkimCanon = relaxedHeaderCanon(headers[dkimIndex].name, headers[dkimIndex].rawValue);
  pieces.push(emptyBTag(dkimCanon));
  return pieces.join("");
}

// ---------------------------------------------------------------------------
// QP-aware value extraction (mirrors Dkim.extractSnapshot, SPEC §2.1)
// ---------------------------------------------------------------------------

function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

/**
 * Single pass over the RAW canonical body with on-the-fly quoted-printable
 * decoding (`=\r\n` soft break skipped, `=HH` decoded, else literal), then the
 * anchored pattern search on the decoded stream.
 */
export function extractSnapshot(canonBody: Uint8Array): Extraction {
  const n = canonBody.length;
  const dec = new Uint8Array(n); // decoded stream (never longer than raw)
  const rawOff = new Uint32Array(n); // raw offset of each decoded byte
  let m = 0;
  let i = 0;
  while (i < n) {
    const b = canonBody[i];
    if (b === 0x3d /* '=' */ && i + 2 < n) {
      if (canonBody[i + 1] === 0x0d && canonBody[i + 2] === 0x0a) {
        i += 3; // soft line break
        continue;
      }
      const h1 = hexVal(canonBody[i + 1]);
      const h2 = hexVal(canonBody[i + 2]);
      if (h1 >= 0 && h2 >= 0) {
        dec[m] = h1 * 16 + h2;
        rawOff[m++] = i;
        i += 3;
        continue;
      }
    }
    dec[m] = b;
    rawOff[m++] = i;
    i++;
  }
  const decStr = bytesToBinary(dec.subarray(0, m));

  // anchor count over the whole decoded stream (non-overlapping; the pattern's
  // first byte 'M' never recurs inside it, so this equals the chain's matcher)
  let anchorCount = 0;
  let at = decStr.indexOf(ANCHOR);
  const firstIdx = at;
  while (at !== -1) {
    anchorCount++;
    at = decStr.indexOf(ANCHOR, at + ANCHOR.length);
  }

  const fail = (error: string): Extraction => ({
    cents: 0,
    anchorCount,
    anchorOffset: firstIdx >= 0 ? rawOff[firstIdx] : -1,
    valuePreview: "",
    error,
  });

  if (firstIdx === -1) return fail(`anchor "${ANCHOR}" not found`);

  // Value machine — exact port of Dkim.sol's budget semantics: every decoded byte
  // fed to the machine first fails on budget==0, then decrements; a token must
  // COMPLETE within 600 fed bytes of the previous token's end, and the number PLUS
  // its "/ SF" suffix share one 600-byte budget from the '$'.
  const WANT_LABEL = 1,
    WANT_DOLLAR = 2,
    SP_BEFORE = 3,
    DOLLARS = 4,
    CENT_1 = 5,
    CENT_2 = 6,
    SP_AFTER = 7,
    SUFFIX_ST = 8,
    DONE = 9,
    FAILED = 10;
  let stage = WANT_LABEL;
  let budget = WINDOW_BYTES;
  let lj = 0;
  let dollars = 0;
  let cents = 0;
  let failWhy = "";
  let dollarAt = -1;
  let numEnd = -1;
  for (let k = firstIdx + ANCHOR.length; k < decStr.length && stage < DONE; k++) {
    if (budget === 0) {
      stage = FAILED;
      failWhy = `window of ${WINDOW_BYTES} decoded bytes exceeded (chain parks the machine)`;
      break;
    }
    budget--;
    const ch = decStr[k];
    if (stage === WANT_LABEL) {
      if (ch === NEEDLE_AVG[lj]) {
        if (++lj === NEEDLE_AVG.length) {
          stage = WANT_DOLLAR;
          budget = WINDOW_BYTES;
        }
      } else {
        lj = ch === NEEDLE_AVG[0] ? 1 : 0;
      }
    } else if (stage === WANT_DOLLAR) {
      if (ch === "$") {
        stage = SP_BEFORE;
        budget = WINDOW_BYTES;
        dollarAt = k;
      }
    } else if (stage === SP_BEFORE) {
      if (ch === " ") continue;
      if (ch >= "0" && ch <= "9") {
        dollars = ch.charCodeAt(0) - 48;
        stage = DOLLARS;
      } else {
        stage = FAILED;
        failWhy = "no digits after $";
      }
    } else if (stage === DOLLARS) {
      if (ch >= "0" && ch <= "9") {
        dollars = dollars * 10 + (ch.charCodeAt(0) - 48);
        if (dollars > 21_474_835) {
          return fail("value overflows 2^31 cents (chain reverts ValueOverflow)");
        }
      } else if (ch === ".") {
        stage = CENT_1;
      } else {
        stage = FAILED;
        failWhy = "missing decimal point";
      }
    } else if (stage === CENT_1) {
      if (ch >= "0" && ch <= "9") {
        cents = dollars * 100 + (ch.charCodeAt(0) - 48) * 10;
        stage = CENT_2;
      } else {
        stage = FAILED;
        failWhy = "need exactly two decimal digits";
      }
    } else if (stage === CENT_2) {
      if (ch >= "0" && ch <= "9") {
        cents += ch.charCodeAt(0) - 48;
        numEnd = k + 1;
        stage = SP_AFTER;
      } else {
        stage = FAILED;
        failWhy = "need exactly two decimal digits";
      }
    } else if (stage === SP_AFTER) {
      if (ch === " ") continue;
      if (ch === NEEDLE_UNIT[0]) {
        lj = 1;
        stage = SUFFIX_ST;
      } else {
        stage = FAILED;
        failWhy = `missing "${NEEDLE_UNIT}" after value`;
      }
    } else {
      // SUFFIX_ST: literal "/ SF"
      if (ch === NEEDLE_UNIT[lj]) {
        if (++lj === NEEDLE_UNIT.length) stage = DONE;
      } else {
        stage = FAILED;
        failWhy = `missing "${NEEDLE_UNIT}" after value`;
      }
    }
  }
  if (stage !== DONE) return fail(failWhy || "pattern incomplete before end of body");
  if (cents === 0) return fail("value is zero");
  const valueText = decStr.slice(dollarAt, numEnd) + " " + NEEDLE_UNIT;
  return {
    cents,
    anchorCount,
    anchorOffset: rawOff[firstIdx],
    valuePreview: `${ANCHOR} > ${NEEDLE_AVG} > ${valueText}`,
    error: "",
  };
}

// ---------------------------------------------------------------------------
// RSA (WebCrypto RSASSA-PKCS1-v1_5, SPKI built from the pinned modulus)
// ---------------------------------------------------------------------------

function derEncode(tag: number, content: Uint8Array): Uint8Array {
  let lenBytes: number[];
  if (content.length < 0x80) lenBytes = [content.length];
  else {
    const bs: number[] = [];
    let l = content.length;
    while (l > 0) {
      bs.unshift(l & 0xff);
      l >>= 8;
    }
    lenBytes = [0x80 | bs.length, ...bs];
  }
  const out = new Uint8Array(1 + lenBytes.length + content.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(content, 1 + lenBytes.length);
  return out;
}

function derUint(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let body = bytes.subarray(start);
  if (body[0] & 0x80) {
    const padded = new Uint8Array(body.length + 1);
    padded.set(body, 1);
    body = padded;
  }
  return derEncode(0x02, body);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Build an SPKI (SubjectPublicKeyInfo) DER for an RSA public key from modulus + exponent. */
export function modulusToSpki(modulusHex: string, exponent: number = PINNED_EXPONENT): Uint8Array {
  const mod = hexToBytes(modulusHex);
  const expBytes: number[] = [];
  let e = exponent;
  while (e > 0) {
    expBytes.unshift(e & 0xff);
    e = Math.floor(e / 256);
  }
  const rsaPub = derEncode(0x30, concatBytes(derUint(mod), derUint(new Uint8Array(expBytes))));
  const algo = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]); // rsaEncryption + NULL
  const bitString = derEncode(0x03, concatBytes(new Uint8Array([0x00]), rsaPub));
  return derEncode(0x30, concatBytes(algo, bitString));
}

/** WebCrypto RSASSA-PKCS1-v1_5/SHA-256 verify of the signed header block. */
export async function verifyRsa(
  signedHeaders: Uint8Array,
  sig: Uint8Array,
  modulusHex: string = PINNED_MODULUS_HEX,
  exponent: number = PINNED_EXPONENT,
): Promise<boolean> {
  const spki = modulusToSpki(modulusHex, exponent);
  const key = await crypto.subtle.importKey(
    "spki",
    spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
    signedHeaders.buffer.slice(
      signedHeaders.byteOffset,
      signedHeaders.byteOffset + signedHeaders.byteLength,
    ) as ArrayBuffer,
  );
}

// ---------------------------------------------------------------------------
// parseEml + preflight
// ---------------------------------------------------------------------------

function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === "string") return binaryToBytes(input);
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

/**
 * Parse a raw .eml into the exact byte triplet submitted on-chain plus the
 * extraction preview. Throws Error("no dkim-signature with d=<domain>") when
 * the selected signature is missing; extraction failures do NOT throw.
 */
export async function parseEml(
  input: Uint8Array | ArrayBuffer | string,
  opts: { domain?: string } = {},
): Promise<ParsedEmail> {
  const domain = opts.domain ?? DKIM_DOMAIN;
  const msg = normalizeCrlf(bytesToBinary(toBytes(input)));
  const { headerBlock, body } = splitHeadersBody(msg);
  const headers = parseHeaderBlock(headerBlock);
  if (headers.length === 0) throw new Error("not an email: no parseable headers");

  const sel = selectDkimHeader(headers, domain);
  if (!sel) throw new Error(`no dkim-signature with d=${domain}`);

  const signedStr = buildSignedHeaders(headers, sel.index, sel.tags.h);
  const signedHeaders = binaryToBytes(signedStr);
  const canonBody = binaryToBytes(relaxedBodyCanon(body));
  const sig = base64Decode(sel.tags.raw["b"] ?? "");

  const bh32 = await sha256(canonBody);
  const extraction = extractSnapshot(canonBody);

  return {
    signedHeaders,
    canonBody,
    sig,
    tags: sel.tags,
    bh: base64Encode(bh32),
    emailId: "0x" + bytesToHex(bh32),
    valuePreview: extraction.valuePreview,
    anchorCount: extraction.anchorCount,
    anchorOffset: extraction.anchorOffset,
    cents: extraction.cents,
    extraction,
    headers,
  };
}

/** Check ids, in evaluation order — stable API for the UI and for tests. */
export const CHECK_IDS = [
  "eml-parse",
  "dkim-found",
  "tag-policy",
  "structure",
  "from-domain",
  "bh-match",
  "rsa-verify",
  "timestamp",
  "extraction",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * Full local preflight mirroring CredailyRentOracle.submitObservation acceptance
 * rules. Independent checks run even when earlier ones fail (so a body tamper
 * shows bh-match FAIL while rsa-verify still PASSes); checks that cannot be
 * evaluated are reported pass=false with detail "not evaluated: <why>".
 */
export async function preflight(
  input: Uint8Array | ArrayBuffer | string,
  opts: PreflightOptions = {},
): Promise<PreflightReport> {
  const domain = opts.domain ?? DKIM_DOMAIN;
  const selector = opts.selector ?? DKIM_SELECTOR;
  const modulusHex = opts.modulusHex ?? PINNED_MODULUS_HEX;
  const exponent = opts.exponent ?? PINNED_EXPONENT;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const checks: PreflightCheck[] = [];
  const add = (id: CheckId, label: string, pass: boolean, detail: string) =>
    checks.push({ id, label, pass, detail });
  const notEvaluated = (id: CheckId, label: string, why: string) =>
    add(id, label, false, `not evaluated: ${why}`);

  let parsed: ParsedEmail | null = null;
  let parseError = "";
  try {
    parsed = await parseEml(input, { domain });
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  const structuralFail = parseError.startsWith("not an email");
  add(
    "eml-parse",
    "Email parsed (CRLF normalized, headers/body split)",
    !structuralFail,
    structuralFail ? parseError : "header block and body located",
  );
  add(
    "dkim-found",
    `DKIM signature for d=${domain} present`,
    parsed !== null,
    parsed
      ? `selected dkim-signature with d=${parsed.tags.d}, s=${parsed.tags.s}`
      : parseError || "missing",
  );

  if (!parsed) {
    const why = "no matching dkim-signature header";
    notEvaluated("tag-policy", "DKIM tag policy", why);
    notEvaluated("structure", "Signed header block structure", why);
    notEvaluated("from-domain", "From address matches pinned domain", why);
    notEvaluated("bh-match", "Body hash matches bh= tag", why);
    notEvaluated("rsa-verify", "RSA signature verifies against pinned key", why);
    notEvaluated("timestamp", "Signature timestamp sane", why);
    notEvaluated("extraction", "Rent value extracted", why);
    return { ok: false, checks, parsed: null };
  }

  const t = parsed.tags;
  const signedStr = bytesToBinary(parsed.signedHeaders);
  const lastLine = signedStr.slice(signedStr.lastIndexOf("\r\n") + 2);

  // Byte-exact chain policy over the CANONICAL trailing dkim-signature line —
  // this (not the lenient selection parser) is what submitObservation enforces.
  const policy = evaluateChainTagPolicy(lastLine, domain, selector, now);
  const tagProblems = policy.problems.filter((m) => !m.startsWith("t="));
  add(
    "tag-policy",
    "DKIM tag policy, byte-exact as on-chain (v/a/c/d/s, no l=, empty b=)",
    tagProblems.length === 0,
    tagProblems.length === 0
      ? "v=1 a=rsa-sha256 c=relaxed/relaxed d/s pinned, no l=, b= empty (canonical line verbatim)"
      : tagProblems.join("; "),
  );

  const structureOk =
    lastLine.startsWith("dkim-signature:") && !signedStr.endsWith("\r\n") && policy.bPresent && policy.bEmpty;
  add(
    "structure",
    "Signed header block ends with a b=-emptied dkim-signature line",
    structureOk,
    structureOk
      ? `${parsed.signedHeaders.length} bytes, trailing dkim-signature line with empty b= (any tag position), no trailing CRLF`
      : "canonical block malformed: trailing line must be dkim-signature: with an empty b= tag and no trailing CRLF",
  );

  const fromNeedle = `<mail@${domain.toLowerCase()}>`;
  const fromLines = signedStr.split("\r\n").filter((l) => l.startsWith("from:"));
  const fromOk = fromLines.some((l) => l.endsWith(fromNeedle));
  add(
    "from-domain",
    `A signed from: line ends with ${fromNeedle}`,
    fromOk,
    fromOk
      ? fromLines.find((l) => l.endsWith(fromNeedle))!
      : fromLines.length > 0
        ? `no signed from: line ENDS with ${fromNeedle} (display-name matches don't count): ${fromLines.join(" | ")}`
        : "no signed from: line",
  );

  const bhTag = policy.bh || t.bh;
  const bhOk = parsed.bh === bhTag;
  add(
    "bh-match",
    "sha256(canonical body) matches bh= tag",
    bhOk,
    bhOk ? `bh=${parsed.bh}` : `computed ${parsed.bh} != tag ${bhTag || "(missing)"}`,
  );

  let rsaOk = false;
  let rsaDetail: string;
  try {
    rsaOk = await verifyRsa(parsed.signedHeaders, parsed.sig, modulusHex, exponent);
    rsaDetail = rsaOk
      ? `RSASSA-PKCS1-v1_5/SHA-256 valid for pinned ${modulusHex.length * 4}-bit key`
      : "signature does NOT verify against the pinned modulus";
  } catch (err) {
    rsaDetail = `verify error: ${err instanceof Error ? err.message : String(err)}`;
  }
  add("rsa-verify", "RSA signature verifies (WebCrypto, pinned key)", rsaOk, rsaDetail);

  const tsProblems = policy.problems.filter((m) => m.startsWith("t="));
  const tsOk = tsProblems.length === 0 && policy.t > 0;
  add(
    "timestamp",
    "t= parses, is nonzero, and is not in the future (>1 day)",
    tsOk,
    tsOk ? `t=${policy.t} (${new Date(policy.t * 1000).toISOString()})` : tsProblems.join("; ") || "t= invalid",
  );

  const ex = parsed.extraction;
  const exOk = ex.anchorCount === 1 && ex.cents > 0;
  add(
    "extraction",
    "Rent value extracted (unique anchor, cents > 0)",
    exOk,
    exOk
      ? `${ex.valuePreview} -> ${ex.cents} cents (anchor @ canon offset ${ex.anchorOffset})`
      : ex.anchorCount !== 1
        ? `anchor count ${ex.anchorCount} (need exactly 1)${ex.error ? "; " + ex.error : ""}`
        : ex.error,
  );

  return { ok: checks.every((c) => c.pass), checks, parsed };
}
