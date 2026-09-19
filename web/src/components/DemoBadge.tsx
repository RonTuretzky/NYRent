/** Tiny "demo" pill shown beside any value that is a fallback constant
 * rather than a live chain read. */
export function DemoBadge({ label = "demo" }: { label?: string }) {
  return (
    <span
      data-testid="demo-badge"
      className="font-parkBody inline-flex items-center rounded-full border border-system-warning bg-system-warning/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-text-standard align-middle"
    >
      {label}
    </span>
  );
}
