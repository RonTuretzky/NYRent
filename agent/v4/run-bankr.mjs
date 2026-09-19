#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http } from "viem";
import { createBankrExecutor, parseVerdict } from "../executors/bankr.mjs";
import { bankrReviewSignals, gatherSignals } from "../run.mjs";
import { buildV4AdvisoryPrompt, createBankrV4WalletClient } from "./bankr.mjs";
import { readV4State } from "./chain.mjs";
import { executeV4QuotePlan } from "./direct.mjs";
import { planV4Quotes } from "./plan.mjs";

const { values } = parseArgs({
  options: {
    target: { type: "string" }, rpc: { type: "string" }, execute: { type: "boolean" },
    "bankr-review": { type: "boolean" }, "skip-collectors": { type: "boolean" }, help: { type: "boolean" },
  },
  strict: true,
});
if (values.help || !values.target || !values.rpc) {
  console.log(`Bankr-backed v4 quote runner:
  node agent/v4/run-bankr.mjs --target PUBLIC_TARGET.json --rpc RPC_URL --bankr-review
  BANKR_V4_EXECUTE=1 BANKR_API_KEY=... BANKR_WALLET=... node agent/v4/run-bankr.mjs --target PUBLIC_TARGET.json --rpc RPC_URL --bankr-review --execute

Dry run is the default. Live execution requires both --execute and BANKR_V4_EXECUTE=1, then verifies /wallet/me before any submission.`);
  process.exit(values.help ? 0 : 1);
}

const target = JSON.parse(await readFile(values.target, "utf8"));
const publicClient = createPublicClient({ transport: http(values.rpc) });
const state = await readV4State(publicClient, target);
const plan = planV4Quotes(state);
let review = null;
if (values["bankr-review"]) {
  const signals = await gatherSignals({ skip: values["skip-collectors"] });
  const reviewer = createBankrExecutor();
  if (!reviewer.enabled) throw new Error(reviewer.reason);
  const response = await reviewer.agentPrompt(buildV4AdvisoryPrompt(plan, bankrReviewSignals(signals)));
  review = response.ok ? { ok: true, ...parseVerdict(response.response), jobId: response.jobId } : response;
  if (process.env.BANKR_ADVISORY_BLOCKING === "1" && review.verdict === "veto") {
    console.log(JSON.stringify({ plan, review, result: { dryRun: true, refused: true, reason: "Bankr advisory veto" } }, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
    process.exit(3);
  }
}
let result;
if (plan.refused) result = { dryRun: true, refused: true };
else if (!values.execute) result = await executeV4QuotePlan({ plan, target, publicClient });
else {
  const walletClient = await createBankrV4WalletClient({ chainId: target.chainId });
  result = await executeV4QuotePlan({ plan, target, publicClient, walletClient, execute: true });
}
console.log(JSON.stringify({ plan, review, result }, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
