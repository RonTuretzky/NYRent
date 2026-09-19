import test from "node:test";
import assert from "node:assert/strict";
import { parseAbi } from "viem";
import { buildV4AdvisoryPrompt, createBankrV4WalletClient } from "./bankr.mjs";

const WALLET = "0x00000000000000000000000000000000000000A1";
const TOKEN = "0x00000000000000000000000000000000000000B2";
const HASH = `0x${"12".repeat(32)}`;

test("Bankr v4 custody adapter is separately gated", async () => {
  await assert.rejects(
    createBankrV4WalletClient({ apiKey: "bk_test", expectedWallet: WALLET, chainId: 42161, executeEnabled: false }),
    /BANKR_V4_EXECUTE/,
  );
});

test("v4 advisory makes research qualitative and preserves bigint plan fields", () => {
  const prompt = buildV4AdvisoryPrompt({ mintAmount: 500000n }, { reports: [{ detail: "office leasing" }] });
  assert.match(prompt, /qualitative context only/);
  assert.match(prompt, /"mintAmount":"500000"/);
  assert.match(prompt, /office leasing/);
});

test("Bankr v4 custody adapter verifies identity and submits exact calldata", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/wallet/me")) {
      return { ok: true, status: 200, json: async () => ({ success: true, wallets: [{ chain: "evm", address: WALLET }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, transactionHash: HASH }) };
  };
  const wallet = await createBankrV4WalletClient({
    apiKey: "bk_test", expectedWallet: WALLET, chainId: 42161, executeEnabled: true, fetchImpl,
  });
  const hash = await wallet.writeContract({
    address: TOKEN,
    abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
    functionName: "approve",
    args: [WALLET, 500000n],
    value: 0n,
  });
  assert.equal(hash, HASH);
  assert.equal(await wallet.getChainId(), 42161);
  assert.equal(wallet.account.toLowerCase(), WALLET.toLowerCase());
  const submitted = JSON.parse(calls[1].init.body);
  assert.deepEqual(submitted.transaction, {
    to: TOKEN, chainId: 42161, value: "0",
    data: "0x095ea7b300000000000000000000000000000000000000000000000000000000000000a1000000000000000000000000000000000000000000000000000000000007a120",
  });
  assert.equal(submitted.waitForConfirmation, false);
});

test("Bankr v4 custody adapter refuses a rotated key", async () => {
  await assert.rejects(createBankrV4WalletClient({
    apiKey: "bk_test", expectedWallet: WALLET, chainId: 42161, executeEnabled: true,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      success: true, wallets: [{ chain: "evm", address: TOKEN }],
    }) }),
  }), /does not match/);
});
