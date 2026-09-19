import { encodeFunctionData, getAddress } from "viem";
import {
  BANKR_API_BASE,
  buildWalletMeRequest,
  buildWalletSubmitRequest,
} from "../executors/bankr.mjs";

const apiError = (value) => typeof value === "string" ? value : JSON.stringify(value ?? "unknown error");

export function buildV4AdvisoryPrompt(plan, signals) {
  const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  return [
    "You are a risk reviewer for a bounded Uniswap v4 rent-claim market maker.",
    "A deterministic engine produced the exact bid/ask ticks and token limits below from authenticated rent observations.",
    "Public news and platform research is qualitative context only: never turn it into a settlement value or new transaction amount.",
    "Review staleness, direction, inventory, market context, and obvious inconsistency. You cannot transact.",
    'Respond only as JSON: {"verdict":"approve"|"caution"|"veto","concerns":["..."],"summary":"one sentence"}',
    `PLAN:${json(plan)}`,
    `RESEARCH:${json(signals)}`,
  ].join("\n");
}

/**
 * Bankr custody adapter for the v4 executor.
 *
 * This is intentionally only a signer/broadcaster. Quote construction, target
 * validation, balances, time windows, gas caps, simulation and receipt checks
 * remain in direct.mjs. A separate opt-in keeps the legacy CoverPool actuator
 * from accidentally enabling this market actuator (or vice versa).
 */
export async function createBankrV4WalletClient({
  apiKey = process.env.BANKR_API_KEY,
  expectedWallet = process.env.BANKR_WALLET,
  chainId,
  executeEnabled = process.env.BANKR_V4_EXECUTE === "1",
  fetchImpl = fetch,
  apiBase = BANKR_API_BASE,
} = {}) {
  const reasons = [];
  if (!apiKey) reasons.push("BANKR_API_KEY not set");
  if (!executeEnabled) reasons.push("BANKR_V4_EXECUTE != 1");
  if (!expectedWallet) reasons.push("BANKR_WALLET not set");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) reasons.push("invalid chainId");
  if (reasons.length) throw new Error(`Bankr v4 execution gate failed: ${reasons.join("; ")}`);

  const { url, init } = buildWalletMeRequest({ apiKey, base: apiBase });
  const response = await fetchImpl(url, init);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok || body?.success !== true) {
    throw new Error(`Bankr v4 execution gate failed: /wallet/me HTTP ${response.status}`);
  }
  const evm = body.wallets?.find((wallet) => wallet.chain === "evm");
  if (!evm?.address || evm.address.toLowerCase() !== expectedWallet.toLowerCase()) {
    throw new Error(`Bankr v4 execution gate failed: custody wallet does not match BANKR_WALLET`);
  }
  const account = getAddress(expectedWallet);

  return {
    account,
    getChainId: async () => chainId,
    async writeContract(request) {
      if (!request?.address || !request?.abi || !request?.functionName) {
        throw new Error("Bankr v4 adapter requires an encoded contract call");
      }
      const data = encodeFunctionData({
        abi: request.abi,
        functionName: request.functionName,
        args: request.args ?? [],
      });
      const built = buildWalletSubmitRequest({
        transaction: {
          to: request.address,
          chainId,
          value: BigInt(request.value ?? 0n).toString(),
          data,
        },
        description: `RentSafe v4: ${request.functionName}`,
        waitForConfirmation: false,
        apiKey,
        base: apiBase,
      });
      const submitted = await fetchImpl(built.url, built.init);
      let result = null;
      try { result = await submitted.json(); } catch { /* non-JSON error */ }
      if (!submitted.ok || result?.success !== true || !result?.transactionHash) {
        const why = apiError(result?.errorCode ?? result?.error ?? `HTTP ${submitted.status}`);
        throw new Error(`Bankr /wallet/submit rejected ${request.functionName}: ${why}`);
      }
      return result.transactionHash;
    },
  };
}
