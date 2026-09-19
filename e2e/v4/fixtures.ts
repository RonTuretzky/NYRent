import { createHash, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./constants";

/** Uses the deliberately public TEST key already committed for synthetic
 * oracle tests. These emails were never issued by CRE Daily. */
export function signedFixture(cents: number, timestamp: bigint) {
  const body = Buffer.from(`TEST ONLY. Manhattan Office Rent Avg Effective $${(cents / 100).toFixed(2)} / SF\r\n`, "utf8");
  const bodyHash = createHash("sha256").update(body).digest("base64");
  const headers = Buffer.from([
    "from:CRE Daily New York <mail@newyork.credaily.com>",
    "to:test-recipient@example.com",
    "subject:Synthetic Market Snapshot (TEST ONLY)",
    "mime-version:1.0",
    `dkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; h=from:to:subject:mime-version; s=b37; t=${timestamp}; bh=${bodyHash}; b=`,
  ].join("\r\n"));
  const signature = sign("RSA-SHA256", headers, fs.readFileSync(path.join(ROOT, "fixtures/testkey/test-only-private-key.pem")));
  if (!verify("RSA-SHA256", headers, fs.readFileSync(path.join(ROOT, "fixtures/testkey/test-only-public-key.pem")), signature)) throw new Error("Test fixture signature failed self-check");
  const eml = Buffer.concat([headers, Buffer.from(signature.toString("base64") + "\r\n\r\n"), body]);
  const hex = (b: Buffer): `0x${string}` => `0x${b.toString("hex")}`;
  return { body, headers, signature, eml, args: [hex(headers), hex(body), hex(signature)] as const };
}
