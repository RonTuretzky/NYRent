export interface CreationInput {
  low: string; high: string; saleEnd: string; obsStart: string; obsEnd: string; redeemEnd: string;
}

export function creationTerms(input: CreationInput, baseIndex: bigint, baseCents: number, now: number) {
  const cents = (value: string) => {
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("Enter a positive dollar amount with at most two decimals.");
    const [whole, fraction = ""] = value.split(".");
    const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (result <= 0n || result > 4294967295n) throw new Error("Strike is outside the supported range.");
    return Number(result);
  };
  const timestamp = (value: string) => {
    const result = Date.parse(value + "T00:00:00Z") / 1000;
    if (!Number.isSafeInteger(result)) throw new Error("Choose all four dates.");
    return BigInt(result);
  };
  const strikeLowCents = cents(input.low), strikeHighCents = cents(input.high);
  const saleEnd = timestamp(input.saleEnd), obsStart = timestamp(input.obsStart);
  const obsEnd = timestamp(input.obsEnd), redeemEnd = timestamp(input.redeemEnd);
  if (strikeHighCents <= strikeLowCents) throw new Error("Full payout strike must exceed the zero payout strike.");
  if (saleEnd <= BigInt(Math.floor(now))) throw new Error("Trading must close in the future.");
  if (obsStart < saleEnd + 86400n) throw new Error("Leave at least one day between trading close and observation start.");
  if (obsEnd <= obsStart || redeemEnd < obsEnd + 7n * 86400n) throw new Error("Observation end must follow start; allow at least seven days for redemption.");
  if (baseIndex < 0n || !Number.isInteger(baseCents) || baseCents <= 0 || baseCents > 4294967295) throw new Error("A valid onchain baseline is required.");
  return { baseObservationIndex: baseIndex, baseRentCents: baseCents, strikeLowCents, strikeHighCents, saleEnd, obsStart, obsEnd, redeemEnd };
}
