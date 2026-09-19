/**
 * Unit tests for bankr.mjs: pure request construction, verdict parsing, backoff,
 * the disabled (no BANKR_API_KEY) path, and the polling loop driven by an
 * injected fetch (the recorded response shapes come from docs.bankr.bot).
 *
 * LIVE API test: runs ONLY when BANKR_API_KEY is set in the environment. It is
 * not set in this repo/CI (no Bankr account is provisioned), so the live test
 * reports itself as skipped — recorded honestly rather than faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANKR_API_BASE,
  BANKR_LLM_BASE,
  buildAgentPromptRequest,
  buildJobStatusRequest,
  buildLlmChatRequest,
  buildAdvisoryPrompt,
  parseVerdict,
  nextPollDelay,
  createBankrExecutor,
} from "./bankr.mjs";

test("buildAgentPromptRequest: POST /agent/prompt with X-API-Key, body with/without threadId", () => {
  const r = buildAgentPromptRequest({ prompt: "hi", apiKey: "bk_test" });
  assert.equal(r.url, `${BANKR_API_BASE}/agent/prompt`);
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
  assert.equal(r.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(r.init.body), { prompt: "hi" });

  const r2 = buildAgentPromptRequest({ prompt: "hi", threadId: "thr_1", apiKey: "bk_test" });
  assert.deepEqual(JSON.parse(r2.init.body), { prompt: "hi", threadId: "thr_1" });
});

test("buildJobStatusRequest: GET /agent/job/{id} with X-API-Key", () => {
  const r = buildJobStatusRequest({ jobId: "job_42", apiKey: "bk_test" });
  assert.equal(r.url, `${BANKR_API_BASE}/agent/job/job_42`);
  assert.equal(r.init.method, "GET");
  assert.equal(r.init.headers["X-API-Key"], "bk_test");
});

test("buildLlmChatRequest: gateway URL, Bearer auth, model+messages body", () => {
  const messages = [{ role: "user", content: "check this plan" }];
  const r = buildLlmChatRequest({ messages, model: "claude-sonnet-4-5", llmKey: "llm_test" });
  assert.equal(r.url, `${BANKR_LLM_BASE}/v1/chat/completions`);
  assert.equal(r.init.headers.Authorization, "Bearer llm_test");
  assert.deepEqual(JSON.parse(r.init.body), { model: "claude-sonnet-4-5", messages });
});

test("buildAdvisoryPrompt: contains plan JSON (bigints stringified) + signals + schema", () => {
  const plan = { targetFreeCapitalWei: 100000000000000000n, newSeries: null, pause: false, rationale: ["r1"] };
  const p = buildAdvisoryPrompt(plan, "latest print 9288 cents");
  assert.ok(p.includes('"targetFreeCapitalWei": "100000000000000000"'));
  assert.ok(p.includes("latest print 9288 cents"));
  assert.ok(p.includes('"verdict":"approve"|"caution"|"veto"'));
  assert.ok(p.includes("cannot transact on")); // the no-Gnosis honesty is in the prompt itself
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

test("disabled path: no BANKR_API_KEY -> {enabled:false}, runner goes Direct-only", () => {
  const ex = createBankrExecutor({ apiKey: undefined });
  assert.equal(ex.enabled, false);
  assert.match(ex.reason, /BANKR_API_KEY/);
  assert.equal(ex.advise, undefined); // nothing callable on a disabled executor
});

test("disabled path holds for the ambient environment (no key provisioned here)", (t) => {
  if (process.env.BANKR_API_KEY) return t.skip("BANKR_API_KEY unexpectedly present");
  const ex = createBankrExecutor();
  assert.equal(ex.enabled, false);
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

  const http401 = createBankrExecutor({ apiKey: "bk_bad", fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal((await http401.agentPrompt("x")).ok, false);

  const network = createBankrExecutor({ apiKey: "bk_test", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  const nout = await network.agentPrompt("x");
  assert.equal(nout.ok, false);
  assert.match(nout.error, /ECONNRESET/);
});

test("advise: agent-api failure falls back to LLM gateway when llmKey present", async () => {
  const ex = createBankrExecutor({
    apiKey: "bk_test",
    llmKey: "llm_test",
    pollStartMs: 1,
    fetchImpl: async (url) => {
      if (url.startsWith(BANKR_API_BASE)) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ model: "m", choices: [{ message: { content: '{"verdict":"caution","concerns":["thin capital"],"summary":"careful"}' } }] }) };
    },
  });
  const out = await ex.advise({ targetFreeCapitalWei: 1n, newSeries: null, pause: null, rationale: [] }, "signals");
  assert.equal(out.ok, true);
  assert.equal(out.via, "llm-gateway");
  assert.equal(out.verdict, "caution");
});

test("mirrorOnBase: hard-gated on BANKR_MIRROR, and requires a newSeries", async () => {
  let prompted = null;
  const fakeFetch = async (url, init) => {
    if (url.endsWith("/agent/prompt")) {
      prompted = JSON.parse(init.body).prompt;
      return { ok: true, json: async () => ({ jobId: "job_3", status: "pending" }) };
    }
    return { ok: true, json: async () => ({ status: "completed", response: "done" }) };
  };
  const gated = createBankrExecutor({ apiKey: "bk_test", mirror: false, fetchImpl: fakeFetch });
  const g = await gated.mirrorOnBase({ newSeries: { strikeLowCents: 8900n, strikeHighCents: 9700n } });
  assert.equal(g.ok, false);
  assert.equal(g.skipped, true);
  assert.equal(prompted, null); // no API call was made

  const on = createBankrExecutor({ apiKey: "bk_test", mirror: true, fetchImpl: fakeFetch, pollStartMs: 1 });
  const noSeries = await on.mirrorOnBase({ newSeries: null });
  assert.equal(noSeries.skipped, true);
  const m = await on.mirrorOnBase({ newSeries: { strikeLowCents: 8900n, strikeHighCents: 9700n } });
  assert.equal(m.ok, true);
  assert.match(prompted, /On Base only/);
  assert.match(prompted, /8900/);
});

// ---------------------------------------------------------------------------
// LIVE — only with a real key. BANKR_API_KEY is NOT provisioned in this repo,
// so under normal runs this records an honest skip instead of pretending.
// ---------------------------------------------------------------------------
test("LIVE agentPrompt roundtrip (requires BANKR_API_KEY)", async (t) => {
  if (!process.env.BANKR_API_KEY) {
    return t.skip("BANKR_API_KEY not set — live Bankr call not exercised (recorded honestly)");
  }
  const ex = createBankrExecutor();
  const out = await ex.agentPrompt("Reply with the single word: pong");
  assert.equal(out.ok, true);
  assert.ok(typeof out.response === "string" && out.response.length > 0);
});
