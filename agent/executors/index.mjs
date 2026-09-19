/**
 * index.mjs — per-target executor selection + the single
 * execute(plan, { target, dryRun }) entrypoint.
 *
 * The protocol is permissionless (no roles): the agent is just another wallet
 * running a two-sided book — underwriting its own series (SELL) and buying
 * underpriced cover on others' series (BUY). Two execution rails exist:
 *
 *   direct (direct.mjs)  — local key signs and sends; works on every target.
 *   bankr  (bankr.mjs)   — Bankr-custodied wallet signs and submits through
 *                          the Wallet API (docs.bankr.bot/wallet-api/submit).
 *
 * ROUTING (per target, from targets.mjs). The Bankr custody rail is
 * implemented and fork-proven but currently DORMANT (on hold): Direct is the
 * active rail on BOTH chains.
 *   gnosis   -> Direct ALWAYS (Bankr has no Gnosis support:
 *               docs.bankr.bot/getting-started/supported-chains).
 *   arbitrum -> Direct by DEFAULT (deployer identity). Bankr custody runs ONLY
 *               when BANKR_EXECUTE=1 is explicitly set AND the triple gate
 *               passes (BANKR_API_KEY set && live /wallet/me address ==
 *               BANKR_WALLET, plus the wallet holds the currency the plan
 *               needs). With BANKR_EXECUTE=1 a FAILED gate REFUSES the target
 *               loudly (exit-3 semantics upstream) — it never silently
 *               downgrades to the Direct rail: the plan was decided for the
 *               custody wallet's identity and must never execute from the
 *               deployer key (the plan stamp enforces the same law in
 *               computeTxDiff). A mid-batch Bankr failure is a real (possibly
 *               PARTIAL) result and is never re-run on the other rail (no
 *               double-execution).
 *
 * ADVISORY (unchanged in spirit): when BANKR_API_KEY is set, ONE Agent-API
 * prompt summarizes the two-sided plan for a second opinion. On the free tier
 * the Agent API refuses AI prompts with 403 subscription_required (live-
 * captured fixture) — that exact case degrades to one honest line. Any Bankr
 * advisory failure is logged and swallowed; by default even a parsed "veto" is
 * recorded, not enforced (set BANKR_ADVISORY_BLOCKING=1 to enforce it).
 *
 * CLI: node executors/index.mjs --plan <plan.json> --target <gnosis|arbitrum> [--dry-run]
 */
import { readFileSync } from "node:fs";
import { createDirectExecutor, computeTxDiff } from "./direct.mjs";
import { createBankrExecutor, SUBSCRIPTION_DEGRADE_LINE } from "./bankr.mjs";
import { getTarget, targetRpcUrl } from "./targets.mjs";
import { jsonBigint, loadEnv } from "./chain.mjs";

/**
 * Build the executor set for a target (opts override for tests/forks).
 * Bankr's execution wiring reuses the Direct executor's OWN readState (bound to
 * the Bankr wallet via impersonate — balances/allowances read AS that wallet)
 * and pure computeTxDiff, so both rails produce the SAME tx list by
 * construction and the executor layer can never diverge from the policy.
 */
export function createExecutors({ target = "gnosis", direct = {}, bankr = {}, log = console.log } = {}) {
  loadEnv();
  const t = getTarget(target);
  const rpcUrl = targetRpcUrl(t);
  const addresses = t.addresses;

  // Direct is the ACTIVE rail on every target. In explicit custody mode
  // (BANKR_EXECUTE=1 on a bankr-capable target) the signing key is not
  // required at all — a keyless custody operator must not die in this
  // constructor; the missing-key reason is carried and only surfaces if the
  // direct rail is actually asked to run.
  let directExec = null;
  let directError = null;
  try {
    directExec = createDirectExecutor({ log, addresses, chain: t.chain, rpcUrl, ...direct });
  } catch (err) {
    directError = String(err?.message ?? err);
    if (!(t.executor === "bankr" && process.env.BANKR_EXECUTE === "1")) throw err;
    log(`direct executor unavailable (${directError}) — custody mode (BANKR_EXECUTE=1), continuing without the direct rail`);
  }

  let bankrWiring = {};
  const bankrWallet = process.env.BANKR_WALLET;
  if (t.executor === "bankr" && bankrWallet) {
    // A second Direct instance impersonating the Bankr wallet: read-only here
    // (state + simulation source); it never signs anything.
    const probe = createDirectExecutor({
      log,
      addresses,
      chain: t.chain,
      rpcUrl,
      impersonate: bankrWallet,
      ...direct,
    });
    bankrWiring = {
      target: t,
      publicClient: probe.publicClient,
      readState: probe.readState,
      buildTxs: (plan, state) => computeTxDiff(plan, state, { addresses }),
    };
  }
  const bankrExec = createBankrExecutor({ log, ...bankrWiring, ...bankr });
  if (!bankrExec.enabled) log(`bankr: disabled (${bankrExec.reason}) — proceeding Direct-only`);

  return { target: t, direct: directExec, directError, bankr: bankrExec };
}

