/**
 * Unit tests for bankr.mjs: pure request construction, verdict parsing, backoff,
 * the subscription_required paywall degrade (against the LIVE-captured fixture),
 * the triple execution gate, and the custody execution pipeline driven by an
 * injected fetch + fake viem client (response shapes from docs.bankr.bot and
 * live captures 2026-09-19).
 *
 * LIVE test: GET /wallet/me runs whenever a real BANKR_API_KEY exists (repo
 * .env or env) — read-only, free-tier-safe (docs.bankr.bot/wallet-api/wallet-info).
 * Without a key it records an honest skip. NO live test ever submits a
 * transaction: the custody write path (/wallet/submit) is exercised only with
 * an injected fetch here and against an anvil fork in bankr-fork-proof.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  BANKR_API_BASE,
  BANKR_LLM_BASE,
  SUBSCRIPTION_DEGRADE_LINE,
  buildAgentPromptRequest,
  buildJobStatusRequest,
  buildWalletMeRequest,
  buildWalletSubmitRequest,
  buildLlmChatRequest,
  buildAdvisoryPrompt,
  parseVerdict,
  nextPollDelay,
  isSubscriptionRequired,
  planCurrencyNeedWei,
  createBankrExecutor,
} from "./bankr.mjs";
import { POOL_ABI, ERC20_ABI, getTarget } from "./targets.mjs";
import { loadEnv } from "./chain.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUBSCRIPTION_FIXTURE = JSON.parse(
  readFileSync(path.join(FIXTURES, "bankr-agent-prompt-subscription-required.json"), "utf8"),
);
const WALLET_ME_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURES, "bankr-wallet-me.json"), "utf8"));

const BANKR_WALLET = "0x1a7223bc942b053794e17b537e73d837cf695561";
const ARB = getTarget("arbitrum");

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

test("buildAgentPromptRequest: POST /agent/prompt with X-API-Key, body with/without threadId", () => {
  const r = buildAgentPromptRequest({ prompt: "hi", apiKey: "bk_test" });
  assert.equal(r.url, `${BANKR_API_BASE}/agent/prompt`);
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
  assert.equal(r.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(r.init.body), { prompt: "hi" });

  const r2 = buildAgentPromptRequest({ prompt: "hi", threadId: "thr_1", apiKey: "bk_test" });
  assert.deepEqual(JSON.parse(r2.init.body), { prompt: "hi", threadId: "thr_1" });

  const r3 = buildAgentPromptRequest({
    prompt: "review",
    maxModeModel: "gemini-3.1-pro",
    apiKey: "bk_test",
  });
  assert.deepEqual(JSON.parse(r3.init.body), {
    prompt: "review",
    maxMode: { enabled: true, model: "gemini-3.1-pro" },
  });
});

test("buildJobStatusRequest: GET /agent/job/{id} with X-API-Key", () => {
  const r = buildJobStatusRequest({ jobId: "job_42", apiKey: "bk_test" });
  assert.equal(r.url, `${BANKR_API_BASE}/agent/job/job_42`);
  assert.equal(r.init.method, "GET");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
});

test("buildWalletMeRequest: GET /wallet/me with X-API-Key", () => {
  const r = buildWalletMeRequest({ apiKey: "bk_test" });
  assert.equal(r.url, `${BANKR_API_BASE}/wallet/me`);
  assert.equal(r.init.method, "GET");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
});

test("buildWalletSubmitRequest: POST /wallet/submit per docs.bankr.bot/wallet-api/submit", () => {
  const r = buildWalletSubmitRequest({
    transaction: { to: ARB.pool, chainId: 42161, value: "0", data: "0xdeadbeef" },
    description: "test tx",
    apiKey: "bk_test",
  });
  assert.equal(r.url, `${BANKR_API_BASE}/wallet/submit`);
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
  const body = JSON.parse(r.init.body);
  assert.deepEqual(body.transaction, { to: ARB.pool, chainId: 42161, value: "0", data: "0xdeadbeef" });
  assert.equal(body.description, "test tx");
  assert.equal(body.waitForConfirmation, false); // we poll receipts ourselves
});

test("buildLlmChatRequest: gateway URL, Bearer auth, model+messages body", () => {
  const messages = [{ role: "user", content: "check this plan" }];
  const r = buildLlmChatRequest({ messages, model: "claude-sonnet-4-5", llmKey: "llm_test" });
  assert.equal(r.url, `${BANKR_LLM_BASE}/v1/chat/completions`);
  assert.equal(r.init.headers.Authorization, "Bearer llm_test");
  assert.deepEqual(JSON.parse(r.init.body), { model: "claude-sonnet-4-5", messages });
});

test("buildAdvisoryPrompt: two-sided framing + plan JSON (bigints stringified) + verdict schema", () => {
  const plan = { newSeries: { capacityWei: 1500000n }, buys: [{ seriesId: 3, maxPremiumWei: 11330n }], rationale: ["r1"] };
  const p = buildAdvisoryPrompt(plan, "latest print 9288 cents");
  assert.ok(p.includes('"capacityWei":"1500000"'));
  assert.ok(p.includes("latest print 9288 cents"));
  assert.ok(p.includes('"verdict":"approve"|"caution"|"veto"'));
  assert.ok(p.includes("SELLS protection")); // sell leg framing
  assert.ok(p.includes("BUYS")); // buy leg framing
  assert.ok(p.includes("advisory only")); // honesty is in the prompt itself
});

test("parseVerdict: inline JSON, fenced JSON, garbage", () => {
  assert.equal(parseVerdict('{"verdict":"approve","concerns":[],"summary":"ok"}').verdict, "approve");
  const fenced = parseVerdict('Sure!\n```json\n{"verdict":"veto","concerns":["strikes stale"],"summary":"no"}\n```');
  assert.equal(fenced.verdict, "veto");
  assert.deepEqual(fenced.concerns, ["strikes stale"]);
  assert.equal(parseVerdict("I think it looks fine").verdict, "unparsed");
  assert.equal(parseVerdict('{"verdict":"maybe"}').verdict, "unparsed"); // not in the enum
  assert.equal(parseVerdict("").verdict, "unparsed");
});

test("nextPollDelay: 2s start, x1.5 growth, 15s cap", () => {
  assert.equal(nextPollDelay(0), 2000);
  assert.equal(nextPollDelay(2000), 3000);
  assert.equal(nextPollDelay(3000), 4500);
  assert.equal(nextPollDelay(14000), 15000);
  assert.equal(nextPollDelay(15000), 15000);
});

// ---------------------------------------------------------------------------
// subscription_required — detection pinned to the LIVE-captured fixture
// ---------------------------------------------------------------------------

test("isSubscriptionRequired: matches the live-captured 403 shape EXACTLY", () => {
  assert.equal(SUBSCRIPTION_FIXTURE.status, 403);
  assert.equal(SUBSCRIPTION_FIXTURE.body.error, "subscription_required");
  assert.equal(isSubscriptionRequired(SUBSCRIPTION_FIXTURE.status, SUBSCRIPTION_FIXTURE.body), true);
  // near-misses do NOT degrade — they keep their own error text
  assert.equal(isSubscriptionRequired(403, { error: "Agent API access not enabled" }), false);
  assert.equal(isSubscriptionRequired(401, { error: "subscription_required" }), false);
  assert.equal(isSubscriptionRequired(403, null), false);
  assert.equal(isSubscriptionRequired(200, { error: "subscription_required" }), false);
});

test("agentPrompt: 403 subscription_required resolves { ok:false, subscriptionRequired:true }", async () => {
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => SUBSCRIPTION_FIXTURE.body }),
  });
  const out = await ex.agentPrompt("review");
  assert.equal(out.ok, false);
  assert.equal(out.subscriptionRequired, true);
  assert.match(out.error, /Bankr Club membership or Max Mode/);
});

test("advise: subscription_required degrades to ONE honest line, no gateway fallback", async () => {
  let llmCalls = 0;
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    llmKey: "llm_test", // present — must still NOT be tried (same paywall)
    fetchImpl: async (url) => {
      if (url.startsWith(BANKR_LLM_BASE)) {
        llmCalls += 1;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 403, json: async () => SUBSCRIPTION_FIXTURE.body };
    },
  });
  const out = await ex.advise({ newSeries: null, buys: [], rationale: [] }, "signals");
  assert.equal(out.ok, false);
  assert.equal(out.degraded, true);
  assert.equal(out.subscriptionRequired, true);
  assert.equal(out.line, SUBSCRIPTION_DEGRADE_LINE);
  assert.equal(llmCalls, 0);
});

test("advise: NON-subscription agent-api failure still falls back to LLM gateway", async () => {
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    llmKey: "llm_test",
    pollStartMs: 1,
    fetchImpl: async (url) => {
      if (url.startsWith(BANKR_API_BASE)) return { ok: false, status: 500, json: async () => ({ error: "internal" }) };
      return { ok: true, json: async () => ({ model: "m", choices: [{ message: { content: '{"verdict":"caution","concerns":["thin capital"],"summary":"careful"}' } }] }) };
    },
  });
  const out = await ex.advise({ newSeries: null, rationale: [] }, "signals");
  assert.equal(out.ok, true);
  assert.equal(out.via, "llm-gateway");
  assert.equal(out.verdict, "caution");
});

// ---------------------------------------------------------------------------
// Agent API plumbing (kept from the advisory era — still the advisory path)
// ---------------------------------------------------------------------------

test("disabled path: no BANKR_API_KEY -> {enabled:false}, runner goes Direct-only", () => {
  // null deliberately overrides any real BANKR_API_KEY present in the test
  // process; explicit undefined would trigger the constructor's env default.
  const ex = createBankrExecutor({ apiKey: null });
  assert.equal(ex.enabled, false);
  assert.match(ex.reason, /BANKR_API_KEY/);
  assert.equal(ex.advise, undefined); // nothing callable on a disabled executor
  assert.equal(ex.execute, undefined);
});

test("agentPrompt: polls to completion via injected fetch (docs.bankr.bot response shapes)", async () => {
  const calls = [];
  let polls = 0;
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/agent/prompt")) {
      return { ok: true, status: 202, json: async () => ({ success: true, jobId: "job_1", threadId: "thr_9", status: "pending" }) };
    }
    polls += 1;
    const status = polls < 3 ? (polls === 1 ? "pending" : "processing") : "completed";
    return { ok: true, status: 200, json: async () => ({ status, response: status === "completed" ? "LGTM" : null, threadId: "thr_9", processingTime: 1234 }) };
  };
  const ex = createBankrExecutor({ apiKey: "bk_test", fetchImpl: fakeFetch, pollStartMs: 1, timeoutMs: 5_000 });
  const out = await ex.agentPrompt("review", "thr_9");
  assert.equal(out.ok, true);
  assert.equal(out.status, "completed");
  assert.equal(out.response, "LGTM");
  assert.equal(out.threadId, "thr_9");
  assert.equal(calls[0].url, `${BANKR_API_BASE}/agent/prompt`);
  assert.equal(calls[1].url, `${BANKR_API_BASE}/agent/job/job_1`);
  assert.equal(polls, 3); // pending -> processing -> completed
});

test("agentPrompt: explicitly enables credit-backed Max Mode when configured", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/agent/prompt")) {
      return { ok: true, status: 202, json: async () => ({ jobId: "job_max", status: "pending" }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: "completed", response: "BANKR_POC_OK" }) };
  };
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    maxModeModel: "gemini-3.1-pro",
    fetchImpl: fakeFetch,
    pollStartMs: 1,
    timeoutMs: 5_000,
  });
  const out = await ex.agentPrompt("read-only POC");
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body).maxMode, {
    enabled: true,
    model: "gemini-3.1-pro",
  });
});

test("agentPrompt: failed job and HTTP errors resolve to {ok:false} — never throw", async () => {
  const failJob = createBankrExecutor({
    apiKey: "bk_test",
    pollStartMs: 1,
    fetchImpl: async (url) =>
      url.endsWith("/agent/prompt")
        ? { ok: true, json: async () => ({ jobId: "job_2", status: "pending" }) }
        : { ok: true, json: async () => ({ status: "failed", response: null }) },
  });
  const out = await failJob.agentPrompt("x");
  assert.equal(out.ok, false);
  assert.equal(out.status, "failed");

  const http401 = createBankrExecutor({ apiKey: "bk_bad", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "Authentication required" }) }) });
  assert.equal((await http401.agentPrompt("x")).ok, false);

  const network = createBankrExecutor({ apiKey: "bk_test", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  const nout = await network.agentPrompt("x");
  assert.equal(nout.ok, false);
  assert.match(nout.error, /ECONNRESET/);
});

test("walletMe: parses the live-captured /wallet/me shape", async () => {
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => WALLET_ME_FIXTURE.body }),
  });
  const out = await ex.walletMe();
  assert.equal(out.ok, true);
  assert.equal(out.evmAddress.toLowerCase(), BANKR_WALLET);
  assert.equal(out.bankrClub.active, false); // free tier — exactly why advisory degrades
});

// ---------------------------------------------------------------------------
// Execution: currency need, triple gate, custody pipeline
// ---------------------------------------------------------------------------

const NOW = 1_789_700_000n;
const SERIES_ARGS = [9288, 10088, 1133, NOW + 14n * 86400n, NOW + 14n * 86400n, NOW + 44n * 86400n, NOW + 74n * 86400n, 1_500_000n];

/** Descriptor txs in the exact shape computeTxDiff emits (name/address/abi/functionName/args/value). */
function sampleTxs() {
  return [
    { name: "approve pool for exactly 1.51133 USDC", address: ARB.currency.address, abi: ERC20_ABI, functionName: "approve", args: [ARB.pool, 1_511_330n], value: 0n },
    { name: "createSeries(9288/10088, 1133 bps, capacity 1.5 USDC)", address: ARB.pool, abi: POOL_ABI, functionName: "createSeries", args: SERIES_ARGS, value: 0n },
    { name: "buyProtectionFor(3, 0.1 USDC, max 0.011330 USDC)", address: ARB.pool, abi: POOL_ABI, functionName: "buyProtectionFor", args: [3n, 100_000n, 11_330n, BANKR_WALLET], value: 0n },
  ];
}

