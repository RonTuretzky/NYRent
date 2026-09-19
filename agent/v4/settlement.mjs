import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeEventLog, parseAbi, toHex } from "viem";
import { preflight } from "../../web/src/lib/emailkit.ts";

export const ORACLE_SETTLEMENT_ABI = parseAbi([
  "function recorded(bytes32) view returns (bool)",
  "function observationCount() view returns (uint256)",
  "function observations(uint256) view returns (uint64 t,uint32 cents,bytes32 emailId)",
]);
export const MARKET_SETTLEMENT_ABI = parseAbi([
  "function saleEnd() view returns (uint64)",
  "function obsStart() view returns (uint64)",
  "function obsEnd() view returns (uint64)",
  "function tradingOpen() view returns (bool)",
  "function settled() view returns (bool)",
  "function settle(uint256 observationIndex)",
]);
export const SUBMITTER_ABI = parseAbi([
  "event ChunkStored(address indexed chunk,bytes32 indexed contentHash,uint256 length)",
  "function store(bytes data) returns (address chunk)",
  "function submit(address oracle,address[] chunks,bytes32 expectedBodyHash,bytes signedHeaders,bytes sig,bytes inlineTail)",
]);

const MAX_CHUNK_BYTES = 24_000;
const MAX_INLINE_TAIL_BYTES = 80_000;
const MAX_BODY_BYTES = 192_000;
const MAX_CHUNKS = 8;
const MAX_OBSERVATIONS = 10_000n;
const MAX_SETTLEMENT_GAS = 4_000_000n;

/** Use the fewest stored prefix chunks that leave an <=80k inline tail. */
export function splitObservationBody(body) {
  if (!(body instanceof Uint8Array) || body.length === 0 || body.length > MAX_BODY_BYTES) {
    throw new Error(`Canonical email body must be 1-${MAX_BODY_BYTES} bytes`);
  }
  const chunks = [];
  let offset = 0;
  while (body.length - offset > MAX_INLINE_TAIL_BYTES) {
    if (chunks.length === MAX_CHUNKS) throw new Error("Canonical email body needs too many chunks");
    const length = Math.min(MAX_CHUNK_BYTES, body.length - offset - MAX_INLINE_TAIL_BYTES);
    chunks.push(body.slice(offset, offset + length));
    offset += length;
  }
  return { chunks, inlineTail: body.slice(offset) };
}

export function assertSettlementWindow({ now, saleEnd, obsStart, obsEnd, tradingOpen, emailTimestamp }) {
  const values = { now, saleEnd, obsStart, obsEnd, emailTimestamp };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  }
  if (saleEnd > obsStart) throw new Error("Unsafe market terms: saleEnd is after obsStart");
  if (now < saleEnd || tradingOpen) throw new Error("Trading is still open; settlement email cannot be submitted yet");
  if (emailTimestamp < obsStart || emailTimestamp > obsEnd) throw new Error("Email is outside the observation window");
  if (emailTimestamp > now) throw new Error("Email timestamp is in the future");
}

