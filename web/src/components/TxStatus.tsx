import {
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  WalletIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { TxState } from "../chain/useTx";
import { txUrl } from "../chain/explorer";

function HashLink({ hash, base }: { hash: string; base?: string }) {
  // `base` is the explorer of the chain the tx was SENT on (captured in
  // TxState at send time), so the link survives a header chain switch.
  const url = txUrl(hash, base ?? "");
  const label = `${hash.slice(0, 10)}…${hash.slice(-8)}`;
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted"
    >
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

/** Renders one transaction's lifecycle: simulating → wallet → pending →
 * confirmed / stillPending (submitted, wait timed out — may still mine) /
 * reverted (or neutrally cancelled) with decoded custom-error copy. */
export function TxStatus({
  state,
  label,
}: {
  state: TxState;
  label?: string;
}) {
  if (state.status === "idle") return null;

  const prefix = label ? `${label}: ` : "";

  if (state.status === "simulating") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-surface-grey-2 font-parkBody text-sm animate-nrc-fade-in">
        <CircleNotchIcon size={18} className="animate-spin" />
        {prefix}simulating transaction…
      </div>
    );
  }
  if (state.status === "wallet") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-surface-grey-2 font-parkBody text-sm animate-nrc-fade-in">
        <WalletIcon size={18} weight="fill" className="animate-nrc-pulse" />
        {prefix}confirm in your wallet…
      </div>
    );
  }
  if (state.status === "pending") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-primary-sky font-parkBody text-sm animate-nrc-fade-in"
        data-testid="tx-pending"
      >
        <CircleNotchIcon size={18} className="animate-spin" />
        {prefix}pending —{" "}
        <HashLink hash={state.hash} base={state.explorerBase} />
      </div>
    );
  }
  if (state.status === "confirmed") {
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-system-green font-parkBody text-sm animate-nrc-pop"
        data-testid="tx-confirmed"
      >
        <CheckCircleIcon size={18} weight="fill" />
        {prefix}confirmed —{" "}
        <HashLink hash={state.hash} base={state.explorerBase} />
      </div>
    );
  }
  // Submitted but the confirmation wait timed out / the RPC dropped — the tx
  // may still mine, so this is distinctly NOT a failure (no red, no alert).
  if (state.status === "stillPending") {
    return (
      <div
        className="rounded-lg bg-system-warning/10 text-text-standard px-3 py-2 font-parkBody text-sm animate-nrc-fade-in"
        data-testid="tx-still-pending"
        role="status"
      >
        <div className="flex flex-wrap items-center gap-2 font-bold text-system-warning">
          <ClockIcon size={18} weight="fill" />
          {prefix}submitted — still waiting for confirmation —{" "}
          <HashLink hash={state.hash} base={state.explorerBase} />
        </div>
        <p className="mt-1 break-words">{state.error.message}</p>
      </div>
    );
  }

  // reverted / failed — a wallet-side cancel (UserRejected before submission,
  // or a Cancelled speed-up replacement) is neutral, not an error.
  const cancelled = state.error.kind === "rejected";
  return (
    <div
      className={`rounded-lg px-3 py-2 font-parkBody text-sm animate-nrc-fade-in ${
        cancelled ? "bg-paper-1 text-text-standard" : "bg-red-0 text-red-main"
      }`}
      data-testid="tx-reverted"
      role={cancelled ? "status" : "alert"}
    >
      <div className="flex flex-wrap items-center gap-2 font-bold">
        <XCircleIcon size={18} weight="fill" />
        {prefix}
        {cancelled ? "cancelled" : "failed"}
        {state.hash ? (
          <span className="font-normal">
            — <HashLink hash={state.hash} base={state.explorerBase} />
          </span>
        ) : null}
      </div>
      <p className="mt-1 break-words">{state.error.message}</p>
      {state.error.detail ? (
        <details className="mt-1 opacity-80">
          <summary className="cursor-pointer">raw detail</summary>
          <pre className="whitespace-pre-wrap break-all text-xs mt-1">
            {state.error.detail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
