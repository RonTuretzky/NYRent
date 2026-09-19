/**
 * bankr.mjs — real Bankr API client (docs.bankr.bot): ADVISORY second opinion
 * plus a CUSTODY EXECUTION rail for Arbitrum.
 *
 * ============================  ROLE — READ THIS  ============================
 * The protocol is permissionless (src/CoverPool.sol — no roles): any wallet can
 * underwrite (createSeries escrows the caller's capacity) and any wallet can buy
 * cover. That makes a Bankr-custodied wallet a first-class market-maker wallet
 * on chains Bankr supports. Bankr supports Base, Ethereum, Polygon, Unichain,
 * World Chain, Arbitrum, BNB, Robinhood Chain, Arc, Solana and Hyperliquid —
 * NOT Gnosis (https://docs.bankr.bot/getting-started/supported-chains). Jobs:
 *
 *   1. ADVISORY (any target): one Agent-API prompt summarizing the two-sided
 *      plan for a second opinion — structured verdict out; it may flag/veto,
 *      it never originates numbers. On the free tier the Agent API refuses AI
 *      prompts with HTTP 403 {"error":"subscription_required"} (live-captured
 *      2026-09-19, fixtures/bankr-agent-prompt-subscription-required.json) —
 *      advise() catches EXACTLY that and degrades to one honest line.
 *   2. EXECUTION (Arbitrum only, triple-gated): build the SAME tx list as the
 *      Direct executor (single shared builder — the executor never invents
 *      txs), simulate each tx with a local viem client AS the Bankr wallet
 *      (from-override), then sign + submit through the Wallet API
 *      (POST /wallet/submit — Bankr signs custodially and broadcasts,
 *      https://docs.bankr.bot/wallet-api/submit), and poll the chain to
 *      receipts. Partial semantics are identical to direct.mjs: the batch
 *      aborts on the first failure with the landed tx hashes listed (exit 4
 *      upstream).
 *
 * TRIPLE GATE for execution (checkExecutionGate — ALL must pass):
 *   (a) BANKR_API_KEY set (constructor gate: no key -> executor disabled);
 *   (b) BANKR_EXECUTE=1 (explicit custody opt-in, never defaulted on);
 *   (c) live GET /wallet/me EVM address == BANKR_WALLET env
 *       (https://docs.bankr.bot/wallet-api/wallet-info) — a rotated or wrong
 *       key can never spend from an unexpected wallet;
 *   plus: the wallet must hold the currency the plan needs (balanceOf >= the
 *   sum of escrow/premium pulls in the tx list, in target currency units).
 *
 * A Bankr failure must NEVER block Direct execution: every public method
 * resolves to { ok:false, ... } instead of throwing.
 * ===========================================================================
 *
 * API surface used (verified against docs.bankr.bot + live 2026-09-19):
 *   POST https://api.bankr.bot/agent/prompt   {prompt, threadId?}  hdr X-API-Key
 *        -> 202 {jobId, threadId, status:"pending"}
 *        -> 403 {"error":"subscription_required", ...} on the free tier
 *        (https://docs.bankr.bot/agent-api/prompt-endpoint)
 *   GET  https://api.bankr.bot/agent/job/{id}                      hdr X-API-Key
 *        -> {status: pending|processing|completed|failed|cancelled, response}
 *        (https://docs.bankr.bot/agent-api/job-management)
 *   GET  https://api.bankr.bot/wallet/me  -> {success, wallets:[{chain,address}]}
 *        works on ANY valid key, free tier included (verified live 2026-09-19)
 *        (https://docs.bankr.bot/wallet-api/wallet-info)
 *   POST https://api.bankr.bot/wallet/submit
 *        {transaction:{to,chainId,value,data}, description, waitForConfirmation}
 *        -> {success, transactionHash, ...}; Bankr signs with the custodied key
 *        and broadcasts; account-side rails (per-tx/daily USD limits, arbitrary-
 *        contract-call switch) are enforced server-side and reject with 403 +
 *        errorCode (https://docs.bankr.bot/wallet-api/submit,
 *        https://docs.bankr.bot/security/bankr-terminal)
 *   POST https://api.bankr.bot/wallet/sign  (eth_signTransaction) exists for
 *        sign-without-broadcast flows (https://docs.bankr.bot/wallet-api/sign);
 *        we use /wallet/submit because the pool txs must land on-chain and
 *        Bankr's signer + broadcaster are one custody surface.
 *   LLM Gateway: POST https://llm.bankr.bot/v1/chat/completions (OpenAI-
 *        compatible, Authorization: Bearer $BANKR_LLM_KEY, credit-funded)
 *        (https://docs.bankr.bot/llm-gateway/api-reference)
 */
