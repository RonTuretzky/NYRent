/**
 * decodeTxError classification matrix: wallet rejection (code/class before
 * message), transport/network failures, decoded reverts (named, raw-data
 * fallback, OZ inherited), and the bare-revert allowance heuristic.
 *
 * Run: cd web && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
} from "viem";

import {
  decodeTxError,
  isErrorNamed,
  isNetworkError,
  isUserRejection,
} from "../chain/errors.ts";
import { coverTokenAbi } from "../chain/abi.ts";

// ---------------------------------------------------------------- rejection

test("reject: viem UserRejectedRequestError instance", () => {
  const err = new UserRejectedRequestError(
    new Error("User rejected the request."),
  );
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "UserRejected");
  assert.equal(decoded.kind, "rejected");
  assert.match(decoded.message, /rejected the transaction/i);
});

test("reject: EIP-1193 code 4001 with non-standard phrasing (Rabby-style)", () => {
  const decoded = decodeTxError({ code: 4001, message: "Rejected by user" });
  assert.equal(decoded.name, "UserRejected");
  assert.equal(decoded.kind, "rejected");
});

test("reject: code 4001 nested in a BaseError cause chain", () => {
  const inner = Object.assign(new Error("Provider error"), { code: 4001 });
  const err = new BaseError("Request failed.", { cause: inner });
  assert.equal(isUserRejection(err), true);
  assert.equal(decodeTxError(err).name, "UserRejected");
});

test("reject: MetaMask-style message fallback without a code", () => {
  const decoded = decodeTxError(
    new Error("MetaMask Tx Signature: User denied transaction signature."),
  );
  assert.equal(decoded.name, "UserRejected");
});

// ------------------------------------------------------------------ network

test("network: HttpRequestError classifies as kind network, not failed-revert", () => {
  const err = new HttpRequestError({
    url: "https://rpc.gnosischain.com",
    details: "Failed to fetch",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "Network");
  assert.equal(decoded.kind, "network");
  assert.match(decoded.message, /RPC/);
  assert.match(decoded.message, /try again/i);
});

test("network: viem TimeoutError classifies as kind network", () => {
  const err = new TimeoutError({
    body: { method: "eth_call" },
    url: "https://rpc.gnosischain.com",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.kind, "network");
});

test("network: bare fetch TypeError classifies as kind network", () => {
  const decoded = decodeTxError(new TypeError("Failed to fetch"));
  assert.equal(decoded.name, "Network");
  assert.equal(decoded.kind, "network");
});

test("network: a contract revert is NOT a network error", () => {
  const abi = parseAbi(["error SaleClosed()"]);
  const err = new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName: "SaleClosed" }),
    functionName: "buyCover",
  });
  assert.equal(isNetworkError(err), false);
});

// ------------------------------------------------------------------- revert

test("revert: named custom error maps to human copy", () => {
  const abi = parseAbi(["error SaleClosed()"]);
  const err = new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName: "SaleClosed" }),
    functionName: "buyCover",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "SaleClosed");
  assert.equal(decoded.kind, "revert");
  assert.match(decoded.message, /sale window ended/i);
  assert.equal(isErrorNamed(err, "SaleClosed"), true);
});

test("revert: raw-data fallback decodes against the combined ABI", () => {
  // Constructed with an ABI that lacks the error, so viem leaves only `raw`.
  const err = new ContractFunctionRevertedError({
    abi: parseAbi(["error Unrelated()"]),
    data: encodeErrorResult({
      abi: parseAbi(["error AlreadyRecorded()"]),
      errorName: "AlreadyRecorded",
    }),
    functionName: "submitObservation",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "AlreadyRecorded");
  assert.match(decoded.message, /already recorded/i);
});

test("revert: ERC1155InsufficientBalance has real copy, not the generic fallback", () => {
  const err = new ContractFunctionRevertedError({
    abi: coverTokenAbi,
    data: encodeErrorResult({
      abi: coverTokenAbi,
      errorName: "ERC1155InsufficientBalance",
      args: ["0x0000000000000000000000000000000000000001", 0n, 2n, 0n],
    }),
    functionName: "redeem",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "ERC1155InsufficientBalance");
  assert.match(decoded.message, /no longer hold/i);
  assert.doesNotMatch(decoded.message, /The contract reverted with/);
});

test("revert: ReentrancyGuardReentrantCall is decodable via raw selector", () => {
  const err = new ContractFunctionRevertedError({
    abi: parseAbi(["error Unrelated()"]),
    data: encodeErrorResult({
      abi: parseAbi(["error ReentrancyGuardReentrantCall()"]),
      errorName: "ReentrancyGuardReentrantCall",
    }),
    functionName: "redeem",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "ReentrancyGuardReentrantCall");
  assert.match(decoded.message, /reentrancy guard/i);
});

test("revert: empty revert data suggests re-approving (WXDAI allowance race)", () => {
  const err = new ContractFunctionRevertedError({
    abi: parseAbi(["error Unrelated()"]),
    functionName: "transferFrom",
  });
  const decoded = decodeTxError(err);
  assert.equal(decoded.name, "Reverted");
  assert.equal(decoded.kind, "revert");
  assert.match(decoded.message, /approve again/i);
});

test("revert: deleted dead copy keys fall back to the generic message", () => {
  // SalePaused was an alias never emitted by the contracts; its copy is gone.
  const abi = parseAbi(["error SalePaused()"]);
  const err = new ContractFunctionRevertedError({
    abi,
    data: encodeErrorResult({ abi, errorName: "SalePaused" }),
    functionName: "buyCover",
  });
  assert.equal(
    decodeTxError(err).message,
    "The contract reverted with SalePaused.",
  );
});
