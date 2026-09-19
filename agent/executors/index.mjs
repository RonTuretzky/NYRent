/**
 * index.mjs — executor selection + the single execute(plan, {dryRun}) entrypoint.
 *
 * Direct (direct.mjs) is the only executor that writes to Gnosis; it always runs.
 * Bankr (bankr.mjs) is selected only when BANKR_API_KEY is set and is strictly
 * advisory (Bankr has no Gnosis support): pre-execution second opinion, post-
 * execution operator notification, optional BANKR_MIRROR=1 Base mirror. Any Bankr
 * failure is logged and swallowed — it can never block Direct execution. By
 * default even a "veto" verdict is recorded, not enforced; set
 * BANKR_ADVISORY_BLOCKING=1 to let a parsed veto stop the Direct batch.
 *
 * CLI: node executors/index.mjs --plan <plan.json> [--dry-run]
 */
import { readFileSync } from "node:fs";
import { createDirectExecutor } from "./direct.mjs";
import { createBankrExecutor } from "./bankr.mjs";
import { jsonBigint, loadEnv } from "./chain.mjs";

/** Build the executor set from the environment (opts override for tests/forks). */
export function createExecutors({ direct = {}, bankr = {}, log = console.log } = {}) {
  loadEnv();
  const directExec = createDirectExecutor({ log, ...direct });
  const bankrExec = createBankrExecutor({ log, ...bankr });
  if (!bankrExec.enabled) log(`bankr: disabled (${bankrExec.reason}) — proceeding Direct-only`);
  return { direct: directExec, bankr: bankrExec };
}

/**
 * Execute a Plan ({ targetFreeCapitalWei, newSeries|null, pause|null, rationale[] }).
 * Returns { advisory, direct, notified, mirrored }.
 */
export async function execute(plan, { dryRun = false, executors, signalsSummary = null, threadId, log = console.log } = {}) {
  const { direct, bankr } = executors ?? createExecutors({ log });
  const result = { advisory: null, direct: null, notified: null, mirrored: null };

  // 1. Advisory second opinion (never blocking unless explicitly configured).
  if (bankr.enabled) {
    try {
      result.advisory = await bankr.advise(plan, signalsSummary ?? plan.rationale ?? [], threadId);
      log(`bankr advisory: ${result.advisory.ok ? result.advisory.verdict : `unavailable (${result.advisory.error})`}`);
      if (result.advisory.ok && result.advisory.verdict === "veto" && process.env.BANKR_ADVISORY_BLOCKING === "1") {
        result.direct = { ok: false, executed: [], error: `blocked by Bankr advisory veto: ${result.advisory.summary}` };
        return result;
      }
    } catch (err) {
      // Belt and braces: advise() already never throws.
      result.advisory = { ok: false, error: String(err?.message ?? err) };
      log(`bankr advisory failed (${result.advisory.error}) — continuing with Direct`);
    }
  }

  // 2. The real execution on Gnosis.
  result.direct = await direct.execute(plan, { dryRun });

  // 3. Post-execution notification + optional Base mirror (never blocking, skipped on dry runs).
  if (bankr.enabled && !dryRun) {
    try {
      const summary = result.direct.ok
        ? `NY Rent Cover plan executed on Gnosis: ${result.direct.executed.map((t) => t.name).join("; ") || "no-op"}.`
        : `NY Rent Cover plan FAILED on Gnosis at "${result.direct.failed?.name ?? "?"}": ${result.direct.error}`;
      result.notified = await bankr.notify(summary, threadId);
      if (result.direct.ok && result.direct.executed.length > 0) {
        result.mirrored = await bankr.mirrorOnBase(plan);
      }
    } catch (err) {
      log(`bankr post-execution step failed (${err?.message ?? err}) — Direct result stands`);
    }
  }

  return result;
}

// ----------------------------------------------------------------------------
// CLI entry
// ----------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const planIdx = argv.indexOf("--plan");
  if (planIdx === -1 || !argv[planIdx + 1]) {
    console.error("usage: node executors/index.mjs --plan <plan.json> [--dry-run]");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(argv[planIdx + 1], "utf8"));
  const result = await execute(plan, { dryRun });
  console.log(JSON.stringify(result, jsonBigint, 2));
  process.exit(result.direct?.ok ? 0 : 1);
}
