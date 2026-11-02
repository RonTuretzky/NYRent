import {
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
  HttpRequestError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
  parseAbi,
} from "viem";
import { apartmentsOracleAbi, apartmentsPoolAbi } from "./apartmentsAbi.ts";

/**
 * Errors the policy contracts can raise that are not in the generated pool and
 * oracle ABIs (the claim token and inherited OpenZeppelin guards), so raw
 * revert data still decodes to a name.
 */
const extraErrorsAbi = parseAbi([
  // CoverToken (the claim token)
  "error OnlyPool()",
  "error TransfersDisabled()",
  "error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId)",
  // OpenZeppelin 5.x guards inherited by the deployed contracts
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
]);

const decodeAbis: Abi = [...apartmentsPoolAbi, ...apartmentsOracleAbi, ...extraErrorsAbi] as Abi;

/**
 * Plain fallback copy per custom error. The policy pages rewrite most of these
 * again with policy wording (lib/policy.ts policyError); this is what any other
 * caller sees.
 */
const ERROR_COPY: Record<string, string> = {
  // Oracle
  AlreadyRecorded: "This exact email is already recorded on-chain, so there is no need to submit it again.",
  BadSignature: "The email's DKIM signature did not verify against the pinned key. The file was altered, or it is not an original.",
  BadBodyHash: "The email body does not match its DKIM body hash: it was modified after signing.",
  BadTimestamp: "The email's signing time is in the future beyond the allowed tolerance.",
  MissingFrom: "The signed header block lacks the expected sender.",
  MissingDkimLine: "The signed header block does not end with a dkim-signature line.",
  BadTagPolicy: "A dkim-signature tag differs from the pinned signing policy.",
  BadModulus: "The pinned RSA modulus is malformed (deployment error).",
  DuplicateTag: "The dkim-signature line contains a duplicated tag.",
  MalformedTag: "The dkim-signature line contains a malformed tag.",
  BadTimestampTag: "The DKIM t= timestamp tag does not parse.",
  ValueOverflow: "The extracted rent value overflows the allowed range.",
  BadLength: "An input has the wrong length (signature or modulus).",
  // Pool
  SaleClosed: "Buying is closed for this policy: the sale window ended.",
  SalesArePaused: "Sales are paused by the policy creator. Existing protection is unaffected.",
  InvalidSeries: "No policy exists at this id.",
  InvalidParams: "The policy parameters are invalid.",
  ZeroAmount: "Amount must be greater than zero.",
  ZeroAddress: "The recipient address can't be the zero address.",
  CapacityExceeded: "That size would exceed the policy's remaining capacity.",
  PremiumTooHigh: "The premium came out above your maximum. Refresh and try again.",
  PremiumRoundsToZero: "That amount is so small its premium rounds to zero, so the contract rejects it. Enter a slightly larger amount.",
  NotSettled: "This policy has not been settled yet.",
  AlreadySettled: "This policy is already settled.",
  RedeemWindowClosed: "The claim window has closed; what is left returns to the creator.",
  RedeemWindowOpen: "The claim window is still open; the creator can only collect the remainder after it ends.",
  NotCreator: "Only this policy's creator can do that.",
  SeriesClosed: "This policy was cancelled by its creator before anything was sold.",
  AlreadySold: "Protection has already been sold on this policy, so it can no longer be cancelled.",
  ResidualAlreadyWithdrawn: "The creator's remaining funds already left this policy.",
  // Token and OpenZeppelin
  OnlyPool: "Only the pool contract may mint or burn claims.",
  TransfersDisabled: "Claims are non-transferable.",
  ERC1155InsufficientBalance:
    "You no longer hold that much protection: your balance changed since this page loaded. Refresh and try a smaller amount.",
  SafeERC20FailedOperation:
    "The currency transfer failed: your balance or allowance changed since this page loaded. Check both, approve again if needed, and retry.",
  ReentrancyGuardReentrantCall: "The call re-entered the pool mid-transaction and was blocked by the reentrancy guard.",
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
      // Bare revert with no data at all: some tokens revert like this when a
      // transfer exceeds balance or allowance, usually an allowance that was
      // spent or revoked since the page loaded.
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
