import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { ReceiptIcon } from "@phosphor-icons/react";
import { deployment, isDeployed } from "../chain/deployment";
import { poolAbi } from "../chain/contracts";
import type { Series } from "../chain/types";
import { formatBps, formatCurrency, nowSec } from "../chain/format";
import { Card, LoadingSkeleton, StatRow } from "./States";

const WAD = 10n ** 18n;

export interface SeriesEntry {
  id: number;
  series: Series;
}

interface SeriesLedger {
  id: number;
  premiumRateBps: number;
  premiumReceived: bigint;
  sold: bigint;
  settled: boolean;
  claimsPayable: bigint;
  claimsPaid: bigint | undefined;
  reservesOutstanding: bigint | undefined;
  residualAtSettlement: bigint;
  unclaimedPayout: bigint | undefined;
  windowClosed: boolean;
}

/**
 * Per-series ledger mirroring the lifecycle-accounting table printed by
 * scripts/e2e-mainnet.mjs: premium received = sold × premiumRateBps, claims
 * paid = redeemedPayout(id), reserves outstanding = reservedOf(id), residual
 * released at settlement = sold − sold×ratio, unclaimed payout = payable −
 * paid (releasable to free capital after redeemEnd).
 */
function useLedgers(entries: SeriesEntry[]): {
  ledgers: SeriesLedger[];
  isLoading: boolean;
} {
  const enabled = isDeployed && entries.length > 0;
  const read = useReadContracts({
    allowFailure: true,
    contracts: entries.flatMap((e) => [
      {
        abi: poolAbi,
        address: deployment.pool,
        functionName: "redeemedPayout",
        args: [BigInt(e.id)],
      } as const,
      {
        abi: poolAbi,
        address: deployment.pool,
        functionName: "reservedOf",
        args: [BigInt(e.id)],
      } as const,
    ]),
    query: { enabled, refetchInterval: 15_000 },
  });
  const now = nowSec();
  const ledgers = useMemo<SeriesLedger[]>(() => {
    return entries.map((e, i) => {
      const s = e.series;
      const paidRead = read.data?.[i * 2];
      const reservedRead = read.data?.[i * 2 + 1];
      const claimsPaid =
        paidRead?.status === "success" ? (paidRead.result as bigint) : undefined;
      const reservesOutstanding =
        reservedRead?.status === "success"
          ? (reservedRead.result as bigint)
          : undefined;
      const claimsPayable = s.settled ? (s.sold * s.payoutRatioWad) / WAD : s.sold;
      return {
        id: e.id,
        premiumRateBps: s.premiumRateBps,
        premiumReceived: (s.sold * BigInt(s.premiumRateBps)) / 10_000n,
        sold: s.sold,
        settled: s.settled,
        claimsPayable,
        claimsPaid,
        reservesOutstanding,
        residualAtSettlement: s.settled ? s.sold - claimsPayable : 0n,
        unclaimedPayout:
          s.settled && claimsPaid !== undefined
            ? claimsPayable - claimsPaid
            : undefined,
        windowClosed: now > s.redeemEnd,
      };
    });
  }, [entries, read.data, now]);
  return { ledgers, isLoading: enabled && read.isLoading };
}

function sum(values: (bigint | undefined)[]): bigint | undefined {
  let total = 0n;
  for (const v of values) {
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

/**
 * The PRD's post-redemption accounting view. Pass one entry for a per-series
 * card (SeriesDetail) or every series for the rolled-up sponsor view.
 */
export function AccountingCard({
  entries,
  symbol,
  decimals,
}: {
  entries: SeriesEntry[];
  symbol: string;
  decimals: number;
}) {
  const { ledgers, isLoading } = useLedgers(entries);
  const fmt = (wei: bigint | undefined) =>
    formatCurrency(wei, { symbol, decimals });

  const single = ledgers.length === 1 ? ledgers[0] : undefined;
  const anySettled = ledgers.some((l) => l.settled);
  const allClosed = ledgers.length > 0 && ledgers.every((l) => l.windowClosed);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-parkDisplay font-bold text-lg">
          Lifecycle accounting
        </h2>
        <ReceiptIcon size={22} className="text-surface-grey" />
      </div>
      {isLoading && !ledgers.some((l) => l.claimsPaid !== undefined) ? (
        <LoadingSkeleton lines={4} />
      ) : (
        <div data-testid="accounting-card">
          {!single ? (
            <p className="font-parkBody text-xs text-surface-grey-2 mb-2">
              Rolled up across {ledgers.length} series.
            </p>
          ) : null}
          <StatRow
            label={
              single
                ? `Premium received (sold × ${formatBps(single.premiumRateBps)})`
                : "Premium received"
            }
            value={fmt(sum(ledgers.map((l) => l.premiumReceived)))}
          />
          <StatRow
            label="Max claim sold"
            value={fmt(sum(ledgers.map((l) => l.sold)))}
          />
          {anySettled ? (
            <>
              <StatRow
                label="Claims payable at settled ratio"
                value={fmt(
                  sum(ledgers.map((l) => (l.settled ? l.claimsPayable : 0n))),
                )}
              />
              <StatRow
                label="Claims paid (redeemed)"
                value={fmt(
                  sum(ledgers.map((l) => (l.settled ? l.claimsPaid : 0n))),
                )}
              />
              <StatRow
                label="Residual released at settlement"
                value={fmt(sum(ledgers.map((l) => l.residualAtSettlement)))}
              />
              <StatRow
                label={
                  allClosed
                    ? "Unclaimed payout (released to free capital)"
                    : "Unclaimed payout (releasable after redeem window)"
                }
                value={fmt(
                  sum(ledgers.map((l) => (l.settled ? l.unclaimedPayout : 0n))),
                )}
              />
            </>
          ) : null}
          <StatRow
            label="Reserves outstanding now"
            value={fmt(sum(ledgers.map((l) => l.reservesOutstanding)))}
          />
        </div>
      )}
    </Card>
  );
}
