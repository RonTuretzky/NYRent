import {
  CheckCircleIcon,
  CircleNotchIcon,
  WalletIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { TxState } from "../chain/useTx";
import { appChain } from "../chain/wagmi";

function explorerTxUrl(hash: string): string | undefined {
  const base = appChain.blockExplorers?.default?.url;
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : undefined;
}

function HashLink({ hash }: { hash: string }) {
  const url = explorerTxUrl(hash);
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
 * confirmed / reverted with decoded custom-error copy. */
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
      <div className="flex items-center gap-2 text-surface-grey-2 font-parkBody text-sm animate-nrc-fade-in">
        <CircleNotchIcon size={18} className="animate-spin" />
        {prefix}simulating transaction…
      </div>
    );
  }
  if (state.status === "wallet") {
    return (
      <div className="flex items-center gap-2 text-surface-grey-2 font-parkBody text-sm animate-nrc-fade-in">
        <WalletIcon size={18} weight="fill" className="animate-nrc-pulse" />
        {prefix}confirm in your wallet…
      </div>
    );
  }
  if (state.status === "pending") {
    return (
      <div
        className="flex items-center gap-2 text-primary-sky font-parkBody text-sm animate-nrc-fade-in"
        data-testid="tx-pending"
      >
        <CircleNotchIcon size={18} className="animate-spin" />
        {prefix}pending — <HashLink hash={state.hash} />
      </div>
    );
  }
  if (state.status === "confirmed") {
    return (
      <div
        className="flex items-center gap-2 text-system-green font-parkBody text-sm animate-nrc-pop"
        data-testid="tx-confirmed"
      >
        <CheckCircleIcon size={18} weight="fill" />
        {prefix}confirmed — <HashLink hash={state.hash} />
      </div>
    );
  }
  // reverted / failed
  return (
    <div
      className="rounded-lg bg-red-0 text-red-main px-3 py-2 font-parkBody text-sm animate-nrc-fade-in"
      data-testid="tx-reverted"
      role="alert"
    >
      <div className="flex items-center gap-2 font-bold">
        <XCircleIcon size={18} weight="fill" />
        {prefix}
        {state.error.name === "UserRejected" ? "cancelled" : "failed"}
        {state.hash ? (
          <span className="font-normal">
            — <HashLink hash={state.hash} />
          </span>
        ) : null}
      </div>
      <p className="mt-1">{state.error.message}</p>
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
