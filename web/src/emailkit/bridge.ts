/**
 * Bridge to the emailkit library (web/src/lib/emailkit.ts, shared with the
 * agent and operator scripts, which also use its CRE Daily extraction and
 * preflight). Google Alert uploads only need the generic DKIM pieces, so this
 * module assembles them from emailkit's exported helpers. That keeps the
 * office-newsletter extraction out of the app bundle; the byte triplet is the
 * same one emailkit's parseEml produces (src/lib/bridge.test.ts pins that).
 */
import {
  base64Decode,
  binaryToBytes,
  buildSignedHeaders,
  bytesToBinary,
  bytesToHex,
  normalizeCrlf,
  parseDkimTags,
  parseHeaderBlock,
  relaxedBodyCanon,
  sha256,
  splitHeadersBody,
  type DkimTags,
} from "../lib/emailkit.ts";

/** What the oracle checks: signed header block, canonical body, signature. */
export interface DkimEmail {
  signedHeaders: Uint8Array;
  canonBody: Uint8Array;
  sig: Uint8Array;
  tags: DkimTags;
  /** sha256 of the canonical body, 0x-hex: the oracle's email id. */
  emailId: `0x${string}`;
}

/**
 * Parse raw .eml bytes against the DKIM signature of `domain`. Throws for
 * non-emails and for emails without a signature from that domain.
 */
export async function parseEmailBytes(bytes: Uint8Array, opts: { domain: string }): Promise<DkimEmail> {
  const msg = normalizeCrlf(bytesToBinary(bytes));
  const { headerBlock, body } = splitHeadersBody(msg);
  const headers = parseHeaderBlock(headerBlock);
  if (headers.length === 0) throw new Error("not an email: no parseable headers");

  // emailkit's selectDkimHeader defaults to the office newsletter's domain;
  // selecting here keeps that default (and its module) out of the bundle.
  const domain = opts.domain.toLowerCase();
  let sel: { index: number; tags: DkimTags } | undefined;
  for (let i = 0; i < headers.length && !sel; i++) {
    if (headers[i].name.toLowerCase() !== "dkim-signature") continue;
    const tags = parseDkimTags(headers[i].rawValue);
    if (tags.d === domain) sel = { index: i, tags };
  }
  if (!sel) throw new Error(`no dkim-signature with d=${opts.domain}`);

  const signedHeaders = binaryToBytes(buildSignedHeaders(headers, sel.index, sel.tags.h));
  const canonBody = binaryToBytes(relaxedBodyCanon(body));
  const sig = base64Decode(sel.tags.raw["b"] ?? "");
  const emailId = `0x${bytesToHex(await sha256(canonBody))}` as `0x${string}`;
  return { signedHeaders, canonBody, sig, tags: sel.tags, emailId };
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}` as `0x${string}`;
}