import { formatUnits, encodeFunctionData, decodeErrorResult } from "viem";
import { jsonBigint } from "./chain.mjs";
import { POOL_ABI } from "./targets.mjs";

export const BANKR_API_BASE = "https://api.bankr.bot";
export const BANKR_LLM_BASE = "https://llm.bankr.bot";
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-5"; // override with BANKR_LLM_MODEL

/** The one honest line printed when the Agent API wants a subscription. */
export const SUBSCRIPTION_DEGRADE_LINE =
  "bankr advisory unavailable: Agent-API AI prompts need Bankr Club or Max Mode credits (subscription_required) — continuing without a second opinion.";

// ---------------------------------------------------------------------------
// Pure request builders (unit-tested without any network)
// ---------------------------------------------------------------------------

/** POST /agent/prompt — https://docs.bankr.bot/agent-api/prompt-endpoint */
export function buildAgentPromptRequest({ prompt, threadId, maxModeModel, apiKey, base = BANKR_API_BASE }) {
  const body = { prompt };
  if (threadId) body.threadId = threadId;
  // Non-Club accounts with LLM credits must explicitly opt each Agent API
  // request into Max Mode. Keeping this absent by default prevents accidental
  // credit spend; set BANKR_MAX_MODE_MODEL to opt in deliberately.
  if (maxModeModel) body.maxMode = { enabled: true, model: maxModeModel };
  return {
    url: `${base}/agent/prompt`,
    init: {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

/** GET /agent/job/{id} — https://docs.bankr.bot/agent-api/job-management */
export function buildJobStatusRequest({ jobId, apiKey, base = BANKR_API_BASE }) {
  return {
    url: `${base}/agent/job/${jobId}`,
    init: { method: "GET", headers: { "X-API-Key": apiKey } },
  };
}

/** GET /wallet/me — https://docs.bankr.bot/wallet-api/wallet-info (any valid key) */
export function buildWalletMeRequest({ apiKey, base = BANKR_API_BASE }) {
  return {
    url: `${base}/wallet/me`,
    init: { method: "GET", headers: { "X-API-Key": apiKey } },
  };
}

/**
 * POST /wallet/submit — https://docs.bankr.bot/wallet-api/submit
 * Bankr signs the transaction with the custodied key and broadcasts it.
 * `transaction.value` is a decimal-string wei amount; `data` is hex calldata.
 * waitForConfirmation defaults FALSE here: we poll receipts ourselves with a
 * local viem client so the receipt fields (block, gasUsed, fee) match the
 * Direct executor's report exactly.
 */
export function buildWalletSubmitRequest({
  transaction,
  description,
  waitForConfirmation = false,
  apiKey,
  base = BANKR_API_BASE,
}) {
  return {
    url: `${base}/wallet/submit`,
    init: {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ transaction, description, waitForConfirmation }),
    },
  };
}

/** POST llm.bankr.bot/v1/chat/completions — https://docs.bankr.bot/llm-gateway/api-reference */
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

/**
 * EXACT detection of the Agent API's paywall refusal. Live-captured shape
 * (2026-09-19, fixtures/bankr-agent-prompt-subscription-required.json):
 *   HTTP 403 {"error":"subscription_required","message":"Bankr Club membership
 *             or Max Mode is required for AI prompts.","remediation":[...]}
 * Only this shape degrades to the one-line advisory notice; every other
 * failure keeps its own error text.
 */
export function isSubscriptionRequired(status, body) {
  return status === 403 && body !== null && typeof body === "object" && body.error === "subscription_required";
}

/** Advisory prompt: the full two-sided Plan + signals, verdict constrained to JSON. */
export function buildAdvisoryPrompt(plan, signalsSummary) {
  return [
    "You are a risk reviewer for a two-sided market maker on a permissionless on-chain",
    "rent-protection pool (CoverPool). The agent SELLS protection by underwriting its own",
    "series (escrowing capacity 1:1, premium = model fair value x 1.25 loading) and BUYS",
    "protection on other creators' series priced below model fair value minus an edge",
    "threshold; positions are soulbound and held to settlement, and inventory (net exposure)",
    "is managed by leaning the NEXT cycle's actions. You cannot transact and you never",
    "originate numbers — this is advisory only. A deterministic policy produced the Plan",
    "below from the Signals below. Review it for consistency: strikes vs the latest printed",
    "rent, premium vs signal dispersion, buy-side edge vs quoted premiums, escrow sizing vs",
    "available capital, inventory lean, and per-series pause/cancel/residual logic.",
    "Respond with ONLY a JSON object, no prose around it:",
    '{"verdict":"approve"|"caution"|"veto","concerns":["..."],"summary":"one sentence"}',
    "",
    "PLAN:",
    // Compact JSON matters here: Bankr's AWS edge rejects oversized request
    // bodies before they reach the Agent API. The caller already curates the
    // research payload, so whitespace buys nothing and can push a valid POC
    // review over that boundary.
    JSON.stringify(plan, jsonBigint),
    "",
    "SIGNALS:",
    typeof signalsSummary === "string" ? signalsSummary : JSON.stringify(signalsSummary, jsonBigint),
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

/**
 * Currency (escrow + premium) the tx list will PULL from the executing wallet,
 * in target currency units. Mirrors CoverPool's safeTransferFrom pulls:
 *   createSeries      -> args[7]  capacity            (escrowed 1:1)
 *   addCapacity       -> args[1]  amount
 *   buyProtectionFor  -> args[2]  maxPremium (upper bound on the pull)
 *   buyProtection     -> args[2]  maxPremium
 * approve / setSeriesPaused / cancelSeries / withdrawResidual pull nothing.
 */
export function planCurrencyNeedWei(txs) {
  let need = 0n;
  for (const tx of txs ?? []) {
    switch (tx.functionName) {
      case "createSeries":
        need += BigInt(tx.args[7]);
        break;
      case "addCapacity":
        need += BigInt(tx.args[1]);
        break;
      case "buyProtectionFor":
      case "buyProtection":
        need += BigInt(tx.args[2]);
        break;
      default:
        break;
    }
  }
  return need;
}

function explainRevert(err) {
  // viem decodes custom errors itself when the ABI is known: walk the cause
  // chain for the decoded { data: { errorName, args } } a
  // ContractFunctionRevertedError carries, then fall back to raw hex data.
  for (let e = err; e; e = e.cause) {
    const d = e?.data;
    if (d && typeof d === "object" && typeof d.errorName === "string") {
      return `custom error ${d.errorName}(${(d.args ?? []).join(", ")})`;
    }
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: POOL_ABI, data: d });
        return `custom error ${decoded.errorName}(${(decoded.args ?? []).join(", ")})`;
      } catch {
        /* not one of ours */
      }
    }
  }
  return err?.shortMessage ?? err?.message ?? String(err);
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// ---------------------------------------------------------------------------
// Executor factory
// ---------------------------------------------------------------------------

