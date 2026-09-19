/** Whole-dollar amounts for the explainer simulations: "$2,850" / "−$3,150".
 * These are hypothetical dollar-stable amounts (the page captions name the
 * live pool currency); on-chain wei always renders via chain/format.ts. */
export function formatDollars(x: number, fractionDigits = 0): string {
  const sign = x < 0 ? "−" : "";
  return `${sign}$${Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** Plain token/unit counts ("3,000") — RENT amounts, never "$"-prefixed. */
export function formatCount(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
