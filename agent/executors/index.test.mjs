/**
 * Unit tests for index.mjs: per-target executor construction and routing.
 * Injected fake executors only — no network, no keys. The real-chain proof of
 * the Bankr custody pipeline lives in bankr-fork-proof.mjs (anvil fork of
 * Arbitrum mainnet); the Direct pipeline's proof lives in fork-proof.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutors, execute } from "./index.mjs";
import { getTarget } from "./targets.mjs";
import { SUBSCRIPTION_DEGRADE_LINE } from "./bankr.mjs";

const BANKR_WALLET = "0x1a7223bc942b053794e17b537e73d837cf695561";
const GNOSIS = getTarget("gnosis");
const ARBITRUM = getTarget("arbitrum");

function fakeDirect(result = { ok: true, executed: [{ name: "direct-acted" }] }) {
  const calls = [];
  return {
    calls,
    exec: {
      name: "direct",
      enabled: true,
      execute: async (plan, opts) => {
        calls.push({ plan, opts });
        return result;
      },
    },
  };
}

function fakeBankr({
  enabled = true,
  canExecute = true,
  adviseResult = { ok: true, verdict: "approve", concerns: [], summary: "fine" },
  executeResult = { ok: true, executed: [{ name: "bankr-acted", via: "bankr" }] },
} = {}) {
  const calls = { advise: [], execute: [], notify: [] };
  return {
    calls,
    exec: {
      name: "bankr",
      enabled,
      canExecute,
      advise: async (...a) => {
        calls.advise.push(a);
        return adviseResult;
      },
      execute: async (plan, opts) => {
        calls.execute.push({ plan, opts });
        return executeResult;
      },
      notify: async (text) => {
        calls.notify.push(text);
        return { ok: true };
      },
    },
  };
}

const PLAN = { newSeries: null, buys: [], rationale: ["r"] };

/** Run fn with BANKR_EXECUTE set/unset, restoring the previous value. */
async function withBankrExecute(value, fn) {
  const prev = process.env.BANKR_EXECUTE;
  if (value === undefined) delete process.env.BANKR_EXECUTE;
  else process.env.BANKR_EXECUTE = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BANKR_EXECUTE;
    else process.env.BANKR_EXECUTE = prev;
  }
}

test("routing: gnosis ALWAYS goes Direct — bankr.execute is never consulted", async () => {
  const d = fakeDirect();
  const b = fakeBankr(); // enabled + canExecute — must still not run on Gnosis
  const result = await execute(PLAN, {
    dryRun: true,
    executors: { target: GNOSIS, direct: d.exec, bankr: b.exec },
    log: () => {},
  });
  assert.equal(result.route, "direct");
  assert.equal(d.calls.length, 1);
  assert.equal(b.calls.execute.length, 0);
  assert.equal(b.calls.advise.length, 1); // advisory still runs
  assert.equal(result.direct, result.execution); // back-compat alias
});

test("routing: arbitrum DEFAULTS to Direct — Bankr custody is dormant without BANKR_EXECUTE=1", async () => {
  await withBankrExecute(undefined, async () => {
    const d = fakeDirect();
    const b = fakeBankr(); // enabled + wired — must still stay dormant
    const result = await execute(PLAN, {
      dryRun: false,
      executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec },
      log: () => {},
    });
    assert.equal(result.route, "direct");
    assert.equal(d.calls.length, 1);
    assert.equal(b.calls.execute.length, 0, "the custody rail is never consulted while dormant");
  });
});

test("routing: BANKR_EXECUTE=1 runs Bankr custody when the gate passes", async () => {
  await withBankrExecute("1", async () => {
    const d = fakeDirect();
    const b = fakeBankr();
    const result = await execute(PLAN, {
      dryRun: false,
      executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec },
      log: () => {},
    });
    assert.equal(result.route, "bankr");
    assert.equal(b.calls.execute.length, 1);
    assert.equal(d.calls.length, 0); // Direct never touched
    assert.equal(result.execution.executed[0].name, "bankr-acted");
    assert.equal(b.calls.notify.length, 1); // post-execution notification
  });
});

