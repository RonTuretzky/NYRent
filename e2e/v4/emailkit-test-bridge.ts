/** TEST-BUILD ONLY. Same parser, body-hash and RSA checks as production, but
 * matching the local oracle's deliberately public synthetic-fixture key.
 * This module is only imported by the isolated Vite config in this folder. */
import { preflight, parseEml, bytesToHex, type PreflightReport } from "../../web/src/lib/emailkit";
import key from "../../fixtures/testkey/meta.json";
export type { ParsedEmail, PreflightCheck, PreflightReport } from "../../web/src/lib/emailkit";
export const runPreflight = (bytes: Uint8Array): Promise<PreflightReport> => preflight(bytes, { modulusHex: key.modulus_hex.replace(/^0x/, "") });
export const parseEmailBytes = parseEml;
export const toHex = (bytes: Uint8Array): `0x${string}` => `0x${bytesToHex(bytes)}`;