test("planCurrencyNeedWei: sums escrow + premium pulls, ignores approve/pause/cancel/withdrawResidual", () => {
  const txs = [
    ...sampleTxs(),
    { functionName: "addCapacity", args: [0n, 250_000n] },
    { functionName: "setSeriesPaused", args: [0n, true] },
    { functionName: "cancelSeries", args: [0n] },
    { functionName: "withdrawResidual", args: [0n] },
  ];
  // createSeries capacity 1_500_000 + buy maxPremium 11_330 + addCapacity 250_000
  assert.equal(planCurrencyNeedWei(txs), 1_761_330n);
  assert.equal(planCurrencyNeedWei([]), 0n);
});

/** Wired executor with injectable behaviors; defaults model the happy path. */
function wiredExecutor({
  executeEnabled = true,
  expectedWallet = BANKR_WALLET,
  meAddress = BANKR_WALLET,
  balance = 10_000_000n, // 10 USDC
  txs = sampleTxs(),
  submitResponses = null, // array of {ok,status,body} consumed per submit; null => always success
  receiptStatus = "success",
  simulateFail = null, // functionName that should throw on simulateContract
  log = () => {},
} = {}) {
  const calls = { simulate: [], submit: [], me: 0, receipts: [] };
  let submitN = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/wallet/me")) {
      calls.me += 1;
      return { ok: true, status: 200, json: async () => ({ success: true, wallets: [{ chain: "evm", address: meAddress }] }) };
    }
    if (url.endsWith("/wallet/submit")) {
      calls.submit.push(JSON.parse(init.body));
      const scripted = submitResponses?.[submitN++];
      if (scripted) return { ok: scripted.ok, status: scripted.status, json: async () => scripted.body };
      return { ok: true, status: 200, json: async () => ({ success: true, transactionHash: `0xhash${calls.submit.length}` }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const publicClient = {
    simulateContract: async (req) => {
      calls.simulate.push({ functionName: req.functionName, account: req.account });
      if (simulateFail && req.functionName === simulateFail) throw new Error(`simulated revert in ${req.functionName}`);
      return { request: req };
    },
    waitForTransactionReceipt: async ({ hash }) => {
      calls.receipts.push(hash);
      return { status: receiptStatus, blockNumber: 123n, gasUsed: 100_000n, effectiveGasPrice: 10_000_000n };
    },
    readContract: async ({ functionName }) => {
      if (functionName === "balanceOf") return balance;
      throw new Error(`unexpected readContract ${functionName}`);
    },
  };
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    fetchImpl,
    log,
    target: ARB,
    publicClient,
    readState: async () => ({ fake: true }),
    buildTxs: () => ({ txs, notes: [] }),
    executeEnabled,
    expectedWallet,
  });
  return { ex, calls };
}

