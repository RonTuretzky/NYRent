import { useCallback, useState } from "react";
import {
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { useConfig } from "wagmi";
import {
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { decodeTxError, type DecodedTxError } from "./errors";
import { pushTxToast, updateTxToast } from "./txToasts";

export type TxState =
  | { status: "idle" }
  | { status: "simulating" }
  | { status: "wallet" }
  | { status: "pending"; hash: Hex }
  | { status: "confirmed"; hash: Hex; receipt: TxReceiptLite }
  /** Submitted but not confirmed within the wait window (or the RPC dropped
   * mid-wait) — the tx may still mine; hash kept for the explorer link. */
  | { status: "stillPending"; hash: Hex; error: DecodedTxError }
  | { status: "reverted"; hash?: Hex; error: DecodedTxError };

export interface TxReceiptLite {
  blockNumber: bigint;
  logs: { address: Address; data: Hex; topics: readonly Hex[] }[];
}

export interface TxRequest {
  abi: Abi;
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
}

const RECEIPT_TIMEOUT_MS = 120_000;

/**
 * One write flow: simulate (decoded custom errors surface BEFORE the wallet
 * opens) → wallet signature → pending → confirmed / reverted. From the moment
 * a hash exists the lifecycle is mirrored into the toast store, so navigating
 * away doesn't lose an in-flight transaction. Speed-ups/cancels are followed
 * via onReplaced: the state tracks the replacement hash, and a wallet-side
 * cancel is reported as cancelled rather than confirmed.
 */
export function useTx(hookOpts?: { label?: string }) {
  const config = useConfig();
  const [state, setState] = useState<TxState>({ status: "idle" });
  const defaultLabel = hookOpts?.label;

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const send = useCallback(
    async (
      req: TxRequest,
      opts?: {
        label?: string;
        /** Optional decoded-error rewrite (e.g. friendly swap-revert copy);
         * applied before the error reaches BOTH the inline state and the
         * global toast, so the two never disagree. */
        transformError?: (e: DecodedTxError) => DecodedTxError;
      },
    ): Promise<TxState> => {
      const label = opts?.label ?? defaultLabel ?? req.functionName;
      const transformError = opts?.transformError ?? ((e: DecodedTxError) => e);
      let hash: Hex | undefined;
      let toastId: string | undefined;
      let replacement:
        | { reason: "repriced" | "cancelled" | "replaced"; hash: Hex }
        | undefined;
      let final: TxState;
      try {
        setState({ status: "simulating" });
        const sim = await simulateContract(config, {
          abi: req.abi,
          address: req.address,
          functionName: req.functionName,
          args: req.args as never,
          account: req.account,
        });
        setState({ status: "wallet" });
        hash = await writeContract(config, sim.request);
        setState({ status: "pending", hash });
        toastId = pushTxToast({ hash, label, status: "pending" });
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          timeout: RECEIPT_TIMEOUT_MS,
          onReplaced: (r) => {
            replacement = { reason: r.reason, hash: r.transaction.hash };
            hash = r.transaction.hash;
            setState({ status: "pending", hash: r.transaction.hash });
            if (toastId) {
              updateTxToast(toastId, {
                hash: r.transaction.hash,
                status: "replaced",
              });
            }
          },
        });
        const minedHash = receipt.transactionHash;
        if (replacement?.reason === "cancelled") {
          const error: DecodedTxError = {
            name: "Cancelled",
            kind: "rejected",
            message:
              "You cancelled this transaction in your wallet before it was mined — nothing was executed.",
          };
          final = { status: "reverted", hash: minedHash, error };
          if (toastId) {
            updateTxToast(toastId, {
              hash: minedHash,
              status: "failed",
              error: error.message,
            });
          }
        } else if (receipt.status === "reverted") {
          const error: DecodedTxError = {
            name: "Reverted",
            kind: "revert",
            message: "The transaction was mined but reverted on-chain.",
          };
          final = { status: "reverted", hash: minedHash, error };
          if (toastId) {
            updateTxToast(toastId, {
              hash: minedHash,
              status: "failed",
              error: error.message,
            });
          }
        } else {
          final = {
            status: "confirmed",
            hash: minedHash,
            receipt: {
              blockNumber: receipt.blockNumber,
              logs: receipt.logs.map((l) => ({
                address: l.address,
                data: l.data,
                topics: l.topics,
              })),
            },
          };
          if (toastId) {
            updateTxToast(toastId, { hash: minedHash, status: "confirmed" });
          }
        }
      } catch (error) {
        const decoded = transformError(decodeTxError(error));
        const timedOut = error instanceof WaitForTransactionReceiptTimeoutError;
        if (hash && (timedOut || decoded.kind === "network")) {
          // The tx was submitted; only the wait failed. Keep the hash and
          // report "still pending" — distinctly NOT a failure.
          const stillPending: DecodedTxError = {
            name: "StillPending",
            kind: "network",
            message: timedOut
              ? `Not confirmed after ${RECEIPT_TIMEOUT_MS / 1000} seconds — it may still go through. Track it on the explorer before re-submitting.`
              : "Lost contact with the RPC while waiting — the transaction may still confirm. Track it on the explorer before re-submitting.",
            detail: decoded.detail ?? decoded.message,
          };
          final = { status: "stillPending", hash, error: stillPending };
          if (toastId) {
            updateTxToast(toastId, {
              status: "pending",
              error: stillPending.message,
            });
          }
        } else {
          final = { status: "reverted", hash, error: decoded };
          if (toastId && hash) {
            updateTxToast(toastId, { status: "failed", error: decoded.message });
          }
        }
      }
      setState(final);
      return final;
    },
    [config, defaultLabel],
  );

  return { state, send, reset };
}