/**
 * Execute a Plan against a target.
 * Returns { target, advisory, route: "bankr"|"direct", execution, direct, notified }.
 * `direct` is a back-compat alias of `execution` (run.mjs exit-code logic reads
 * result.direct.ok / .executed); `route` says which rail actually ran. PARTIAL
 * semantics are rail-independent: !execution.ok && execution.executed.length>0.
 */
export async function execute(plan, { target = "gnosis", dryRun = false, executors, signalsSummary = null, threadId, log = console.log } = {}) {
  const { target: t, direct, directError, bankr } = executors ?? createExecutors({ target, log });
  const result = { target: t.name, advisory: null, route: null, execution: null, direct: null, notified: null };

  // 1. Advisory second opinion — ONE Agent-API prompt on the two-sided plan
  //    (never blocking unless explicitly configured; paywall degrades to one line).
  if (bankr.enabled) {
    try {
      result.advisory = await bankr.advise(plan, signalsSummary ?? plan.rationale ?? [], threadId);
      if (result.advisory.degraded) {
        log(result.advisory.line ?? SUBSCRIPTION_DEGRADE_LINE);
      } else {
        log(`bankr advisory: ${result.advisory.ok ? result.advisory.verdict : `unavailable (${result.advisory.error})`}`);
      }
      if (result.advisory.ok && result.advisory.verdict === "veto" && process.env.BANKR_ADVISORY_BLOCKING === "1") {
        result.execution = { ok: false, executed: [], error: `blocked by Bankr advisory veto: ${result.advisory.summary}` };
        result.direct = result.execution;
        return result;
      }
    } catch (err) {
      // Belt and braces: advise() already never throws.
      result.advisory = { ok: false, error: String(err?.message ?? err) };
      log(`bankr advisory failed (${result.advisory.error}) — continuing`);
    }
  }

  // 2. Execution rail. Direct is the DEFAULT rail on every target (the Bankr
  //    custody rail is dormant/on hold). Custody runs only behind the explicit
  //    BANKR_EXECUTE=1 opt-in — and then a failed gate REFUSES the target
  //    loudly instead of silently downgrading to a different signing wallet
  //    (the gate is evaluated inside bankr.execute() BEFORE anything is
  //    submitted, so nothing has been spent when the refusal lands).
  const custodyOptIn = process.env.BANKR_EXECUTE === "1";
  if (t.executor === "bankr" && custodyOptIn) {
    if (bankr.enabled && bankr.canExecute) {
      const bres = await bankr.execute(plan, { dryRun });
      if (bres.gated) {
        const msg = `bankr custody opted in (BANKR_EXECUTE=1) but the gate failed: ${bres.error} — REFUSING ${t.name}; no direct fallback (a plan decided for the custody wallet never executes from another key — unset BANKR_EXECUTE and re-run to use the direct rail)`;
        log(msg);
        result.route = "refused";
        result.execution = { ok: false, refused: true, gated: true, executed: [], error: msg };
      } else {
        result.route = "bankr";
        result.execution = bres;
      }
    } else {
      const msg = `bankr custody opted in (BANKR_EXECUTE=1) but the bankr executor is ${bankr.enabled ? "not wired for execution on this target" : `disabled (${bankr.reason ?? "no key"})`} — REFUSING ${t.name}`;
      log(msg);
      result.route = "refused";
      result.execution = { ok: false, refused: true, executed: [], error: msg };
    }
  }
  if (!result.execution) {
    result.route = "direct";
    result.execution = direct
      ? await direct.execute(plan, { dryRun })
      : { ok: false, refused: true, executed: [], error: `direct executor unavailable: ${directError ?? "not constructed"}` };
  }
  result.direct = result.execution; // back-compat alias (see doc comment)

  // 3. Post-execution notification (never blocking, skipped on dry runs and
  //    when the advisory already hit the subscription paywall — same wall).
  if (bankr.enabled && !dryRun && !result.advisory?.subscriptionRequired) {
    try {
      const ex = result.execution;
      const summary = ex.ok
        ? `NY Rent Cover plan executed on ${t.name} via ${result.route}: ${ex.executed.map((x) => x.name).join("; ") || "no-op"}.`
        : `NY Rent Cover plan ${ex.executed?.length ? "PARTIAL" : "FAILED"} on ${t.name} via ${result.route} at "${ex.failed?.name ?? "?"}": ${ex.error}`;
      result.notified = await bankr.notify(summary, threadId);
    } catch (err) {
      log(`bankr post-execution notify failed (${err?.message ?? err}) — execution result stands`);
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
  const targetIdx = argv.indexOf("--target");
  // --target is MANDATORY: a plan file must never replay onto a defaulted
  // chain by omission (the plan stamp refuses mismatches, but the operator
  // should name the target explicitly too).
  if (planIdx === -1 || !argv[planIdx + 1] || targetIdx === -1 || !argv[targetIdx + 1]) {
    console.error("usage: node executors/index.mjs --plan <plan.json> --target <gnosis|arbitrum> [--dry-run]");
    process.exit(2);
  }
  const target = argv[targetIdx + 1];
  const plan = JSON.parse(readFileSync(argv[planIdx + 1], "utf8"));
  const result = await execute(plan, { target, dryRun });
  console.log(JSON.stringify(result, jsonBigint, 2));
  process.exit(result.execution?.ok ? 0 : 1);
}