test("checkExecutionGate: every gate failure is reported; all-pass passes", async () => {
  // (b) BANKR_EXECUTE not opted in
  let { ex } = wiredExecutor({ executeEnabled: false });
  let g = await ex.checkExecutionGate();
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(" "), /BANKR_EXECUTE/);

  // no expected wallet configured (null: undefined would hit the env default)
  ({ ex } = wiredExecutor({ expectedWallet: null }));
  g = await ex.checkExecutionGate();
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(" "), /BANKR_WALLET not set/);

  // (c) live /wallet/me identity mismatch
  ({ ex } = wiredExecutor({ meAddress: "0x000000000000000000000000000000000000dEaD" }));
  g = await ex.checkExecutionGate();
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(" "), /!= expected BANKR_WALLET/);

  // funds: wallet cannot cover the plan's pulls
  ({ ex } = wiredExecutor({ balance: 5n }));
  g = await ex.checkExecutionGate({ requiredCurrencyWei: 1_511_330n });
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(" "), /needs 1\.51133 USDC/);

  // all pass
  ({ ex } = wiredExecutor());
  g = await ex.checkExecutionGate({ requiredCurrencyWei: 1_511_330n });
  assert.equal(g.pass, true);
  assert.deepEqual(g.reasons, []);
  assert.equal(g.evmAddress.toLowerCase(), BANKR_WALLET);
});

