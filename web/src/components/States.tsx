import type { ReactNode } from "react";
import { TrayIcon } from "@phosphor-icons/react";

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
