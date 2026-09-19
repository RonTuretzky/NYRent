import { formatCents } from "../chain/format";

/**
 * Hand-built payout-curve SVG for a series: ratio = clamp((cents − low) /
 * (high − low), 0, 1). Shows both strikes and, once settled, the observed
 * point on the curve.
 */
export function PayoutCurve({
  lowCents,
  highCents,
  settledCents,
  ratioWad,
  yoyBaseCents,
}: {
  lowCents: number;
  highCents: number;
  settledCents?: number;
  ratioWad?: bigint;
  /** When set, each strike also shows its year-over-year growth vs this
   * base — the same axis in a second unit ($/SF ↔ YoY %). */
  yoyBaseCents?: number;
}) {
  const W = 560;
  const H = yoyBaseCents ? 256 : 240;
  const pad = { left: 52, right: 24, top: 22, bottom: yoyBaseCents ? 56 : 40 };
  const yoyLabel = (cents: number) =>
    `+${Math.round(((cents / (yoyBaseCents ?? cents)) - 1) * 100)}% YoY`;
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;

  const span = highCents - lowCents;
  const xMin = lowCents - Math.max(Math.round(span * 0.35), 100);
  const xMax = highCents + Math.max(Math.round(span * 0.35), 100);

  const x = (cents: number) =>
    pad.left + ((cents - xMin) / (xMax - xMin)) * iw;
  const y = (ratio: number) => pad.top + (1 - ratio) * ih;

  const settled =
    settledCents !== undefined && ratioWad !== undefined
      ? { cents: settledCents, ratio: Number(ratioWad) / 1e18 }
      : undefined;

  const curve = [
    `M ${x(xMin)} ${y(0)}`,
    `L ${x(lowCents)} ${y(0)}`,
    `L ${x(highCents)} ${y(1)}`,
    `L ${x(xMax)} ${y(1)}`,
  ].join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto"
      role="img"
      aria-label={`Payout curve: 0% at or below ${formatCents(lowCents)}${yoyBaseCents ? ` (${yoyLabel(lowCents)})` : ""}, rising linearly to 100% at or above ${formatCents(highCents)}${yoyBaseCents ? ` (${yoyLabel(highCents)})` : ""}${settled ? `; settled at ${formatCents(settled.cents)} for ${(settled.ratio * 100).toFixed(1)}%` : ""}`}
      data-testid="payout-curve"
    >
      {/* gridlines */}
      {[0, 0.25, 0.5, 0.75, 1].map((r) => (
        <g key={r}>
          <line
            x1={pad.left}
            x2={W - pad.right}
            y1={y(r)}
            y2={y(r)}
            stroke="var(--color-paper-2)"
            strokeWidth={1}
            strokeDasharray={r === 0 || r === 1 ? undefined : "3 4"}
          />
          <text
            x={pad.left - 8}
            y={y(r) + 4}
            textAnchor="end"
            fontSize={11}
            fill="var(--color-surface-grey)"
            fontFamily="var(--font-parkBody)"
          >
            {Math.round(r * 100)}%
          </text>
        </g>
      ))}

      {/* area under curve */}
      <path
        d={`${curve} L ${x(xMax)} ${y(0)} Z`}
        fill="var(--color-green-0)"
        opacity={0.25}
      />
      {/* the curve */}
      <path
        d={curve}
        fill="none"
        stroke="var(--color-core-green)"
        strokeWidth={3}
        strokeLinejoin="round"
      />

      {/* strikes */}
      {[
        { cents: lowCents, label: `${formatCents(lowCents)} · 0%` },
        { cents: highCents, label: `${formatCents(highCents)} · 100%` },
      ].map((s) => (
        <g key={s.cents}>
          <line
            x1={x(s.cents)}
            x2={x(s.cents)}
            y1={pad.top}
            y2={H - pad.bottom}
            stroke="var(--color-primary-pine)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
          <text
            x={x(s.cents)}
            y={H - pad.bottom + 16}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill="var(--color-primary-pine)"
            fontFamily="var(--font-parkBody)"
          >
            {s.label}
          </text>
          {yoyBaseCents ? (
            <text
              x={x(s.cents)}
              y={H - pad.bottom + 30}
              textAnchor="middle"
              fontSize={10.5}
              fill="var(--color-surface-grey)"
              fontFamily="var(--font-parkBody)"
            >
              {yoyLabel(s.cents)}
            </text>
          ) : null}
        </g>
      ))}

      {/* x-axis caption */}
      <text
        x={pad.left + iw / 2}
        y={H - 6}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-surface-grey)"
        fontFamily="var(--font-parkBody)"
      >
        CRE Daily · Manhattan Rent Index · Avg Effective $/SF
      </text>

      {/* settled point */}
      {settled ? (
        <g className="animate-nrc-pop">
          <line
            x1={x(settled.cents)}
            x2={x(settled.cents)}
            y1={y(settled.ratio)}
            y2={H - pad.bottom}
            stroke="var(--color-primary-sky)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
          />
          <line
            x1={pad.left}
            x2={x(settled.cents)}
            y1={y(settled.ratio)}
            y2={y(settled.ratio)}
            stroke="var(--color-primary-sky)"
            strokeWidth={1.5}
            strokeDasharray="2 3"
          />
          <circle
            cx={x(settled.cents)}
            cy={y(settled.ratio)}
            r={7}
            fill="var(--color-primary-sky)"
            stroke="var(--color-paper-0)"
            strokeWidth={2.5}
          />
          <text
            x={x(settled.cents) + 10}
            y={y(settled.ratio) - 10}
            fontSize={12}
            fontWeight={700}
            fill="var(--color-primary-sky)"
            fontFamily="var(--font-parkBody)"
          >
            settled {formatCents(settled.cents)} →{" "}
            {(settled.ratio * 100).toFixed(1)}%
          </text>
        </g>
      ) : null}
    </svg>
  );
}