test("execute: unwired executor refuses (advisory-only)", async () => {
  const ex = createBankrExecutor({ apiKey: "bk_test", fetchImpl: async () => { throw new Error("no network expected"); } });
  assert.equal(ex.canExecute, false);
  const out = await ex.execute({ anything: true });
  assert.equal(out.ok, false);
  assert.match(out.error, /not wired/);
});

test("execute: gate failure returns gated:true BEFORE anything is submitted", async () => {
  const { ex, calls } = wiredExecutor({ executeEnabled: false });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.gated, true);
  assert.match(out.error, /BANKR_EXECUTE/);
  assert.equal(calls.submit.length, 0);
  assert.deepEqual(out.executed, []);
});

test("execute dryRun: gate + from-override simulation, NOTHING submitted", async () => {
  const { ex, calls } = wiredExecutor();
  const out = await ex.execute({}, { dryRun: true });
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.txs.length, 3);
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.receipts.length, 0);
  // simulated AS the Bankr wallet (from-override)
  assert.ok(calls.simulate.length >= 1);
  for (const s of calls.simulate) assert.equal(s.account, BANKR_WALLET);
  assert.equal(out.requiredCurrencyWei, 1_511_330n);
  assert.equal(out.txs[0].abi, undefined); // abi objects stripped from the report
});

