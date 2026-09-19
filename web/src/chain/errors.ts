import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
  parseAbi,
} from "viem";
import { allAbis } from "./contracts.ts";

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
  // CoverPool (permissionless — no roles, per-series accounting)
  "error NotCreator()",
  "error ZeroAddress()",
  "error InvalidSeries()",
  "error InvalidParams(string what)",
  "error SaleClosed()",
  "error SalesArePaused()",
  "error SeriesClosed()",
  "error ZeroAmount()",
  "error CapacityExceeded()",
  "error PremiumTooHigh(uint256 premium, uint256 maxPremium)",
  "error PremiumRoundsToZero()",
  "error AlreadySettled()",
  "error NotSettled()",
  "error ObservationOutOfWindow(uint64 t)",
  "error RedeemWindowClosed()",
  "error RedeemWindowOpen()",
  "error AlreadySold()",
  "error ResidualAlreadyWithdrawn()",
  // SwapAndBuyRouter
  "error InvalidPath(string what)",
  "error NativeInputNotWeth()",
  "error NativeValueMismatch(uint256 value, uint256 amountInMaximum)",
  // CoverToken
  "error OnlyPool()",
  "error TransfersDisabled()",
  // OpenZeppelin 5.x guards inherited by the deployed contracts
  "error ReentrancyGuardReentrantCall()",
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
    "The configured rent-index anchor does not appear exactly once in the email body, so the value can't be extracted unambiguously.",
  BadTimestamp:
    "The DKIM t= timestamp is in the future beyond the allowed one-day tolerance.",
  MissingFrom:
    "The signed header block lacks the pinned CRE Daily from: address.",
  MissingDkimLine:
    "The signed header block doesn't end with a dkim-signature: line.",
  BadTagPolicy:
    "A dkim-signature tag violates the pinned policy (v=1, rsa-sha256, relaxed/relaxed, d=newyork.credaily.com, s=b37, no l=, empty b=).",
  SnapshotNotFound:
    "The required average-effective rent value ($NN.NN / SF) wasn't found after the configured rent-index anchor in the email body.",
  BadModulus: "The pinned RSA modulus is malformed (deployment error).",
  DuplicateTag: "The dkim-signature line contains a duplicated tag.",
  MalformedTag: "The dkim-signature line contains a malformed tag.",
  BadTimestampTag: "The DKIM t= timestamp tag doesn't parse.",
  ValueOverflow: "The extracted rent value overflows the allowed range.",
  BadLength: "An input has the wrong length (signature or modulus).",
  // Pool (permissionless)
  SaleClosed: "Buying is closed for this market — the sale window ended or the market has already settled.",
  SalesArePaused:
    "Sales are currently paused by the market creator. Existing cover is unaffected.",
  InvalidSeries: "No market exists at this id.",
  InvalidParams: "Market parameters are invalid.",
  ZeroAmount: "Amount must be greater than zero.",
  ZeroAddress: "The recipient address can't be the zero address.",
  CapacityExceeded:
    "That size would exceed the market' remaining capacity.",
  OnlyPool: "Only the pool contract may mint or burn RENT.",
  PremiumTooHigh:
    "The price moved above your maximum — refresh the quote or lower the size.",
  PremiumRoundsToZero:
    "That amount is so small its price rounds to zero — nothing would be charged, so the contract rejects it. Enter a slightly larger amount.",
  NotSettled: "This market has not been settled yet.",
  AlreadySettled: "This market is already settled (settlement is one-shot).",
  ObservationOutOfWindow:
    "That observation's timestamp falls outside this market' observation window.",
  RedeemWindowClosed:
    "The claim window has closed; what's left in the market returns to its creator.",
  RedeemWindowOpen:
    "The claim window is still open — the creator can only collect the residual after it ends.",
  NotCreator: "Only this market' creator can perform this action.",
  SeriesClosed:
    "This market was cancelled by its creator before anything was sold — it's permanently closed.",
  AlreadySold:
    "Cover has already been sold on this market, so it can no longer be cancelled — the escrow releases after the claim window instead.",
  ResidualAlreadyWithdrawn:
    "The creator's capital already left this market once (cancel or residual withdrawal) — it can't leave twice.",
  // SwapAndBuyRouter
  InvalidPath:
    "The swap route is malformed — it must run from the pool currency back to the token you're paying with. Refresh and try again.",
  NativeInputNotWeth:
    "Paying with the native coin requires routing through the wrapped native token.",
  NativeValueMismatch:
    "The native coin amount sent doesn't match the swap's input cap. Refresh the quote and try again.",
  TransfersDisabled:
    "RENT are non-transferable (mint and redeem only).",
  // OpenZeppelin 5.x (inherited by the deployed contracts)
  ERC1155InsufficientBalance:
    "You no longer hold that much cover — your balance changed since this page loaded (e.g. a redeem in another tab). Refresh and try a smaller amount.",
  SafeERC20FailedOperation:
    "The currency transfer failed — your balance or allowance changed since this page loaded. Check both, approve again if needed, and retry.",
  ReentrancyGuardReentrantCall:
    "The call re-entered the pool mid-transaction and was blocked by the reentrancy guard.",
};

export type TxErrorKind = "rejected" | "network" | "revert" | "unknown";