test("routing: with BANKR_EXECUTE=1 a FAILED gate REFUSES the target — never a silent Direct downgrade", async () => {
  await withBankrExecute("1", async () => {
    const logs = [];
    const d = fakeDirect();
    const b = fakeBankr({ executeResult: { ok: false, gated: true, error: "bankr execution gate failed: wallet identity unverified", executed: [] } });
    const result = await execute(PLAN, {
      dryRun: false,
      executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec },
      log: (m) => logs.push(String(m)),
    });
    assert.equal(result.route, "refused");
    assert.equal(b.calls.execute.length, 1);
    assert.equal(d.calls.length, 0, "the money must NEVER reroute to a different signing wallet");
    assert.equal(result.execution.ok, false);
    assert.equal(result.execution.executed.length, 0, "nothing sent — exit 3 semantics upstream");
    assert.match(result.execution.error, /REFUSING/);
    assert.ok(logs.some((l) => l.includes("REFUSING")));
  });
});

test("routing: with BANKR_EXECUTE=1 but bankr disabled/unwired the target REFUSES too", async () => {
  await withBankrExecute("1", async () => {
    const d = fakeDirect();
    const disabled = { name: "bankr", enabled: false, reason: "BANKR_API_KEY not set" };
    const r1 = await execute(PLAN, { dryRun: false, executors: { target: ARBITRUM, direct: d.exec, bankr: disabled }, log: () => {} });
    assert.equal(r1.route, "refused");
    assert.match(r1.execution.error, /disabled/);
    const b = fakeBankr({ canExecute: false });
    const r2 = await execute(PLAN, { dryRun: false, executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec }, log: () => {} });
    assert.equal(r2.route, "refused");
    assert.equal(d.calls.length, 0);
  });
});

test("routing: a NON-gated bankr failure (incl. PARTIAL) is final — never re-run on Direct", async () => {
  await withBankrExecute("1", async () => {
    const d = fakeDirect();
    const partial = { ok: false, executed: [{ name: "approve", hash: "0x1" }], failed: { name: "createSeries" }, error: "createSeries reverted on-chain" };
    const b = fakeBankr({ executeResult: partial });
    const result = await execute(PLAN, {
      dryRun: false,
      executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec },
      log: () => {},
    });
    assert.equal(result.route, "bankr");
    assert.equal(d.calls.length, 0); // NO double-execution
    // PARTIAL semantics identical to direct: !ok && executed.length > 0 (exit 4 upstream)
    assert.equal(result.execution.ok, false);
    assert.equal(result.execution.executed.length, 1);
  });
});

test("routing: arbitrum without execution wiring (canExecute=false, custody dormant) goes Direct", async () => {
  await withBankrExecute(undefined, async () => {
    const d = fakeDirect();
    const b = fakeBankr({ canExecute: false });
    const result = await execute(PLAN, {
      dryRun: true,
      executors: { target: ARBITRUM, direct: d.exec, bankr: b.exec },
      log: () => {},
    });
    assert.equal(result.route, "direct");
    assert.equal(b.calls.execute.length, 0);
  });
});