test("execute live: simulate -> /wallet/submit -> receipt for every tx, in order", async () => {
  const { ex, calls } = wiredExecutor();
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, true);
  assert.equal(out.executed.length, 3);
  assert.deepEqual(calls.simulate.map((s) => s.functionName), ["approve", "createSeries", "buyProtectionFor"]);
  // submit bodies exactly per docs.bankr.bot/wallet-api/submit
  assert.equal(calls.submit.length, 3);
  for (const body of calls.submit) {
    assert.equal(body.transaction.chainId, 42161);
    assert.equal(body.transaction.value, "0");
    assert.match(body.transaction.data, /^0x[0-9a-f]+$/i); // encoded calldata
    assert.equal(body.waitForConfirmation, false);
    assert.match(body.description, /^nyrent-cover agent: /);
  }
  assert.equal(calls.submit[0].transaction.to, ARB.currency.address);
  assert.equal(calls.submit[1].transaction.to, ARB.pool);
  // receipts polled per hash; executed entries carry hash/link/via
  assert.deepEqual(calls.receipts, ["0xhash1", "0xhash2", "0xhash3"]);
  for (const e of out.executed) {
    assert.equal(e.via, "bankr");
    assert.match(e.link, /arbitrum\.blockscout\.com\/tx\/0xhash/);
    assert.equal(e.gasUsed, 100_000n);
  }
});

