/**
 * Pure helpers behind the neighborhood-policy pages: lifecycle status in plain
 * words, key dates, worked dollar examples, form validation, URL ids, upload
 * checks and the policy-specific copy for every contract error. No React, no
 * JSON imports, so `node --test` covers all of it (policy.test.ts).
 */
import type { DecodedTxError } from "../chain/errors.ts";

export const WAD = 10n ** 18n;

/** The on-chain Series struct as the ABI returns it. */
export interface PolicyRow {
  creator: `0x${string}`;
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  obsMonth: number;
  settled: boolean;
  voided: boolean;
  cancelled: boolean;
  residualWithdrawn: boolean;
  saleEnd: bigint;
  finalizeAt: bigint;
  redeemEnd: bigint;
  payoutRatioWad: bigint;
  observationT: bigint;
  escrow: bigint;
  sold: bigint;
  premiumsAccrued: bigint;
  paidOut: bigint;
  slugHash: `0x${string}`;
  emailId: `0x${string}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyPhase =
  | "onSale"
  | "paused"
  | "soldOut"
  | "awaitingData"
  | "readyToFinalize"
  | "settled"
  | "void"
  | "claimsClosed"
  | "cancelled";

export interface PolicyStatus {
  phase: PolicyPhase;
  /** Short badge text. */
  label: string;
  /** One plain sentence: what happens next for anyone looking at it. */
  next: string;
}

export function policyStatus(s: PolicyRow, now: bigint, paused = false): PolicyStatus {
  if (s.cancelled) {
    return { phase: "cancelled", label: "Cancelled", next: "The creator took the escrow back before anything sold. Nothing more happens here." };
  }
  if (s.settled) {
    const pct = ratioPercent(s.payoutRatioWad);
    return {
      phase: "settled",
      label: "Settled",
      next: pct === 0
        ? "The recorded rent stayed at or below the starting rent, so claims pay $0. Nothing to collect."
        : `The recorded rent set the payout at ${pct}% of each claim. Holders claim it from this page.`,
    };
  }
  if (s.voided) {
    return { phase: "void", label: "Void: premiums refundable", next: "No qualifying email arrived, so buyers take their premium back and the creator takes the escrow back." };
  }
  if (now > s.redeemEnd) {
    return { phase: "claimsClosed", label: "Claims closed", next: "The claim window ended. Whatever is left returns to the creator." };
  }
  if (now >= s.finalizeAt) {
    return { phase: "readyToFinalize", label: "Ready to finalize", next: "Anyone can finalize now. Claiming finalizes automatically." };
  }
  if (now < s.saleEnd) {
    if (paused) return { phase: "paused", label: "Sales paused", next: "The creator paused new sales. Existing protection is unaffected." };
    if (s.escrow - s.sold === 0n) return { phase: "soldOut", label: "Sold out", next: "All the escrow is spoken for. Sales close anyway when the month starts." };
    return { phase: "onSale", label: "On sale", next: "Buy protection until the policy month starts; after that the month's first Google Alert sets the rent." };
  }
  return { phase: "awaitingData", label: "Awaiting rent data", next: "Anyone with the month's alert email can record it. Finalizing opens seven days after the month ends." };
}

export function ratioPercent(ratioWad: bigint): number {
  return Number((ratioWad * 10_000n) / WAD) / 100;
}

/** "in 3 days", "in 2 hours", "4 days ago": the human reading of a timestamp. */
export function humanDelta(at: bigint, now: bigint): string {
  const diff = Number(at - now);
  const abs = Math.abs(diff);
  const unit = abs >= 2 * 86400 ? [Math.round(abs / 86400), "day"] as const
    : abs >= 3600 ? [Math.round(abs / 3600), "hour"] as const
    : abs >= 60 ? [Math.round(abs / 60), "minute"] as const
    : null;
  if (!unit) return diff >= 0 ? "in under a minute" : "just now";
  const [n, word] = unit;
  const text = `${n} ${word}${n === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export interface KeyDate {
  label: string;
  at: bigint;
  /** What this date means for the reader. */
  note: string;
}

/** Every date a buyer or creator needs, in order. */
export function policyDates(s: Pick<PolicyRow, "saleEnd" | "finalizeAt" | "redeemEnd" | "obsMonth">): KeyDate[] {
  return [
    { label: "Sales close", at: s.saleEnd, note: "Last moment to buy protection. The policy month starts right after." },
    { label: "Record window", at: s.finalizeAt, note: "Until this time, anyone can record the month's alert email. The earliest-signed one counts." },
    { label: "Claims open", at: s.finalizeAt, note: "From this time anyone can finalize, and buyers can claim." },
    { label: "Claims close", at: s.redeemEnd, note: "Unclaimed money returns to the creator after this." },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Worked examples
// ─────────────────────────────────────────────────────────────────────────────

export interface BuyExample {
  premium: bigint;
  maxClaim: bigint;
  /** Rent halfway between the strikes and what it pays. */
  midCents: number;
  midPayout: bigint;
}

export function buyExample(maxClaim: bigint, premiumRateBps: number, lowCents: number, highCents: number): BuyExample {
  const midCents = Math.round((lowCents + highCents) / 2);
  const ratio = payoutRatioWad(midCents, lowCents, highCents);
  return {
    maxClaim,
    premium: (maxClaim * BigInt(premiumRateBps)) / 10_000n,
    midCents,
    midPayout: (maxClaim * ratio) / WAD,
  };
}

/** Exactly the contract's ratio arithmetic. */
export function payoutRatioWad(cents: number, lowCents: number, highCents: number): bigint {
  if (cents >= highCents) return WAD;
  if (cents <= lowCents) return 0n;
  return (BigInt(cents - lowCents) * WAD) / BigInt(highCents - lowCents);
}

export interface CreatorExample {
  /** Premiums if every unit sells. */
  bestCase: bigint;
  /** Full capacity paid out, premiums kept. Negative means a loss. */
  worstCase: bigint;
}

export function creatorExample(capacity: bigint, premiumRateBps: number): CreatorExample {
  const premiums = (capacity * BigInt(premiumRateBps)) / 10_000n;
  return { bestCase: premiums, worstCase: premiums - capacity };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Currency amount typed by a user → smallest units, with a reason when not. */
export function parseAmount(raw: string, decimals: number, what = "amount"): Parsed<bigint> {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return { ok: false, error: `Enter ${aOrAn(what)} ${what}.` };
  if (!/^\d*\.?\d*$/.test(text) || text === ".") return { ok: false, error: `Use digits only for the ${what}, like 25 or 12.50.` };
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > decimals) return { ok: false, error: `Use at most ${decimals} decimal places.` };
  const units = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (units === 0n) return { ok: false, error: `The ${what} must be more than zero.` };
  if (units >= 2n ** 128n) return { ok: false, error: `That ${what} is too large.` };
  return { ok: true, value: units };
}

/** A rent in dollars per month → integer cents (whole dollars or cents). */
export function parseRentDollars(raw: string, what = "rent"): Parsed<number> {
  const text = raw.trim().replace(/[$,]/g, "");
  if (text === "") return { ok: false, error: `Enter the ${what}.` };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: `Enter the ${what} in dollars, like 3100 or 3100.50.` };
  const cents = Math.round(Number(text) * 100);
  if (cents <= 0) return { ok: false, error: `The ${what} must be more than $0.` };
  if (cents > 4_294_967_295) return { ok: false, error: `The ${what} is too large.` };
  return { ok: true, value: cents };
}

/** Premium percent → basis points. */
export function parsePremiumPercent(raw: string): Parsed<number> {
  const text = raw.trim().replace(/%/g, "");
  if (text === "") return { ok: false, error: "Enter a premium percentage." };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: "Enter the premium as a percentage with up to two decimals, like 10 or 7.5." };
  const bps = Math.round(Number(text) * 100);
  if (bps > 10_000) return { ok: false, error: "The premium cannot be more than 100% of the payout." };
  return { ok: true, value: bps };
}

function aOrAn(word: string) {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** `/policies/:id` → bigint, or null for anything that is not a plain integer. */
export function parsePolicyId(raw: string | undefined): bigint | null {
  if (raw === undefined || !/^\d{1,20}$/.test(raw)) return null;
  try {
    const id = BigInt(raw);
    return id < 2n ** 64n ? id : null;
  } catch {
    return null;
  }
}

export const MAX_EML_BYTES = 1024 * 1024;

/** Cheap checks before an upload is parsed: type and size. */
export function fileProblem(file: { name: string; size: number; type: string }): string | null {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const emlLike = ext === "eml" || file.type === "message/rfc822";
  if (!emlLike) {
    return `"${file.name}" is not an email file. In Gmail open the alert, choose "Download message" from the three-dot menu, and upload the .eml it saves.`;
  }
  if (file.size === 0) return "That file is empty. Download the message again from Gmail.";
  if (file.size > MAX_EML_BYTES) {
    return `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB; an alert email is well under 1 MB. Upload the original alert, not a forward or a digest with attachments.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Alert setup
// ─────────────────────────────────────────────────────────────────────────────

export function pageUrl(slug: string) {
  return `https://www.apartments.com/rent-market-trends/${slug}/`;
}

/** The Google Alert settings that produce a qualifying email for one page. */
export function alertRecipe(slug: string) {
  return {
    query: pageUrl(slug),
    howOften: "As-it-happens",
    sources: "Automatic",
    language: "English",
    region: "Any Region",
    howMany: "All results",
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journeys
// ─────────────────────────────────────────────────────────────────────────────

export interface JourneyStep {
  title: string;
  detail: string;
}

export const RENTER_STEPS: JourneyStep[] = [
  { title: "Pick a policy", detail: "Choose the neighborhood page and month that matter to you, and read what it pays." },
  { title: "Get USDC and a little ETH", detail: "Both on Arbitrum One: USDC to pay the premium, ETH for network fees." },
  { title: "Connect your wallet", detail: "On Arbitrum One. The page offers a switch button if your wallet is elsewhere." },
  { title: "Approve, then buy", detail: "Two confirmations: one lets the contract take your premium, the next buys." },
  { title: "Wait for the month", detail: "Sales close when the month starts. The first Google-signed alert of the month sets the rent." },
  { title: "Claim or get refunded", detail: "From seven days after the month ends, claim what the rent earned you, or your premium back if no email arrived." },
];

export const CREATOR_STEPS: JourneyStep[] = [
  { title: "Choose the terms", detail: "Neighborhood, month, the rent where payouts start and reach 100%, and the premium." },
  { title: "Understand the exposure", detail: "You can lose the whole escrow if the rent reaches the full-payout level; you keep every premium either way." },
  { title: "Get USDC and a little ETH", detail: "Both on Arbitrum One: USDC for the escrow, ETH for network fees." },
  { title: "Approve, then create", detail: "Two confirmations: one lets the contract take the escrow, the next opens the policy." },
  { title: "Share the policy", detail: "Send the link. Premiums accrue inside the policy as people buy; cancel any time nothing has sold." },
  { title: "Collect what remains", detail: "After claims close, withdraw the escrow that was not paid out plus all premiums." },
];

export const RECORDER_STEPS: JourneyStep[] = [
  { title: "Set up the Google Alert", detail: "Use the exact page address as the query, As-it-happens, All results, delivered to a mailbox you dedicate to alerts." },
  { title: "Download the original email", detail: "In Gmail open the alert, pick \"Download message\" from the three-dot menu, keep the .eml unchanged." },
  { title: "Upload and preview", detail: "Your browser reads it locally and shows exactly which rent the contract would record." },
  { title: "Publish and record", detail: "One confirmation. The whole email becomes public forever, so use a dedicated mailbox." },
  { title: "Finalize", detail: "Seven days after the month ends anyone finalizes; claiming does it automatically." },
];

// ─────────────────────────────────────────────────────────────────────────────
// Error copy
// ─────────────────────────────────────────────────────────────────────────────

/** Policy-page copy for every contract error plus wallet and gas conditions. */
export const POLICY_ERROR_COPY: Record<string, string> = {
  // Pool
  InvalidSeries: "There is no policy with this number. Check the link, or pick one from the list.",
  InvalidParams: "The contract refused these terms. Check the month is in the future, the full-payout rent is above the starting rent, the premium is 100% or less and the escrow is more than zero.",
  SaleClosed: "Sales for this policy closed while you were on the page: the policy month has started. Nothing was charged. Look for a policy on a later month.",
  SalesArePaused: "The creator paused sales on this policy. Nothing was charged. Try again later or choose another policy.",
  SeriesClosed: "This policy was cancelled by its creator before anything sold. Nothing can be bought or claimed here.",
  ZeroAmount: "Enter an amount above zero.",
  ZeroAddress: "The recipient address is missing. Reconnect your wallet and try again.",
  CapacityExceeded: "Someone bought part of this policy while you were looking, so less is available now. The numbers on the page were refreshed; choose an amount within what is left.",
  PremiumTooHigh: "The premium came out higher than the amount you approved. Refresh the page and try again.",
  PremiumRoundsToZero: "That amount is so small the premium rounds to zero, so the contract refuses it. Enter a slightly larger amount.",
  AlreadyFinalized: "This policy was already finalized. Refresh to see the result and claim.",
  TooEarly: "Claims open seven days after the policy month ends, so an earlier-signed email can still be recorded. Come back after the date shown.",
  RedeemWindowClosed: "The claim window for this policy has closed. Whatever is left returns to the creator.",
  RedeemWindowOpen: "Buyers can still claim. The remaining funds unlock for you after claims close.",
  NotCreator: "Only the wallet that created this policy can do that.",
  AlreadySold: "Protection has been sold on this policy, so it cannot be cancelled. Your escrow returns after claims close.",
  ResidualAlreadyWithdrawn: "The remaining funds of this policy were already withdrawn.",
  // Oracle
  AlreadyRecorded: "This exact email is already recorded. Nothing to do; the policy will use it.",
  NoQualifyingResult: "The contract found no rent sentence it accepts in this email: it needs \"As of <Month> <Year>, the average rent in <Name> was $n/mo.\" for an Apartments.com rent-trends page, signed during that month.",
  BadSignature: "Google's signature does not verify for this file. It was changed after Google sent it, or it is not an original Google Alert. Download the message again from Gmail.",
  BadBodyHash: "The email body does not match Google's signature. Download the original message again; do not edit, forward or re-save it.",
  BadTimestamp: "The signing time in this email is in the future, so the contract rejects it. Wait until that time has passed.",
  MissingFrom: "This email was not sent by Google Alerts.",
  MissingDkimLine: "The email's signature block is incomplete. Download the original message again.",
  BadTagPolicy: "This email was signed differently from Google Alerts (a different key or settings), so the contract cannot accept it.",
  BadModulus: "The oracle's key is malformed. This is a deployment problem, not something you can fix.",
  MissingBoundary: "The email layout is not the Google Alert format the contract reads.",
  BadMimeLayout: "The email layout is not the Google Alert format the contract reads.",
  BadQuotedPrintable: "The email body is encoded in a way the contract cannot read. Download the original message again.",
  MissingMarkup: "This email has no Google Alert result block, so there is nothing to record.",
  MalformedJson: "The result block inside this email is malformed, so the contract refuses it.",
  BadMonth: "The month in this email is outside the range the contract accepts.",
  BadLength: "The signature or key has the wrong length. Download the original message again.",
  DuplicateTag: "The email's signature line is malformed (duplicate tag).",
  MalformedTag: "The email's signature line is malformed.",
  BadTimestampTag: "The email's signing time is unreadable.",
  ValueOverflow: "A number in this email is too large for the contract.",
  // Token and OpenZeppelin
  OnlyPool: "Only the policy contract can create or burn claims.",
  TransfersDisabled: "Claims cannot be transferred, only claimed by the wallet that bought them.",
  ERC1155InsufficientBalance: "You no longer hold that much protection on this policy. Refresh and claim what you hold.",
  SafeERC20FailedOperation: "The USDC transfer failed, usually because the approval was spent or your balance changed. Approve again, then retry.",
  ReentrancyGuardReentrantCall: "The contract blocked a re-entering call. Try again.",
};

const GAS_RE = /insufficient funds|exceeds the balance of the account|gas required exceeds allowance|intrinsic gas/i;

/**
 * Rewrites a decoded error into policy-page language. Applied through
 * useTx's transformError so the inline status and the toast agree.
 */
export function policyError(decoded: DecodedTxError, nativeSymbol = "ETH"): DecodedTxError {
  const copy = POLICY_ERROR_COPY[decoded.name];
  if (copy) return { ...decoded, message: copy };
  if (decoded.kind === "rejected") {
    return { ...decoded, message: "You cancelled in your wallet, so nothing was sent and nothing was charged. Click the button again when you are ready." };
  }
  if (decoded.kind === "network") {
    return { ...decoded, message: "The network could not be reached. Check your connection and try again; nothing was charged unless the status above shows a transaction link." };
  }
  const haystack = `${decoded.message} ${decoded.detail ?? ""}`;
  if (GAS_RE.test(haystack)) {
    return {
      ...decoded,
      name: "NoGas",
      message: `Your wallet has no ${nativeSymbol} to pay the network fee. Send a small amount of ${nativeSymbol} on this network (a few dollars' worth lasts many transactions), then try again.`,
    };
  }
  if (/allowance|transfer amount exceeds/i.test(haystack)) {
    return { ...decoded, name: "Allowance", message: "The approval no longer covers this amount. Approve again, then retry." };
  }
  return decoded;
}
