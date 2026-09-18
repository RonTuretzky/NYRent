import { useCallback, useState } from "react";
import type { Abi, Address, Hex } from "viem";
import { useConfig } from "wagmi";
import {
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { decodeTxError, type DecodedTxError } from "./errors";

export type TxState =
  | { status: "idle" }
  | { status: "simulating" }
  | { status: "wallet" }
  | { status: "pending"; hash: Hex }
  | { status: "confirmed"; hash: Hex; receipt: TxReceiptLite }
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

/**
 * One write flow: simulate (decoded custom errors surface BEFORE the wallet
 * opens) → wallet signature → pending → confirmed / reverted.
 */
export function useTx() {
  const config = useConfig();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const send = useCallback(
    async (req: TxRequest): Promise<TxState> => {
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
        const hash = await writeContract(config, sim.request);
        setState({ status: "pending", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status === "reverted") {
          final = {
            status: "reverted",
            hash,
            error: {
              name: "Reverted",
              message: "The transaction was mined but reverted on-chain.",
            },
          };
        } else {
          final = {
            status: "confirmed",
            hash,
            receipt: {
              blockNumber: receipt.blockNumber,
              logs: receipt.logs.map((l) => ({
                address: l.address,
                data: l.data,
                topics: l.topics,
              })),
            },
          };
        }
      } catch (error) {
        final = { status: "reverted", error: decodeTxError(error) };
      }
      setState(final);
      return final;
    },
    [config],
  );

  return { state, send, reset };
}