test("execute PARTIAL: account-rail rejection mid-batch aborts with landed txs listed (exit-4 semantics)", async () => {
  const { ex, calls } = wiredExecutor({
    submitResponses: [
      null, // tx1: default success
      { ok: false, status: 403, body: { error: "Per-transaction limit exceeded", errorCode: "PER_TX_LIMIT_EXCEEDED", message: "This transaction is $2,400.00, above your per-transaction limit of $500." } },
    ].map((r) => r ?? { ok: true, status: 200, body: { success: true, transactionHash: "0xhash1" } }),
  });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.executed.length, 1); // first tx LANDED — partial, not clean failure
  assert.equal(out.executed[0].hash, "0xhash1");
  assert.match(out.failed.name, /createSeries/);
  assert.match(out.error, /PER_TX_LIMIT_EXCEEDED/);
  assert.equal(calls.submit.length, 2); // third tx never attempted
});

test("execute PARTIAL: pre-submit simulation failure aborts without submitting that tx", async () => {
  const { ex, calls } = wiredExecutor({ simulateFail: "createSeries" });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.executed.length, 1);
  assert.match(out.failed.name, /createSeries/);
  assert.equal(calls.submit.length, 1); // only the approve went through /wallet/submit
});

test("execute: reverted receipt aborts with the tx hash in failed", async () => {
  const { ex } = wiredExecutor({ receiptStatus: "reverted" });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, false);
  assert.equal(out.failed.hash, "0xhash1");
  assert.match(out.error, /reverted on-chain/);
  assert.equal(out.executed.length, 0);
});

test("execute: invalid plan (buildTxs throws) dies locally, nothing sent", async () => {
  const calls = { submit: 0 };
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    fetchImpl: async (url) => {
      if (url.endsWith("/wallet/submit")) calls.submit += 1;
      return { ok: true, status: 200, json: async () => ({ success: true, wallets: [{ chain: "evm", address: BANKR_WALLET }] }) };
    },
    log: () => {},
    target: ARB,
    publicClient: {},
    readState: async () => ({}),
    buildTxs: () => {
      throw new Error("plan.newSeries.capacity out of range");
    },
    executeEnabled: true,
    expectedWallet: BANKR_WALLET,
  });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, false);
  assert.match(out.error, /invalid plan/);
  assert.equal(calls.submit, 0);
});

test("execute: empty tx list is an honest no-op", async () => {
  const { ex, calls } = wiredExecutor({ txs: [] });
  const out = await ex.execute({}, { dryRun: false });
  assert.equal(out.ok, true);
  assert.deepEqual(out.executed, []);
  assert.match(out.summary, /no-op/);
  assert.equal(calls.me, 0); // no gate check needed for a no-op
});

// ---------------------------------------------------------------------------
// LIVE — read-only, free-tier-safe. Runs whenever a real key exists (repo .env
// is gitignored, so CI records an honest skip). NEVER submits a transaction.
// ---------------------------------------------------------------------------
test("LIVE GET /wallet/me: identity matches BANKR_WALLET (read-only, no tx)", async (t) => {
  loadEnv(); // repo-root .env (gitignored) — same loader the runner uses
  if (!process.env.BANKR_API_KEY) {
    return t.skip("BANKR_API_KEY not set — live Bankr read not exercised (recorded honestly)");
  }
  const ex = createBankrExecutor();
  const out = await ex.walletMe();
  assert.equal(out.ok, true, `walletMe failed: ${out.error}`);
  if (process.env.BANKR_WALLET) {
    assert.equal(out.evmAddress.toLowerCase(), process.env.BANKR_WALLET.toLowerCase());
  }
});
