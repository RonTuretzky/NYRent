import { createPortal } from "react-dom";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useTxToasts, type TxToast } from "../chain/txToasts";
import { txUrl } from "../chain/explorer";

const STATUS_TEXT: Record<TxToast["status"], string> = {
  pending: "pending…",
  confirmed: "confirmed",
  failed: "failed",
  replaced: "replaced (sped up)",
};

function StatusIcon({ status }: { status: TxToast["status"] }) {
  if (status === "confirmed") {
    return (
      <CheckCircleIcon size={20} weight="fill" className="text-system-green" />
    );
  }
  if (status === "failed") {
    return <XCircleIcon size={20} weight="fill" className="text-red-main" />;
  }
  if (status === "replaced") {
    return <ArrowsClockwiseIcon size={20} className="text-primary-sky" />;
  }
  return (
    <CircleNotchIcon size={20} className="text-primary-sky animate-spin" />
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: TxToast;
  onDismiss: () => void;
}) {
  return (
    <div
      className="pointer-events-auto flex items-start gap-3 bg-paper-0 border-2 border-paper-2 rounded-2xl px-4 py-3 shadow-lg animate-nrc-fade-in"
      data-testid="tx-toast"
      data-status={toast.status}
    >
      <div className="mt-0.5 shrink-0">
        <StatusIcon status={toast.status} />
      </div>
      <div className="min-w-0 flex-1 font-parkBody text-sm">
        <p className="font-bold text-text-standard">
          {toast.label} — {STATUS_TEXT[toast.status]}
        </p>
        {toast.error ? (
          <p className="mt-0.5 text-surface-grey-2">{toast.error}</p>
        ) : null}
        {toast.hash ? (
          <a
            href={txUrl(toast.hash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-block underline decoration-dotted text-surface-grey-2 break-all"
          >
            {toast.hash.slice(0, 10)}…{toast.hash.slice(-8)}
          </a>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 -m-1 p-2 rounded-lg text-surface-grey-2 hover:text-text-standard hover:bg-paper-1"
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}

/**
 * Global transaction-toast portal (mounted once in Layout). The store lives in
 * chain/txToasts.ts, so in-flight transactions stay visible across route
 * changes; confirmed toasts auto-expire after 8s, others stay until dismissed.
 */
export function Toasts() {
  const { toasts, dismiss } = useTxToasts();
  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
      data-testid="tx-toasts"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>,
    document.body,
  );
}