export async function scanVerifiedEmails(inboxDir) {
  const entries = await readdir(inboxDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eml"))
    .map((entry) => path.join(inboxDir, entry.name)).sort();
  const verified = [];
  const rejected = [];
  for (const file of files) {
    const raw = new Uint8Array(await readFile(file));
    const report = await preflight(raw);
    if (report.ok && report.parsed) verified.push({ file, parsed: report.parsed });
    else rejected.push({ file, failedChecks: report.checks.filter((check) => !check.pass).map((check) => check.id) });
  }
  return { verified, rejected };
}

async function findObservation(publicClient, target, emailId) {
  const count = await publicClient.readContract({ address: target.oracle, abi: ORACLE_SETTLEMENT_ABI, functionName: "observationCount" });
  if (count > MAX_OBSERVATIONS) throw new Error("Observation scan exceeds safe POC bound");
  for (let index = 0n; index < count; index++) {
    const observation = await publicClient.readContract({
      address: target.oracle, abi: ORACLE_SETTLEMENT_ABI, functionName: "observations", args: [index],
    });
    if (observation[2].toLowerCase() === emailId.toLowerCase()) return { index, observation };
  }
  return null;
}

async function send({ publicClient, walletClient, address, abi, functionName, args }) {
  const request = { address, abi, functionName, args };
  const simulation = await publicClient.simulateContract({ ...request, account: walletClient.account });
  const estimate = await publicClient.estimateContractGas({ ...request, account: walletClient.account });
  const gas = (estimate * 120n + 99n) / 100n;
  if (gas > MAX_SETTLEMENT_GAS) throw new Error(`${functionName} exceeds settlement gas cap`);
  const hash = await walletClient.writeContract({ ...simulation.request, account: walletClient.account, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return { hash, receipt };
}

/**
 * Settlement-only workflow. There is deliberately no quote/swap import here.
 * The chain window is checked before the first transaction and again by both
 * oracle/market contracts. Already-recorded emails and settled markets are
 * idempotent no-ops.
 */
export async function settleVerifiedEmail({ target, parsed, publicClient, walletClient, execute = false }) {
  if (!target?.observationSubmitter) throw new Error("Target has no verified observationSubmitter");
  const block = await publicClient.getBlock();
  const [saleEnd, obsStart, obsEnd, tradingOpen, settled] = await Promise.all([
    publicClient.readContract({ address: target.market, abi: MARKET_SETTLEMENT_ABI, functionName: "saleEnd" }),
    publicClient.readContract({ address: target.market, abi: MARKET_SETTLEMENT_ABI, functionName: "obsStart" }),
    publicClient.readContract({ address: target.market, abi: MARKET_SETTLEMENT_ABI, functionName: "obsEnd" }),
    publicClient.readContract({ address: target.market, abi: MARKET_SETTLEMENT_ABI, functionName: "tradingOpen" }),
    publicClient.readContract({ address: target.market, abi: MARKET_SETTLEMENT_ABI, functionName: "settled" }),
  ]);
  if (settled) return { dryRun: !execute, alreadySettled: true, transactions: [] };
  assertSettlementWindow({
    now: Number(block.timestamp), saleEnd: Number(saleEnd), obsStart: Number(obsStart), obsEnd: Number(obsEnd),
    tradingOpen, emailTimestamp: Number(parsed.tags.t),
  });

  let existing = await findObservation(publicClient, target, parsed.emailId);
  const { chunks, inlineTail } = splitObservationBody(parsed.canonBody);
  const plan = {
    emailId: parsed.emailId,
    cents: parsed.cents,
    emailTimestamp: Number(parsed.tags.t),
    bodyBytes: parsed.canonBody.length,
    chunks: chunks.map((chunk) => chunk.length),
    inlineTailBytes: inlineTail.length,
    observationAlreadyRecorded: Boolean(existing),
    actions: [...(existing ? [] : chunks.map((chunk, index) => ({ functionName: "store", index, bytes: chunk.length }))),
      ...(existing ? [] : [{ functionName: "submit", bytes: inlineTail.length }]), { functionName: "settle" }],
  };
  if (!execute) return { dryRun: true, alreadySettled: false, plan, transactions: [] };
  if (!walletClient?.account) throw new Error("Explicit settlement wallet is required");

  const transactions = [];
  if (!existing) {
    const chunkAddresses = [];
    for (const chunk of chunks) {
      const landed = await send({ publicClient, walletClient, address: target.observationSubmitter, abi: SUBMITTER_ABI,
        functionName: "store", args: [toHex(chunk)] });
      let stored = null;
      for (const log of landed.receipt.logs) {
        try {
          const event = decodeEventLog({ abi: SUBMITTER_ABI, data: log.data, topics: log.topics });
          if (event.eventName === "ChunkStored") { stored = event.args.chunk; break; }
        } catch { /* unrelated event */ }
      }
      if (!stored) throw new Error("ChunkStored event missing from successful store transaction");
      chunkAddresses.push(stored);
      transactions.push({ action: "store", hash: landed.hash, chunk: stored });
    }
    const submitted = await send({ publicClient, walletClient, address: target.observationSubmitter, abi: SUBMITTER_ABI,
      functionName: "submit", args: [target.oracle, chunkAddresses, parsed.emailId, toHex(parsed.signedHeaders),
        toHex(parsed.sig), toHex(inlineTail)] });
    transactions.push({ action: "submitObservation", hash: submitted.hash });
    existing = await findObservation(publicClient, target, parsed.emailId);
    if (!existing) throw new Error("Oracle transaction landed but email observation was not found");
  }
  const [t, cents, emailId] = existing.observation;
  if (Number(t) !== Number(parsed.tags.t) || Number(cents) !== parsed.cents || emailId.toLowerCase() !== parsed.emailId.toLowerCase()) {
    throw new Error("Recorded observation differs from locally verified email");
  }
  const settledTx = await send({ publicClient, walletClient, address: target.market, abi: MARKET_SETTLEMENT_ABI,
    functionName: "settle", args: [existing.index] });
  transactions.push({ action: "settle", observationIndex: existing.index, hash: settledTx.hash });
  return { dryRun: false, alreadySettled: false, plan, transactions };
}
