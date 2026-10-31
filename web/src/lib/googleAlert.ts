/**
 * Browser preview of what ApartmentsRentOracle will record from a Google Alert,
 * and the pure policy-term helpers. The contract is the authority; this reading
 * mirrors src/apartments/GoogleAlertParser.sol so a user sees the outcome first.
 */
export interface AlertResult {
  slug: string;
  yyyymm: number;
  cents: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SCRIPT_OPEN = '<script data-scope="inboxmarkup" type="application/json">';
const URL_RE = /^https:\/\/www\.google\.com\/url\?rct=j&sa=t&url=https:\/\/www\.apartments\.com\/rent-market-trends\/([a-z0-9-]+)\/&ct=ga&/;
const TEXT_RE = /^As of ([A-Z][a-z]+) (\d{4}), the average rent in ([A-Za-z -]+?) was \$([1-9]\d{0,2}(?:,\d{3})*)\/mo\./;

function quotedPrintable(body: string): string {
  return body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function monthBounds(yyyymm: number): { start: number; end: number } {
  const year = Math.floor(yyyymm / 100);
  const month = yyyymm % 100;
  return { start: Date.UTC(year, month - 1, 1) / 1000, end: Date.UTC(year, month, 1) / 1000 - 1 };
}

/** Results the oracle would record for a canonical body signed at `t`. */
export function extractAlertResults(canonBody: Uint8Array, t: number): AlertResult[] {
  const raw = new TextDecoder("latin1").decode(canonBody);
  const delimiter = raw.slice(0, raw.indexOf("\r\n"));
  const htmlPart = raw.indexOf(`\r\n${delimiter}\r\n`);
  if (!delimiter.startsWith("--") || htmlPart < 0) return [];
  const text = quotedPrintable(raw.slice(htmlPart));
  const open = text.indexOf(SCRIPT_OPEN);
  if (open < 0) return [];
  const start = open + SCRIPT_OPEN.length;
  const stop = text.indexOf("</script>", start);
  if (stop < 0) return [];
  let cards: { widgets?: { type?: string; url?: string; description?: string }[] }[];
  try {
    cards = JSON.parse(text.slice(start, stop)).cards ?? [];
  } catch {
    return [];
  }
  const results: AlertResult[] = [];
  for (const widget of cards[0]?.widgets ?? []) {
    const url = URL_RE.exec(widget.url ?? "");
    const sentence = TEXT_RE.exec(widget.description ?? "");
    if (widget.type !== "LINK" || !url || !sentence) continue;
    const monthIndex = MONTHS.indexOf(sentence[1]);
    if (monthIndex < 0 || !url[1].startsWith(`${sentence[3].toLowerCase().replace(/ /g, "-")}-`)) continue;
    const yyyymm = Number(sentence[2]) * 100 + monthIndex + 1;
    const { start: from, end } = monthBounds(yyyymm);
    if (t < from || t > end) continue;
    results.push({ slug: url[1], yyyymm, cents: Number(sentence[4].replace(/,/g, "")) * 100 });
  }
  return results;
}

/** Headers published permanently when an email is submitted. */
export function publishedRecipient(signedHeaders: Uint8Array): string | null {
  const text = new TextDecoder("latin1").decode(signedHeaders);
  return /(?:^|\r\n)to:([^\r\n]*)/.exec(text)?.[1]?.trim() ?? null;
}

export const SUBMISSION_GRACE_SECONDS = 7 * 24 * 3600;
export const DEFAULT_CLAIM_SECONDS = 30 * 24 * 3600;

export interface PolicyInput {
  slug: string;
  month: string; // YYYY-MM
  lowDollars: number;
  highDollars: number;
  premiumPercent: number;
}

export interface PolicyTerms {
  obsMonth: number;
  strikeLowCents: number;
  strikeHighCents: number;
  premiumRateBps: number;
  saleEnd: bigint;
  finalizeAt: bigint;
  redeemEnd: bigint;
}

/** Validates form input into immutable contract terms; returns a reason on failure. */
export function policyTerms(input: PolicyInput, now: number): PolicyTerms | string {
  if (!/^[a-z0-9-]{1,96}$/.test(input.slug)) return "Choose a neighborhood page.";
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(input.month)) return "Choose a month.";
  const obsMonth = Number(input.month.replace("-", ""));
  const { start, end } = monthBounds(obsMonth);
  if (start <= now) return "Sales must close before the policy month starts. Choose a later month.";
  const low = Math.round(input.lowDollars * 100);
  const high = Math.round(input.highDollars * 100);
  if (!(low > 0) || !(high > low)) return "The full-payout rent must be above the starting rent.";
  const premiumRateBps = Math.round(input.premiumPercent * 100);
  if (!(premiumRateBps >= 0) || premiumRateBps > 10_000) return "Premium must be between 0% and 100%.";
  const finalizeAt = end + 1 + SUBMISSION_GRACE_SECONDS;
  return {
    obsMonth,
    strikeLowCents: low,
    strikeHighCents: high,
    premiumRateBps,
    saleEnd: BigInt(start),
    finalizeAt: BigInt(finalizeAt),
    redeemEnd: BigInt(finalizeAt + DEFAULT_CLAIM_SECONDS),
  };
}

export function monthLabel(yyyymm: number): string {
  return `${MONTHS[yyyymm % 100 - 1]} ${Math.floor(yyyymm / 100)}`;
}

/** Payout per claim unit as a 0..1 fraction at a given rent. */
export function payoutFraction(cents: number, low: number, high: number): number {
  if (cents <= low) return 0;
  return cents >= high ? 1 : (cents - low) / (high - low);
}
