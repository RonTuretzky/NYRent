import { CheckIcon } from "@phosphor-icons/react";
import type { Series } from "../chain/types";
import { formatRatioWad, formatTimestamp, nowSec } from "../chain/format";

interface Stage {
  key: string;
  label: string;
  sub: string;
  done: boolean;
  active: boolean;
}

/** SPEC lifecycle timeline: sale → observation window → settle → redeem → released. */
export function SeriesTimeline({ series }: { series: Series }) {
  const now = nowSec();
  const stages: Stage[] = [
    {
      key: "sale",
      label: "Sale",
      sub: `until ${formatTimestamp(series.saleEnd)}`,
      done: now > series.saleEnd,
      active: now <= series.saleEnd,
    },
    {
      key: "obs",
      label: "Observation window",
      sub: `${formatTimestamp(series.obsStart)} → ${formatTimestamp(series.obsEnd)}`,
      done: series.settled || now > series.obsEnd,
      active:
        !series.settled && now >= series.obsStart && now <= series.obsEnd,
    },
    {
      key: "settle",
      label: "Settlement",
      sub: series.settled
        ? `one-shot · ratio ${formatRatioWad(series.payoutRatioWad)}`
        : "one-shot, permissionless, first qualifying email wins",
      done: series.settled,
      active: !series.settled && now > series.obsStart,
    },
    {
      key: "redeem",
      label: "Redeem",
      sub: `until ${formatTimestamp(series.redeemEnd)}`,
      done: now > series.redeemEnd,
      active: series.settled && now <= series.redeemEnd,
    },
    {
      key: "release",
      label: "Residual released",
      sub: "unclaimed escrow + premiums return to the series creator",
      done: now > series.redeemEnd,
      active: false,
    },
  ];

  return (
    <ol className="relative" data-testid="series-timeline">
      {stages.map((stage, i) => (
        <li key={stage.key} className="flex gap-3 pb-4 last:pb-0">
          <div className="flex flex-col items-center">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 font-parkDisplay text-xs font-bold transition-colors duration-500 ${
                stage.done
                  ? "bg-core-green border-core-green text-white"
                  : stage.active
                    ? "border-core-green text-core-green bg-paper-main animate-nrc-pulse"
                    : "border-paper-2 text-surface-grey bg-paper-0"
              }`}
            >
              {stage.done ? <CheckIcon size={14} weight="bold" /> : i + 1}
            </div>
            {i < stages.length - 1 ? (
              <div
                className={`w-0.5 flex-1 min-h-4 ${stage.done ? "bg-core-green" : "bg-paper-2"}`}
              />
            ) : null}
          </div>
          <div className="pt-0.5">
            <p
              className={`font-parkBody text-sm font-bold ${
                stage.active
                  ? "text-core-green"
                  : stage.done
                    ? "text-text-standard"
                    : "text-surface-grey-2"
              }`}
            >
              {stage.label}
            </p>
            <p className="font-parkBody text-xs text-surface-grey">
              {stage.sub}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
