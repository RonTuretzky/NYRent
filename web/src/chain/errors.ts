import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  parseAbi,
  type Hex,
} from "viem";
import { allAbis } from "./contracts";

/**
 * Error signatures read from the actual contracts (src/*.sol) — kept here as
 * a supplement so custom errors decode even where lib/abi.ts and the deployed
 * bytecode drift (error selectors include parameter types).
 */
const contractErrorsAbi = parseAbi([
  // CredailyRentOracle
  "error BadModulus()",
  "error AlreadyRecorded()",
  "error MissingFrom()",
  "error MissingDkimLine()",
  "error BadTagPolicy(string tag)",
  "error BadBodyHash()",
  "error BadTimestamp()",
  "error BadSignature()",
  "error AnchorNotUnique(uint256 count)",
  "error SnapshotNotFound()",
  // Dkim lib
  "error BadLength(string what)",
  "error DuplicateTag(string tag)",
  "error MalformedTag()",
  "error BadTimestampTag()",
  "error ValueOverflow()",
  // CoverPool
  "error NotSponsor()",
  "error InvalidSeries()",
  "error InvalidParams(string what)",
  "error SaleClosed()",
  "error SalesArePaused()",
  "error ZeroAmount()",
  "error CapacityExceeded()",
  "error PremiumTooHigh(uint256 premium, uint256 maxPremium)",
  "error Insolvent()",
  "error AlreadySettled()",
  "error NotSettled()",
  "error ObservationOutOfWindow(uint64 t)",
  "error RedeemWindowClosed()",
  "error InsufficientFreeCapital(uint256 requested, uint256 free)",
  // CoverToken
  "error OnlyPool()",
  "error TransfersDisabled()",
]);

const decodeAbis = [...allAbis, ...contractErrorsAbi];

/** Human copy for every custom error named in the SPEC, plus likely guards. */
const ERROR_COPY: Record<string, string> = {
  // Oracle
  AlreadyRecorded:
    "This exact email is already recorded on-chain — no need to submit it again. You can go straight to settling.",
  BadSignature:
    "The DKIM RSA signature did not verify against the pinned CRE Daily key. The email bytes were altered, or it isn't the authentic newsletter.",
  BadBodyHash:
    "The canonicalized body hash doesn't match the bh= tag in the DKIM signature — the body was modified after signing.",
  AnchorNotUnique:
    "The anchor phrase “Manhattan Office Rent” does not appear exactly once in the email body, so the value can't be extracted unambiguously.",
  BadHeaderStructure:
    "The signed header block is malformed: it must contain the CRE Daily from: line and end with the b=-emptied dkim-signature: line.",
  BadDkimTags:
    "The dkim-signature tags don't match the pinned policy (v=1, rsa-sha256, relaxed/relaxed, d=newyork.credaily.com, s=b37, no l=, empty b=).",
  FutureTimestamp:
    "The DKIM t= timestamp is in the future beyond the allowed one-day tolerance.",
  BadTimestamp:
    "The DKIM t= timestamp is in the future beyond the allowed one-day tolerance.",
  MissingFrom:
    "The signed header block lacks the pinned CRE Daily from: address.",
  MissingDkimLine:
    "The signed header block doesn't end with a dkim-signature: line.",
  BadTagPolicy:
    "A dkim-signature tag violates the pinned policy (v=1, rsa-sha256, relaxed/relaxed, d=newyork.credaily.com, s=b37, no l=, empty b=).",
  SnapshotNotFound:
    "The rent value pattern (“Manhattan Office Rent … Avg Effective … $NN.NN / SF”) wasn't found in the email body.",
  BadModulus: "The pinned RSA modulus is malformed (deployment error).",
  DuplicateTag: "The dkim-signature line contains a duplicated tag.",
  MalformedTag: "The dkim-signature line contains a malformed tag.",
  BadTimestampTag: "The DKIM t= timestamp tag doesn't parse.",
  ValueOverflow: "The extracted rent value overflows the allowed range.",
  BadLength: "An input has the wrong length (signature or modulus).",
  // Pool
  SaleClosed: "Buying is closed for this series — the sale window ended or the series has already settled.",
  SalePaused: "Sales are currently paused by the sponsor.",
  SalesArePaused: "Sales are currently paused by the sponsor.",
  InvalidSeries: "No series exists at this id.",
  InvalidParams: "Series parameters are invalid.",
  ZeroAmount: "Amount must be greater than zero.",
  CapacityExceeded:
    "That size would exceed the series' remaining capacity.",
  InsufficientSolvency:
    "The pool doesn't hold enough free capital to fully back that claim — the buy would break solvency.",
  Insolvent:
    "The pool doesn't hold enough free capital to fully back that claim — the buy would break solvency.",
  InsufficientFreeCapital:
    "Amount exceeds the pool's free (unreserved) capital.",
  OnlyPool: "Only the pool contract may mint or burn cover tokens.",
  PremiumTooHigh:
    "The premium moved above your maximum — increase your slippage allowance or lower the size.",
  NotSettled: "This series has not been settled yet.",
  AlreadySettled: "This series is already settled (settlement is one-shot).",
  ObservationOutOfWindow:
    "That observation's timestamp falls outside this series' observation window.",
  RedeemWindowClosed:
    "The redemption window has closed; remaining reserves have been released to the pool.",
  NotSponsor: "Only the sponsor wallet can perform this action.",
  TransfersDisabled:
    "Cover tokens are non-transferable in this demo (mint and redeem only).",
};

export interface DecodedTxError {
  /** short machine-ish name, e.g. AlreadyRecorded or "UserRejected" */
  name: string;
  /** human copy for the UI */
  message: string;
  /** raw detail for the expandable section */
  detail?: string;
}

function copyFor(errorName: string, args?: readonly unknown[]): string {
  const known = ERROR_COPY[errorName];
  if (known) return known;
  const argStr =
    args && args.length > 0 ? ` (${args.map(String).join(", ")})` : "";
  return `The contract reverted with ${errorName}${argStr}.`;
}

/** Decode any error thrown by viem/wagmi writes or simulations into human copy. */
export function decodeTxError(error: unknown): DecodedTxError {
  if (error instanceof BaseError) {
    // user rejected in wallet
    if (
      error.walk(
        (e) =>
          e instanceof Error &&
          /User rejected|user rejected|denied transaction/i.test(e.message),
      )
    ) {
      return {
        name: "UserRejected",
        message: "You rejected the transaction in your wallet.",
      };
    }

    const revert = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;

    if (revert) {
      const errName = revert.data?.errorName;
      if (errName) {
        return {
          name: errName,
          message: copyFor(errName, revert.data?.args),
          detail: revert.shortMessage,
        };
      }
      // Try decoding raw revert data against our combined ABI.
      const raw = (revert as unknown as { raw?: Hex }).raw;
      if (raw) {
        try {
          const decoded = decodeErrorResult({ abi: decodeAbis, data: raw });
          return {
            name: decoded.errorName,
            message: copyFor(decoded.errorName, decoded.args),
            detail: revert.shortMessage,
          };
        } catch {
          /* fall through */
        }
      }
      return {
        name: "Reverted",
        message: "The transaction reverted without a recognizable reason.",
        detail: revert.shortMessage,
      };
    }

    return {
      name: "Error",
      message: error.shortMessage,
      detail: error.message,
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return { name: "Error", message: msg };
}

export function isErrorNamed(error: unknown, name: string): boolean {
  return decodeTxError(error).name === name;
}
