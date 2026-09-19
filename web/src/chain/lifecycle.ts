import type { Hash, Hex } from "viem";

/** One permanently recorded transaction in the demo series' life. */
export interface LifecycleTx {
  step: "submitObservation" | "settle" | "redeem";
  hash: Hash;
  note: string;
}

/** sha256 of the canonical 2026-09-17 newsletter body, as recorded by the oracle. */
export const SETTLEMENT_EMAIL_ID: Hex =
  "0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1";

/** Series 0's full life on Gnosis mainnet, settled with the real
 * 2026-09-17 CRE Daily newsletter. */
export const LIFECYCLE_TXS: readonly LifecycleTx[] = [
  {
    step: "submitObservation",
    hash: "0x6370f8ad14ec73b4a7b1d7c030fecf6fcc3484eb128d64d89e1b4c41d37cb0c6",
    note: "The 102 KB email body DKIM-verified inside the EVM; $92.88 / SF extracted on-chain (block 48320714).",
  },
  {
    step: "settle",
    hash: "0xf7572e1f0886141324fa65af2ca2a3deccec9b6f0450624c21af8707db8922fc",
    note: "Payout ratio fixed at 0.61 = clamp((9288 − 8800) / (9600 − 8800)).",
  },
  {
    step: "redeem",
    hash: "0xa3fabcc5580055b4bac50f6e470922202f3bff54f214fcf5e625f19d8176f2d9",
    note: "Cover units burned for 0.61 WXDAI per unit of max claim.",
  },
];
