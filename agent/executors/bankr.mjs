/**
 * bankr.mjs — real Bankr API client (docs.bankr.bot) used as an ADVISORY executor.
 *
 * ============================  ROLE — READ THIS  ============================
 * Bankr supports Base, Ethereum, Polygon, Unichain, World Chain, Arbitrum, BNB,
 * Robinhood Chain, Arc, Solana and Hyperliquid. Gnosis (chainId 100) is NOT
 * supported anywhere in Bankr, and CoverPool's sponsor is immutable, so a
 * Bankr-custodied wallet can NEVER operate this deployment. Bankr therefore
 * never touches the CoverPool. Its honest jobs here are:
 *   1. advisory second opinion on the Plan (advise): plan + signals summary in,
 *      structured verdict out — it may flag/veto, it never originates numbers;
 *   2. operator notification (notify) after Direct execution;
 *   3. OPTIONAL tiny mirrored position on Base (mirrorOnBase), double-gated on
 *      BANKR_API_KEY being set AND an explicit BANKR_MIRROR=1.
 * A Bankr failure must NEVER block Direct execution: every public method
 * resolves to { ok:false, error } instead of throwing.
 * ===========================================================================
 *
 * API surface used (verified against docs.bankr.bot 2026-09-18):
 *   POST https://api.bankr.bot/agent/prompt   {prompt, threadId?}  hdr X-API-Key
 *        -> 202 {jobId, threadId, status:"pending"}
 *   GET  https://api.bankr.bot/agent/job/{id}                      hdr X-API-Key
 *        -> {status: pending|processing|completed|failed|cancelled, response, ...}
 *   LLM Gateway: POST https://llm.bankr.bot/v1/chat/completions (OpenAI-compatible,
 *        Authorization: Bearer $BANKR_LLM_KEY — separate credit-funded key).
 */
import { jsonBigint } from "./chain.mjs";

export const BANKR_API_BASE = "https://api.bankr.bot";
export const BANKR_LLM_BASE = "https://llm.bankr.bot";
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-5"; // override with BANKR_LLM_MODEL

// ---------------------------------------------------------------------------
// Pure request builders (unit-tested without any network)
// ---------------------------------------------------------------------------

export function buildAgentPromptRequest({ prompt, threadId, apiKey, base = BANKR_API_BASE }) {
  const body = threadId ? { prompt, threadId } : { prompt };
  return {
    url: `${base}/agent/prompt`,
    init: {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

export function buildJobStatusRequest({ jobId, apiKey, base = BANKR_API_BASE }) {
  return {
    url: `${base}/agent/job/${jobId}`,
    init: { method: "GET", headers: { "X-API-Key": apiKey } },
  };
}

export function buildLlmChatRequest({ messages, model, llmKey, base = BANKR_LLM_BASE }) {
  return {
    url: `${base}/v1/chat/completions`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${llmKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages }),
    },
  };
}

/** Advisory prompt: full plan + signals, verdict constrained to a JSON schema. */
export function buildAdvisoryPrompt(plan, signalsSummary) {
  return [
    "You are a risk reviewer for an on-chain rent-protection pool on Gnosis Chain (which you",
    "cannot transact on — this is advisory only). A deterministic policy produced the Plan",
    "below from the Signals below. Review it for consistency: strikes vs the latest printed",
    "rent, premium vs signal dispersion, capital sizing, and pause logic.",
    "Respond with ONLY a JSON object, no prose around it:",
    '{"verdict":"approve"|"caution"|"veto","concerns":["..."],"summary":"one sentence"}',
    "",
    "PLAN:",
    JSON.stringify(plan, jsonBigint, 2),
    "",
    "SIGNALS:",
    typeof signalsSummary === "string" ? signalsSummary : JSON.stringify(signalsSummary, jsonBigint, 2),
  ].join("\n");
}

/** Extract the structured verdict from a model/agent reply (fenced or inline JSON). */
export function parseVerdict(text) {
  if (typeof text !== "string" || text.length === 0) return { verdict: "unparsed", raw: text ?? null };
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj.verdict === "string" && ["approve", "caution", "veto"].includes(obj.verdict)) {
        return { verdict: obj.verdict, concerns: Array.isArray(obj.concerns) ? obj.concerns.map(String) : [], summary: String(obj.summary ?? "") };
      }
    } catch {
      /* try next candidate */
    }
  }
  return { verdict: "unparsed", raw: text };
}

