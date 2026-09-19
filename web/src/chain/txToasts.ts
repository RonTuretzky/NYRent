import { useCallback, useSyncExternalStore } from "react";
import type { Hex } from "viem";

export type TxToastStatus = "pending" | "confirmed" | "failed" | "replaced";

export interface TxToastEntry {
  hash?: Hex;
  label: string;
  status: TxToastStatus;
  error?: string;
  /** Explorer base of the chain the tx was SENT on, captured at push time —
   * the link must keep pointing at that chain after a header chain switch. */
  explorerBase: string;
}

export interface TxToast extends TxToastEntry {
  id: string;
}

/**
 * Tiny module-level toast store: transaction lifecycle survives route
 * changes because the state lives outside the page component tree.
 * Confirmed toasts auto-expire; pending/failed stay until dismissed.
 */
const CONFIRMED_TTL_MS = 8_000;

let nextId = 0;
let toasts: readonly TxToast[] = [];
const listeners = new Set<() => void>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function scheduleExpiry(toast: TxToast) {
  const prev = expiryTimers.get(toast.id);
  if (prev !== undefined) {
    clearTimeout(prev);
    expiryTimers.delete(toast.id);
  }
  if (toast.status === "confirmed") {
    expiryTimers.set(
      toast.id,
      setTimeout(() => dismissTxToast(toast.id), CONFIRMED_TTL_MS),
    );
  }
}

/**
 * Add a toast (or update the existing toast for the same tx hash).
 * Returns the toast id, usable with updateTxToast/dismissTxToast.
 */
export function pushTxToast(entry: TxToastEntry): string {
  const existing = entry.hash
    ? toasts.find((t) => t.hash === entry.hash)
    : undefined;
  if (existing) return updateTxToast(existing.id, entry);
  const toast: TxToast = { ...entry, id: `tx-toast-${++nextId}` };
  toasts = [...toasts, toast];
  scheduleExpiry(toast);
  emit();
  return toast.id;
}

/** Patch an existing toast in place (id from pushTxToast). */
export function updateTxToast(id: string, patch: Partial<TxToastEntry>): string {
  let updated: TxToast | undefined;
  toasts = toasts.map((t) => (t.id === id ? (updated = { ...t, ...patch }) : t));
  if (updated) {
    scheduleExpiry(updated);
    emit();
  }
  return id;
}

export function dismissTxToast(id: string): void {
  const timer = expiryTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    expiryTimers.delete(id);
  }
  if (toasts.some((t) => t.id === id)) {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly TxToast[] {
  return toasts;
}

export function useTxToasts(): {
  toasts: readonly TxToast[];
  dismiss: (id: string) => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const dismiss = useCallback((id: string) => dismissTxToast(id), []);
  return { toasts: current, dismiss };
}