test("advisory: subscription_required degrades to the ONE honest line; execution proceeds; notify skipped", async () => {
  const logs = [];
  const d = fakeDirect();
  const b = fakeBankr({
    canExecute: false,
    adviseResult: { ok: false, degraded: true, subscriptionRequired: true, line: SUBSCRIPTION_DEGRADE_LINE },
  });
  const result = await execute(PLAN, {
    dryRun: false,
    executors: { target: GNOSIS, direct: d.exec, bankr: b.exec },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(logs.filter((l) => l === SUBSCRIPTION_DEGRADE_LINE).length, 1); // exactly once
  assert.equal(result.execution.ok, true); // advisory never blocks
  assert.equal(b.calls.notify.length, 0); // same paywall — not retried
});

test("advisory: veto is recorded, not enforced by default; BANKR_ADVISORY_BLOCKING=1 enforces it", async () => {
  const veto = { ok: true, verdict: "veto", concerns: ["x"], summary: "do not act" };

  const d1 = fakeDirect();
  const r1 = await execute(PLAN, {
    dryRun: false,
    executors: { target: GNOSIS, direct: d1.exec, bankr: fakeBankr({ adviseResult: veto }).exec },
    log: () => {},
  });
  assert.equal(d1.calls.length, 1); // default: recorded, not enforced
  assert.equal(r1.advisory.verdict, "veto");

  const prev = process.env.BANKR_ADVISORY_BLOCKING;
  process.env.BANKR_ADVISORY_BLOCKING = "1";
  try {
    const d2 = fakeDirect();
    const r2 = await execute(PLAN, {
      dryRun: false,
      executors: { target: GNOSIS, direct: d2.exec, bankr: fakeBankr({ adviseResult: veto }).exec },
      log: () => {},
    });
    assert.equal(d2.calls.length, 0);
    assert.equal(r2.execution.ok, false);
    assert.match(r2.execution.error, /advisory veto/);
  } finally {
    if (prev === undefined) delete process.env.BANKR_ADVISORY_BLOCKING;
    else process.env.BANKR_ADVISORY_BLOCKING = prev;
  }
});

test("advisory: disabled bankr (no key) means no advisory and Direct-only", async () => {
  const d = fakeDirect();
  const result = await execute(PLAN, {
    dryRun: true,
    executors: { target: GNOSIS, direct: d.exec, bankr: { name: "bankr", enabled: false, reason: "BANKR_API_KEY not set" } },
    log: () => {},
  });
  assert.equal(result.advisory, null);
  assert.equal(result.route, "direct");
});

// ---------------------------------------------------------------------------
// createExecutors — real constructors, no network calls at build time
// ---------------------------------------------------------------------------

test("createExecutors: per-target addresses/chain wiring (impersonate: no key needed)", () => {
  // apiKey: null — undefined would fall through to the env/.env default
  const g = createExecutors({ target: "gnosis", direct: { impersonate: BANKR_WALLET }, bankr: { apiKey: null }, log: () => {} });
  assert.equal(g.target.name, "gnosis");
  assert.equal(g.direct.addresses.pool, GNOSIS.pool);
  assert.equal(g.bankr.enabled, false);

  const a = createExecutors({ target: "arbitrum", direct: { impersonate: BANKR_WALLET }, bankr: { apiKey: null }, log: () => {} });
  assert.equal(a.target.name, "arbitrum");
  assert.equal(a.direct.addresses.pool, ARBITRUM.pool);
});

test("createExecutors: bankr execution wiring exists on arbitrum, NOT on gnosis", () => {
  const prev = process.env.BANKR_WALLET;
  process.env.BANKR_WALLET = BANKR_WALLET;
  try {
    const a = createExecutors({ target: "arbitrum", direct: { impersonate: BANKR_WALLET }, bankr: { apiKey: "bk_test" }, log: () => {} });
    assert.equal(a.bankr.enabled, true);
    assert.equal(a.bankr.canExecute, true); // wired: target+publicClient+readState+buildTxs

    const g = createExecutors({ target: "gnosis", direct: { impersonate: BANKR_WALLET }, bankr: { apiKey: "bk_test" }, log: () => {} });
    assert.equal(g.bankr.enabled, true);
    assert.equal(g.bankr.canExecute, false); // Gnosis: advisory-only, never custody
  } finally {
    if (prev === undefined) delete process.env.BANKR_WALLET;
    else process.env.BANKR_WALLET = prev;
  }
});

test("createExecutors: unknown target throws", () => {
  assert.throws(() => createExecutors({ target: "base", log: () => {} }), /unknown target/);
});
