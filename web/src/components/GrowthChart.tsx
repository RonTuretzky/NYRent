/**
 * Plain-SVG line chart over rent-growth outcomes g (x-axis, %) → dollar
 * amounts (y-axis), styled to match PayoutCurve (same fonts/tokens, no chart
 * deps). Used by the /insurer and /renter explainers.
 */

import { useEffect, useState } from "react";

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
  selectedG,
  ariaLabel,
  testId,
}: {
  lines: ChartLine[];
  /** Vertical marker (fractional growth), e.g. the breakeven. */
  breakevenG?: number;
  breakevenLabel?: string;
  selectedG?: number;
  ariaLabel: string;
  testId?: string;
}) {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const W = compact ? 320 : 560;
  const H = 280;
  const pad = { left: compact ? 48 : 64, right: 16, top: compact ? 24 : 16, bottom: 56 };
  const labelSize = compact ? 13 : 11;
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

  const fmtTick = (v: number) => {
    const magnitude = Math.abs(v);
    const scale = magnitude >= 1_000_000 ? 1_000_000 : magnitude >= 1_000 ? 1_000 : 1;
    const suffix = scale === 1_000_000 ? "m" : scale === 1_000 ? "k" : "";
    return `${v < 0 ? "−" : ""}$${(magnitude / scale).toLocaleString("en-US", { maximumFractionDigits: scale === 1 ? 0 : 1 })}${suffix}`;
  };
  // Retain every data point; show fewer axis labels on narrow screens.
  const tickGrowths = compact ? gs.filter((g) => [-0.02, 0, 0.03, 0.05, 0.08, 0.12].includes(g)) : gs;

  return (
    <figure className="min-w-0">
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
              fontSize={labelSize}
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
        {tickGrowths.map((g) => (
          <text
            key={g}
            x={x(g)}
            y={H - pad.bottom + 18}
            textAnchor="middle"
            fontSize={compact ? 12 : 10}
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
          fontSize={labelSize}
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
              fontSize={labelSize}
              fontWeight={700}
              fill="var(--color-primary-pine)"
              fontFamily="var(--font-parkBody)"
            >
              {breakevenLabel ?? "breakeven"}
            </text>
          </g>
        ) : null}

        {selectedG !== undefined && selectedG >= gMin && selectedG <= gMax ? (
          <g aria-hidden="true">
            <line x1={x(selectedG)} x2={x(selectedG)} y1={pad.top} y2={H - pad.bottom}
              stroke="var(--color-core-green)" strokeWidth={12} opacity={0.1} />
            <line x1={x(selectedG)} x2={x(selectedG)} y1={pad.top} y2={H - pad.bottom}
              stroke="var(--color-core-green)" strokeWidth={1.5} strokeDasharray="2 3" />
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
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-2 justify-start sm:justify-center">
        {lines.map((line) => (
          <span
            key={line.label}
            className="flex min-w-0 items-center gap-1.5 font-parkBody text-xs leading-relaxed text-surface-grey-2"
          >
            <svg width="18" height="6" className="shrink-0" aria-hidden="true">
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