/**
 * createBankrExecutor(opts) -> executor. Without a BANKR_API_KEY the constructor
 * returns { enabled:false, reason } and the runner proceeds Direct-only.
 *
 * Advisory opts: apiKey, llmKey, apiBase, llmBase, model,
 *                fetchImpl (injectable for unit tests), pollStartMs, timeoutMs, log.
 * Execution wiring (provided by executors/index.mjs per target; all four are
 * required for execute() — without them the executor is advisory-only):
 *   target        target object from targets.mjs (chainId, currency, explorerTx)
 *   publicClient  viem public client on the target chain (simulate + receipts)
 *   readState     async () => chain state AS the Bankr wallet (the Direct
 *                 executor's own readState with impersonate=BANKR_WALLET, so
 *                 balances/allowances are the Bankr wallet's)
 *   buildTxs      (plan, state) => { txs, notes } — the Direct executor's own
 *                 pure builder (computeTxDiff): the SAME tx list by construction
 * Gate opts: executeEnabled (default env BANKR_EXECUTE === "1"),
 *            expectedWallet (default env BANKR_WALLET).
 */
export function createBankrExecutor({
  apiKey = process.env.BANKR_API_KEY,
  llmKey = process.env.BANKR_LLM_KEY,
  maxModeModel = process.env.BANKR_MAX_MODE_MODEL,
  apiBase = BANKR_API_BASE,
  llmBase = BANKR_LLM_BASE,
  model = process.env.BANKR_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  fetchImpl = fetch,
  pollStartMs = 2_000,
  timeoutMs = 180_000,
  log = console.log,
  // execution wiring
  target = null,
  publicClient = null,
  readState = null,
  buildTxs = null,
  executeEnabled = process.env.BANKR_EXECUTE === "1",
  expectedWallet = process.env.BANKR_WALLET,
} = {}) {
  if (!apiKey) {
    return { name: "bankr", enabled: false, reason: "BANKR_API_KEY not set" };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wired = Boolean(target && publicClient && readState && buildTxs);
  const fmt = (wei) =>
    target ? `${formatUnits(wei, target.currency.decimals)} ${target.currency.symbol}` : `${wei} wei`;

  /**
   * POST /agent/prompt then poll GET /agent/job/{id} with backoff to a terminal
   * state. Detects the free-tier paywall (subscription_required) EXACTLY and
   * flags it instead of burying it in a generic HTTP error.
   */
  async function agentPrompt(text, threadId) {
    try {
      const { url, init } = buildAgentPromptRequest({ prompt: text, threadId, maxModeModel, apiKey, base: apiBase });
      const res = await fetchImpl(url, init);
      if (!res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON error body */
        }
        if (isSubscriptionRequired(res.status, body)) {
          return { ok: false, subscriptionRequired: true, error: body.message ?? "subscription_required" };
        }
        return { ok: false, error: `POST /agent/prompt -> HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}` };
      }
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

  /** One-shot chat call against Bankr's LLM Gateway (llm.bankr.bot, separate credit-funded key). */
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
   * Advisory second opinion on the two-sided Plan. Tries the Agent API
   * (threadId = running memory). A subscription_required refusal degrades to
   * ONE honest line ({ degraded:true, line }) — no gateway fallback, because
   * Max Mode credits sit behind the same paywall. Any OTHER Agent-API failure
   * still falls back to a plain LLM-gateway chat when a gateway key exists.
   * Always resolves; never throws.
   */
  async function advise(plan, signalsSummary, threadId) {
    const prompt = buildAdvisoryPrompt(plan, signalsSummary);
    let via = "agent-api";
    let out = await agentPrompt(prompt, threadId);
    if (out.subscriptionRequired) {
      return { ok: false, degraded: true, subscriptionRequired: true, via, line: SUBSCRIPTION_DEGRADE_LINE, error: out.error };
    }
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
   * GET /wallet/me (https://docs.bankr.bot/wallet-api/wallet-info) — works on
   * any valid key, free tier included (verified live 2026-09-19; fixture:
   * fixtures/bankr-wallet-me.json, refCode redacted).
   */
  async function walletMe() {
    try {
      const { url, init } = buildWalletMeRequest({ apiKey, base: apiBase });
      const res = await fetchImpl(url, init);
      if (!res.ok) return { ok: false, error: `GET /wallet/me -> HTTP ${res.status}` };
      const body = await res.json();
      const evm = (body.wallets ?? []).find((w) => w.chain === "evm");
      if (!body.success || !evm?.address) return { ok: false, error: "GET /wallet/me: no EVM wallet in response" };
      return { ok: true, evmAddress: evm.address, bankrClub: body.bankrClub ?? null };
    } catch (err) {
      return { ok: false, error: `walletMe: ${err?.message ?? err}` };
    }
  }

  /**
   * The execution gate. ALL of:
   *   (a) key present — guaranteed here (constructor returned early otherwise);
   *   (b) BANKR_EXECUTE=1 — explicit custody opt-in;
   *   (c) live /wallet/me EVM address == BANKR_WALLET env (case-insensitive);
   *   (d) requiredCurrencyWei > 0 -> the Bankr wallet's currency balance covers
   *       the plan's escrow+premium pulls (checked on-chain, currency units).
   * Never throws; returns { pass, reasons[], evmAddress? }.
   */
  async function checkExecutionGate({ requiredCurrencyWei = 0n } = {}) {
    const reasons = [];
    if (!executeEnabled) reasons.push("BANKR_EXECUTE != 1 (custody execution not opted in)");
    if (!expectedWallet) reasons.push("BANKR_WALLET not set (no expected custody address to verify against)");
    let evmAddress = null;
    if (expectedWallet) {
      const me = await walletMe();
      if (!me.ok) {
        reasons.push(`wallet identity unverified: ${me.error}`);
      } else {
        evmAddress = me.evmAddress;
        if (me.evmAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
          reasons.push(`live /wallet/me address ${me.evmAddress} != expected BANKR_WALLET ${expectedWallet}`);
        }
      }
    }
    if (requiredCurrencyWei > 0n) {
      if (!wired) {
        reasons.push("executor not wired for on-chain reads (no publicClient/target)");
      } else {
        try {
          const bal = await publicClient.readContract({
            address: target.currency.address,
            abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
            functionName: "balanceOf",
            args: [expectedWallet],
          });
          if (bal < requiredCurrencyWei) {
            reasons.push(`Bankr wallet holds ${fmt(bal)} but the plan needs ${fmt(requiredCurrencyWei)}`);
          }
        } catch (err) {
          reasons.push(`currency balance read failed: ${err?.shortMessage ?? err?.message ?? err}`);
        }
      }
    }
    return { pass: reasons.length === 0, reasons, evmAddress };
  }

  /**
   * Execute a Plan through Bankr custody. Same contract as direct.execute():
   *   dryRun  -> gate + simulate only, nothing submitted, tx list returned;
   *   gated   -> { ok:false, gated:true } BEFORE anything is sent (the router
   *              falls back to Direct on this and only this);
   *   partial -> { ok:false, executed:[landed...], failed:{name,...} } — the
   *              batch aborts on the first failure, landed hashes listed.
   * Per tx: simulate with the local viem client AS the Bankr wallet
   * (account = from-override, immediately before submission so sequential
   * dependencies like approve->createSeries hold), then POST /wallet/submit
   * (https://docs.bankr.bot/wallet-api/submit) and poll the chain to a receipt.
   */
  async function execute(plan, { dryRun = false } = {}) {
    if (!wired) return { ok: false, error: "bankr executor not wired for execution on this target", executed: [] };

    let state;
    try {
      state = await readState();
    } catch (err) {
      return { ok: false, error: `readState failed: ${err?.shortMessage ?? err?.message ?? err}`, executed: [] };
    }

    let diff;
    try {
      diff = buildTxs(plan, state);
    } catch (err) {
      // Mirrors direct.mjs: an invalid plan dies locally, never on-chain.
      return { ok: false, dryRun, error: `invalid plan: ${err?.message ?? err}`, executed: [] };
    }
    const { txs, notes = [] } = diff;
    for (const n of notes) log(`  note: ${n}`);
    if (txs.length === 0) return { ok: true, dryRun, txs: [], notes, executed: [], summary: "no-op: chain already matches plan" };

    const requiredCurrencyWei = planCurrencyNeedWei(txs);
    const gate = await checkExecutionGate({ requiredCurrencyWei });
    if (!gate.pass) {
      return { ok: false, gated: true, error: `bankr execution gate failed: ${gate.reasons.join("; ")}`, reasons: gate.reasons, executed: [] };
    }

    if (dryRun) {
      // Simulate what we can from-override; later txs may legitimately fail
      // simulation because they depend on earlier ones landing (approve ->
      // createSeries) — recorded, not fatal, exactly like direct's gas fallback.
      const planned = [];
      for (const [i, tx] of txs.entries()) {
        let sim = "simulated ok";
        try {
          await publicClient.simulateContract({
            address: tx.address,
            abi: tx.abi,
            functionName: tx.functionName,
            args: tx.args,
            value: tx.value,
            account: expectedWallet,
          });
        } catch (err) {
          sim = i === 0 ? `SIMULATION FAILED: ${explainRevert(err)}` : `deferred (${explainRevert(err).slice(0, 80)})`;
        }
        planned.push({ ...tx, sim });
      }
      log(`  BANKR DRY RUN — ${planned.length} tx(s) would go through /wallet/submit; nothing sent`);
      for (const t of planned) log(`    - ${t.name} [${t.sim}]`);
      return {
        ok: true,
        dryRun: true,
        gated: false,
        wallet: expectedWallet,
        requiredCurrencyWei,
        txs: planned.map(({ abi, ...t }) => t), // strip abi objects from the report
        notes,
        executed: [],
      };
    }

    // Live: simulate immediately before each submission, submit through Bankr
    // custody, poll to the receipt, abort the batch on the first failure.
    const executed = [];
    for (const tx of txs) {
      try {
        await publicClient.simulateContract({
          address: tx.address,
          abi: tx.abi,
          functionName: tx.functionName,
          args: tx.args,
          value: tx.value,
          account: expectedWallet, // from-override: simulate AS the Bankr wallet
        });
      } catch (err) {
        const why = explainRevert(err);
        log(`  ABORT batch at "${tx.name}" (pre-submit simulation): ${why}`);
        return { ok: false, dryRun: false, error: `${tx.name} failed simulation: ${why}`, failed: { name: tx.name }, executed, notes };
      }

      const data = encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args });
      const { url, init } = buildWalletSubmitRequest({
        transaction: {
          to: tx.address,
          chainId: target.chainId,
          value: (tx.value ?? 0n).toString(),
          data,
        },
        description: `nyrent-cover agent: ${tx.name}`,
        waitForConfirmation: false, // we poll the chain to the receipt ourselves
        apiKey,
        base: apiBase,
      });
      let hash;
      try {
        log(`  submitting via Bankr custody: ${tx.name}`);
        const res = await fetchImpl(url, init);
        let body = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON body */
        }
        if (!res.ok || body?.success !== true || !body?.transactionHash) {
          // Account-side rails reject here with errorCode (PER_TX_LIMIT_EXCEEDED,
          // DAILY_LIMIT_EXCEEDED, RECIPIENT_NOT_PERMITTED, PAUSED, ...) — see
          // https://docs.bankr.bot/wallet-api/submit + /security/bankr-terminal.
          const why = body?.errorCode ?? body?.error ?? `HTTP ${res.status}`;
          log(`  ABORT batch at "${tx.name}" (/wallet/submit): ${why}`);
          return { ok: false, dryRun: false, error: `${tx.name} rejected by /wallet/submit: ${why}${body?.message ? ` — ${body.message}` : ""}`, failed: { name: tx.name }, executed, notes };
        }
        hash = body.transactionHash;
      } catch (err) {
        log(`  ABORT batch at "${tx.name}" (/wallet/submit): ${err?.message ?? err}`);
        return { ok: false, dryRun: false, error: `${tx.name} submit failed: ${err?.message ?? err}`, failed: { name: tx.name }, executed, notes };
      }

      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const link = target.explorerTx(hash);
        if (receipt.status !== "success") {
          log(`  REVERTED: ${tx.name} — ${link}`);
          return { ok: false, dryRun: false, error: `${tx.name} reverted on-chain`, failed: { name: tx.name, hash, link }, executed, notes };
        }
        const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
        log(`  OK ${tx.name}: block ${receipt.blockNumber}, gasUsed ${receipt.gasUsed}`);
        log(`     ${link}`);
        executed.push({ name: tx.name, functionName: tx.functionName, hash, link, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, feeWei, via: "bankr" });
      } catch (err) {
        log(`  ABORT batch at "${tx.name}" (receipt): ${err?.message ?? err}`);
        return { ok: false, dryRun: false, error: `${tx.name} receipt wait failed: ${err?.message ?? err}`, failed: { name: tx.name, hash }, executed, notes };
      }
    }
    return { ok: true, dryRun: false, executed, notes, via: "bankr" };
  }

  return {
    name: "bankr",
    enabled: true,
    canExecute: wired,
    executeEnabled,
    expectedWallet: expectedWallet ?? null,
    agentPrompt,
    llmChat,
    advise,
    notify,
    walletMe,
    checkExecutionGate,
    execute,
  };
}
