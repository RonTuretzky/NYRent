import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudSlashIcon, TrayIcon } from "@phosphor-icons/react";
import { Button } from "@decentralpark/ui";
import { appChain } from "../chain/wagmi";

export function LoadingSkeleton({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-3 ${className}`} data-testid="loading-skeleton">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="nrc-skeleton h-6"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className="border-2 border-dashed border-paper-2 rounded-2xl px-6 py-10 text-center bg-paper-0"
      data-testid="empty-state"
    >
      <div className="text-surface-grey flex justify-center">
        {icon ?? <TrayIcon size={40} />}
      </div>
      <p className="font-parkDisplay font-bold text-text-standard mt-3">
        {title}
      </p>
      {children ? (
        <div className="font-parkBody text-sm text-surface-grey-2 mt-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function rpcHost(): string {
  try {
    return new URL(appChain.rpcUrls.default.http[0]).host;
  } catch {
    return "the RPC endpoint";
  }
}

/**
 * Distinct state for transport/network read failures — the chain could not be
 * reached, which is NOT the same as "no data exists". Rendered by pages when a
 * read hook reports `rpcError`.
 */
export function RpcDownState({ onRetry }: { onRetry?: () => void }) {
  const queryClient = useQueryClient();
  return (
    <div
      className="border-2 border-dashed border-paper-2 rounded-2xl px-6 py-10 text-center bg-paper-0"
      data-testid="rpc-down"
      role="alert"
    >
      <div className="text-system-red flex justify-center">
        <CloudSlashIcon size={40} />
      </div>
      <p className="font-parkDisplay font-bold text-text-standard mt-3">
        Can't reach the Gnosis RPC
      </p>
      <div className="font-parkBody text-sm text-surface-grey-2 mt-1 max-w-md mx-auto">
        On-chain data could not be loaded — {rpcHost()} may be down,
        rate-limited, or blocked by your connection. Nothing is wrong with the
        pool itself.
      </div>
      <div className="mt-4 flex justify-center">
        <Button
          app="fund"
          variant="secondary"
          size="sm"
          onClick={() => {
            if (onRetry) onRetry();
            else void queryClient.refetchQueries({ type: "active" });
          }}
          data-testid="rpc-down-retry"
        >
          Retry
        </Button>
      </div>
    </div>
  );
}

/**
 * Slim, non-blocking companion to RpcDownState: shown when a background
 * refetch failed but react-query still holds last-good data — the page keeps
 * rendering the cached content instead of being blanked by the full-page
 * outage state.
 */
export function RpcStaleBanner() {
  const queryClient = useQueryClient();
  return (
    <div
      data-testid="rpc-stale-banner"
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-system-warning bg-system-warning/10 px-3 py-2 font-parkBody text-sm text-text-standard"
    >
      <CloudSlashIcon size={18} className="text-system-warning shrink-0" />
      <span className="flex-1 min-w-40">
        RPC connection lost — the data shown may be stale.
      </span>
      <button
        type="button"
        className="font-bold underline"
        onClick={() => void queryClient.refetchQueries({ type: "active" })}
        data-testid="rpc-stale-retry"
      >
        Retry
      </button>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-paper-0 border-2 border-paper-2 rounded-2xl p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function StatRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-paper-1 last:border-b-0">
      <span className="font-parkBody text-sm text-surface-grey-2">{label}</span>
      <span
        className={`font-parkBody text-sm text-text-standard text-right ${mono ? "font-mono break-all" : "font-bold"}`}
      >
        {value}
      </span>
    </div>
  );
}
