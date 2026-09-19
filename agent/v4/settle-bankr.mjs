#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { createBankrV4WalletClient } from "./bankr.mjs";
import { scanVerifiedEmails, settleVerifiedEmail } from "./settlement.mjs";

const { values } = parseArgs({ options: {
  target: { type: "string" }, rpc: { type: "string" }, inbox: { type: "string" },
  execute: { type: "boolean" }, help: { type: "boolean" },
}, strict: true });
if (values.help || !values.target || !values.rpc || !values.inbox) {
  console.log(`Settlement-only Bankr email watcher (one scan):
  node agent/v4/settle-bankr.mjs --target PUBLIC_TARGET.json --rpc RPC_URL --inbox RAW_EML_DIR
  BANKR_V4_EXECUTE=1 BANKR_API_KEY=... BANKR_WALLET=... node agent/v4/settle-bankr.mjs --target PUBLIC_TARGET.json --rpc RPC_URL --inbox RAW_EML_DIR --execute

The inbox must contain raw .eml files. This command cannot quote or trade. It refuses every chain action until trading is closed and a DKIM-verified email falls inside the observation window.`);
  process.exit(values.help ? 0 : 1);
}
const target = JSON.parse(await readFile(values.target, "utf8"));
const publicClient = createPublicClient({ transport: http(values.rpc) });
const scanned = await scanVerifiedEmails(values.inbox);
const candidates = scanned.verified.sort((a, b) => Number(a.parsed.tags.t) - Number(b.parsed.tags.t));
if (!candidates.length) {
  console.log(JSON.stringify({ status: "no-verified-email", rejected: scanned.rejected }, null, 2));
  process.exit(2);
}
let walletClient;
if (values.execute) walletClient = await createBankrV4WalletClient({ chainId: target.chainId });
let result = null;
const failures = [];
for (const candidate of candidates) {
  try {
    result = await settleVerifiedEmail({ target, parsed: candidate.parsed, publicClient, walletClient, execute: values.execute });
    result.file = candidate.file;
    break;
  } catch (error) {
    failures.push({ file: candidate.file, error: error.message });
  }
}
console.log(JSON.stringify({ result, failures, rejected: scanned.rejected }, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
if (!result) process.exitCode = 3;