export interface DecodedTxError {
  /** short machine-ish name, e.g. AlreadyRecorded or "UserRejected" */
  name: string;
  /** human copy for the UI */
  message: string;
  /** raw detail for the expandable section */
  detail?: string;
  /** coarse classification: wallet rejection / transport failure / on-chain revert */
  kind?: TxErrorKind;
}

function copyFor(errorName: string, args?: readonly unknown[]): string {
  const known = ERROR_COPY[errorName];
  if (known) return known;
  const argStr =
    args && args.length > 0 ? ` (${args.map(String).join(", ")})` : "";
  return `The contract reverted with ${errorName}${argStr}.`;
}

const REJECT_CODE = 4001; // EIP-1193 userRejectedRequest
const RESOURCE_UNAVAILABLE_CODE = -32002; // EIP-1193 resource unavailable

function looksRejected(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const maybe = e as { code?: unknown; name?: unknown; message?: unknown };
  if (e instanceof UserRejectedRequestError) return true;
  if (maybe.code === REJECT_CODE) return true;
  if (maybe.name === "UserRejectedRequestError") return true;
  return (
    typeof maybe.message === "string" &&
    /user rejected|rejected by user|denied transaction|user denied|transaction declined/i.test(
      maybe.message,
    )
  );
}

/** Wallet rejection, detected by EIP-1193 code 4001 / viem's error class first
 * (message phrasing varies across wallets), with a message fallback. */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof BaseError) return !!error.walk((e) => looksRejected(e));
  return looksRejected(error);
}

function looksAlreadyPending(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const maybe = e as { code?: unknown; name?: unknown; message?: unknown };
  if (maybe.code === RESOURCE_UNAVAILABLE_CODE) return true;
  if (maybe.name === "ResourceUnavailableRpcError") return true;
  return (
    typeof maybe.message === "string" &&
    /already pending|already processing/i.test(maybe.message)
  );
}

/** EIP-1193 -32002: the wallet already has a request queued (often behind a
 * locked wallet) — a second one is refused until it's dealt with. */
export function isRequestAlreadyPending(error: unknown): boolean {
  if (error instanceof BaseError) {
    return !!error.walk((e) => looksAlreadyPending(e));
  }
  return looksAlreadyPending(error);
}

function looksLikeTransportFailure(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  if (e instanceof HttpRequestError || e instanceof TimeoutError) return true;
  const message = (e as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /failed to fetch|fetch failed|load failed|network ?error|http request failed/i.test(
      message,
    )
  );
}

/** Transport/network failure (RPC unreachable, HTTP error, timeout) — NOT a
 * contract revert. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof ContractFunctionRevertedError)) {
      return false;
    }
    return !!error.walk((e) => looksLikeTransportFailure(e));
  }
  return looksLikeTransportFailure(error);
}

const NETWORK_COPY =
  "Can't reach the chain's RPC endpoint. Check your internet connection — or the RPC may be briefly down — and try again.";

/** Decode any error thrown by viem/wagmi writes or simulations into human copy. */
export function decodeTxError(error: unknown): DecodedTxError {
  // Classify before decoding: wallet rejection first (code/class, not copy).
  if (isUserRejection(error)) {
    return {
      name: "UserRejected",
      kind: "rejected",
      message: "You rejected the transaction in your wallet.",
    };
  }

  if (isRequestAlreadyPending(error)) {
    return {
      name: "RequestAlreadyPending",
      kind: "unknown",
      message:
        "A request is already pending in your wallet — open the wallet and confirm or dismiss it first. If nothing is shown, the wallet may be locked: unlock it and retry.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (error instanceof BaseError) {
    const revert = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;

    if (revert) {
      const errName = revert.data?.errorName;
      if (errName) {
        return {
          name: errName,
          kind: "revert",
          message: copyFor(errName, revert.data?.args),
          detail: revert.shortMessage,
        };
      }
      // Try decoding raw revert data against our combined ABI.
      const raw = revert.raw;
      if (raw && raw !== "0x") {
        try {
          const decoded = decodeErrorResult({ abi: decodeAbis, data: raw });
          return {
            name: decoded.errorName,
            kind: "revert",
            message: copyFor(decoded.errorName, decoded.args),
            detail: revert.shortMessage,
          };
        } catch {
          /* fall through */
        }
        return {
          name: "Reverted",
          kind: "revert",
          message: "The transaction reverted without a recognizable reason.",
          detail: revert.shortMessage,
        };
      }
      // Bare revert with no data at all: WETH9-style tokens (e.g. WXDAI)
      // revert like this when a transfer exceeds balance or allowance —
      // usually an allowance that was spent or revoked since the page loaded.
      return {
        name: "Reverted",
        kind: "revert",
        message:
          "The transaction reverted without a reason — most often a currency transfer failing because the allowance or balance changed. Approve again, then retry.",
        detail: revert.shortMessage,
      };
    }

    if (isNetworkError(error)) {
      return {
        name: "Network",
        kind: "network",
        message: NETWORK_COPY,
        detail: error.shortMessage,
      };
    }

    return {
      name: "Error",
      kind: "unknown",
      message: error.shortMessage,
      detail: error.message,
    };
  }

  if (isNetworkError(error)) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name: "Network", kind: "network", message: NETWORK_COPY, detail };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return { name: "Error", kind: "unknown", message: msg };
}

export function isErrorNamed(error: unknown, name: string): boolean {
  return decodeTxError(error).name === name;
}
