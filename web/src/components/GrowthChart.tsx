/**
 * Plain-SVG line chart over rent-growth outcomes g (x-axis, %) → dollar
 * amounts (y-axis), styled to match PayoutCurve (same fonts/tokens, no chart
 * deps). Used by the /insurer and /renter explainers.
 */

export interface ChartLine {
  label: string;
  color: string;
  /** One point per g in the shared grid. */
  points: { g: number; value: number }[];
  dashed?: boolean;
}

export function GrowthChart({
  lines,
  breakevenG,
  breakevenLabel,
  ariaLabel,
  testId,
}: {
  lines: ChartLine[];
  /** Vertical marker (fractional growth), e.g. the breakeven. */
  breakevenG?: number;
  breakevenLabel?: string;
  ariaLabel: string;
  testId?: string;
}) {
  const W = 560;
  const H = 280;
  const pad = { left: 64, right: 16, top: 16, bottom: 56 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const gs = lines[0]?.points.map((p) => p.g) ?? [];
  const gMin = Math.min(...gs);
  const gMax = Math.max(...gs);
  const values = lines.flatMap((l) => l.points.map((p) => p.value));
  const vMin = Math.min(0, ...values);
  const vMax = Math.max(0, ...values);
  const vSpan = vMax - vMin || 1;

  const x = (g: number) => pad.left + ((g - gMin) / (gMax - gMin || 1)) * iw;
  const y = (v: number) => pad.top + ((vMax - v) / vSpan) * ih;

  // ~4 horizontal gridlines at round dollar steps.
  const rawStep = vSpan / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    rawStep / mag >= 5 ? 5 * mag : rawStep / mag >= 2 ? 2 * mag : mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(vMin / step) * step; v <= vMax + 1e-9; v += step) {
    ticks.push(v);
  }

  const fmtTick = (v: number) =>
    `${v < 0 ? "−" : ""}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k` : Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={ariaLabel}
        data-testid={testId}
      >
        {/* horizontal gridlines + $ labels */}
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--color-paper-2)"
              strokeWidth={1}
              strokeDasharray={Math.abs(v) < step / 100 ? undefined : "3 4"}
            />
            <text
              x={pad.left - 8}
              y={y(v) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--color-surface-grey)"
              fontFamily="var(--font-parkBody)"
            >
              {fmtTick(v)}
            </text>
          </g>
        ))}

        {/* zero line, solid and darker */}
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-surface-grey)"
          strokeWidth={1.5}
        />

        {/* x ticks at each grid growth value */}
        {gs.map((g) => (
          <text
            key={g}
            x={x(g)}
            y={H - pad.bottom + 18}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-surface-grey)"
            fontFamily="var(--font-parkBody)"
          >
            {Math.round(g * 100)}%
          </text>
        ))}
        <text
          x={pad.left + iw / 2}
          y={H - 6}
          textAnchor="middle"
          fontSize={11}
          fill="var(--color-surface-grey)"
          fontFamily="var(--font-parkBody)"
        >
          Year-over-year rent growth (index)
        </text>

        {/* breakeven marker */}
        {breakevenG !== undefined &&
        breakevenG >= gMin &&
        breakevenG <= gMax ? (
          <g>
            <line
              x1={x(breakevenG)}
              x2={x(breakevenG)}
              y1={pad.top}
              y2={H - pad.bottom}
              stroke="var(--color-primary-pine)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            <text
              x={x(breakevenG)}
              y={pad.top + 12}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="var(--color-primary-pine)"
              fontFamily="var(--font-parkBody)"
            >
              {breakevenLabel ?? "breakeven"}
            </text>
          </g>
        ) : null}

        {/* data lines with dots */}
        {lines.map((line) => (
          <g key={line.label}>
            <path
              d={line.points
                .map(
                  (p, i) => `${i === 0 ? "M" : "L"} ${x(p.g)} ${y(p.value)}`,
                )
                .join(" ")}
              fill="none"
              stroke={line.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeDasharray={line.dashed ? "5 4" : undefined}
            />
            {line.points.map((p) => (
              <circle
                key={p.g}
                cx={x(p.g)}
                cy={y(p.value)}
                r={3}
                fill={line.color}
              />
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 justify-center">
        {lines.map((line) => (
          <span
            key={line.label}
            className="flex items-center gap-1.5 font-parkBody text-xs text-surface-grey-2"
          >
            <svg width="18" height="6" aria-hidden="true">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke={line.color}
                strokeWidth="2.5"
                strokeDasharray={line.dashed ? "5 4" : undefined}
              />
            </svg>
            {line.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