/** Poll backoff: 2s, ×1.5 per attempt, capped at 15s (pure, unit-tested). */
export function nextPollDelay(prevMs) {
  if (!prevMs || prevMs <= 0) return 2_000;
  return Math.min(Math.round(prevMs * 1.5), 15_000);
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * createBankrExecutor(opts) -> executor. Without a BANKR_API_KEY the constructor
 * returns { enabled:false, reason } and the runner proceeds Direct-only.
 *
 * opts: apiKey, llmKey, mirror (bool), apiBase, llmBase, model,
 *       fetchImpl (injectable for unit tests), pollStartMs, timeoutMs, log
 */
export function createBankrExecutor({
  apiKey = process.env.BANKR_API_KEY,
  llmKey = process.env.BANKR_LLM_KEY,
  mirror = process.env.BANKR_MIRROR === "1",
  apiBase = BANKR_API_BASE,
  llmBase = BANKR_LLM_BASE,
  model = process.env.BANKR_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  fetchImpl = fetch,
  pollStartMs = 2_000,
  timeoutMs = 180_000,
  log = console.log,
} = {}) {
  if (!apiKey) {
    return { name: "bankr", enabled: false, reason: "BANKR_API_KEY not set" };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** POST /agent/prompt then poll GET /agent/job/{id} with backoff to a terminal state. */
  async function agentPrompt(text, threadId) {
    try {
      const { url, init } = buildAgentPromptRequest({ prompt: text, threadId, apiKey, base: apiBase });
      const res = await fetchImpl(url, init);
      if (!res.ok) return { ok: false, error: `POST /agent/prompt -> HTTP ${res.status}` };
      const job = await res.json();
      if (!job.jobId) return { ok: false, error: `POST /agent/prompt: no jobId in response` };

      const deadline = Date.now() + timeoutMs;
      let delay = pollStartMs;
      let last = job;
      while (Date.now() < deadline) {
        await sleep(delay);
        delay = nextPollDelay(delay);
        const { url: ju, init: ji } = buildJobStatusRequest({ jobId: job.jobId, apiKey, base: apiBase });
        const jres = await fetchImpl(ju, ji);
        if (!jres.ok) return { ok: false, error: `GET /agent/job/${job.jobId} -> HTTP ${jres.status}`, jobId: job.jobId };
        last = await jres.json();
        if (TERMINAL.has(last.status)) {
          return {
            ok: last.status === "completed",
            status: last.status,
            response: last.response ?? null,
            jobId: job.jobId,
            threadId: last.threadId ?? job.threadId ?? threadId ?? null,
            processingTime: last.processingTime ?? null,
            ...(last.status === "completed" ? {} : { error: `job ${last.status}` }),
          };
        }
      }
      return { ok: false, error: `job ${job.jobId} did not reach a terminal state within ${timeoutMs}ms`, jobId: job.jobId, status: last.status };
    } catch (err) {
      return { ok: false, error: `agentPrompt: ${err?.message ?? err}` };
    }
  }

  /** One-shot chat call against Bankr's LLM Gateway (llm.bankr.bot, separate key). */
  async function llmChat(messages) {
    if (!llmKey) return { ok: false, error: "BANKR_LLM_KEY not set" };
    try {
      const { url, init } = buildLlmChatRequest({ messages, model, llmKey, base: llmBase });
      const res = await fetchImpl(url, init);
      if (!res.ok) return { ok: false, error: `LLM gateway -> HTTP ${res.status}` };
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? null;
      return { ok: content !== null, content, model: data?.model ?? model, ...(content === null ? { error: "no content in gateway response" } : {}) };
    } catch (err) {
      return { ok: false, error: `llmChat: ${err?.message ?? err}` };
    }
  }

  /**
   * Advisory second opinion on the Plan. Tries the Agent API (threadId = running
   * memory); if that fails and an LLM Gateway key exists, falls back to a plain
   * gateway chat. Always resolves; never throws.
   */
  async function advise(plan, signalsSummary, threadId) {
    const prompt = buildAdvisoryPrompt(plan, signalsSummary);
    let via = "agent-api";
    let out = await agentPrompt(prompt, threadId);
    if (!out.ok && llmKey) {
      via = "llm-gateway";
      const chat = await llmChat([{ role: "user", content: prompt }]);
      out = chat.ok ? { ok: true, response: chat.content } : { ok: false, error: `${out.error}; gateway fallback: ${chat.error}` };
    }
    if (!out.ok) return { ok: false, error: out.error, via };
    return { ok: true, via, threadId: out.threadId ?? threadId ?? null, ...parseVerdict(out.response) };
  }

  /** Operator notification through the Bankr agent (advisory channel, not execution). */
  async function notify(text, threadId) {
    return agentPrompt(`Operator notification (no trade needed unless asked): ${text}`, threadId);
  }

  /**
   * OPTIONAL tiny mirrored position on BASE (a chain Bankr actually supports),
   * correlated with the Gnosis series just created. Double-gated: needs both the
   * API key (we have it if we are here) and an explicit BANKR_MIRROR=1. Spends
   * from Bankr's own custodied wallet (default rails: $500/day, $500/tx) — it is
   * NOT the Gnosis sponsor and this is NOT execution of the Plan.
   */
  async function mirrorOnBase(plan, { maxUsd = 5 } = {}) {
    if (!mirror) return { ok: false, skipped: true, error: "mirror disabled (set BANKR_MIRROR=1 to enable)" };
    const s = plan?.newSeries;
    if (!s) return { ok: false, skipped: true, error: "no newSeries in plan — nothing to mirror" };
    const prompt =
      `On Base only, take a small hedged position of at most $${maxUsd} USDC that is positively ` +
      `correlated with Manhattan office rent printing between ${s.strikeLowCents} and ${s.strikeHighCents} ` +
      `cents/SF (e.g. a related Polymarket NYC real-estate market). If nothing suitable exists, do nothing and say so.`;
    return agentPrompt(prompt);
  }

  return { name: "bankr", enabled: true, mirror, agentPrompt, llmChat, advise, notify, mirrorOnBase };
}
