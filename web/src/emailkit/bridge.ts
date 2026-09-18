/**
 * Bridge to the emailkit agent's library (web/src/lib/emailkit.ts, owned
 * elsewhere — imported, never edited here). All UI access to email parsing /
 * preflight goes through this module so the cross-agent surface stays in one
 * place.
 */
import {
  parseEml,
  preflight,
  bytesToHex,
  type ParsedEmail,
  type PreflightCheck,
  type PreflightReport,
} from "../lib/emailkit";

export type { ParsedEmail, PreflightCheck, PreflightReport };

/** Run the full preflight on raw .eml bytes. Never throws for bad emails —
 * failures come back as failing checks. Truly non-email inputs still yield a
 * report with eml-parse failed. */
export async function runPreflight(bytes: Uint8Array): Promise<PreflightReport> {
  return preflight(bytes);
}

/** Parse only (throws for non-emails) — used where we need the byte triplet. */
export async function parseEmailBytes(bytes: Uint8Array): Promise<ParsedEmail> {
  return parseEml(bytes);
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}` as `0x${string}`;
}
