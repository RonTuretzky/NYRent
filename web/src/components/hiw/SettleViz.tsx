import { C, PulseRing, Track, VizCard, f } from "./shared";

/**
 * Step 4 — SETTLE. An .eml chip travels into the DKIM Oracle, three check
 * rows light green in cascade, then the payout-ratio bar fills to a marked
 * 61% between the $88 / $96 strikes, holds, and the cycle restarts.
 */

const DUR = "6s";
const CHIP_PATH = "M 34 88 C 92 66 104 82 152 86";
const CHECKS = [
  { at: 0.28, label: "RSA-2048 signature" },
  { at: 0.38, label: "body hash match" },
  { at: 0.48, label: "$92.88 extracted" },
] as const;
const BAR = { x: 60, y: 186, w: 300, h: 12 };
const RATIO = 0.61;
const FILL_WINDOW = [0.55, 0.75] as const;

function CheckRow({
  at,
  label,
  y,
  frozen,
}: {
  at: number;
  label: string;
  y: number;
  frozen: boolean;
}) {
  return (
    <g>
      <circle cx={176} cy={y} r={7.5} fill={C.paper2} />
      <g opacity={frozen ? 1 : 0}>
        <circle cx={176} cy={y} r={7.5} fill={C.green} />
        <path
          d={`M 172.2 ${y} l 2.6 3 l 5 -6`}
          stroke={C.white}
          strokeWidth={1.8}
          fill="none"
          strokeLinecap="round"
        />
        {frozen ? null : (
          <animate
            attributeName="opacity"
            dur={DUR}
            begin="0s"
            repeatCount="indefinite"
            calcMode="linear"
            values="0;0;1;1;0;0"
            keyTimes={`0;${f(at)};${f(at + 0.04)};0.93;0.97;1`}
          />
        )}
      </g>
      <text
        x={192}
        y={y + 4}
        fontSize={11}
        fill={C.grey2}
        fontFamily="var(--font-parkBody)"
      >
        {label}
      </text>
    </g>
  );
}

export function SettleViz({ reducedMotion }: { reducedMotion: boolean }) {
  const markX = BAR.x + BAR.w * RATIO;
  return (
    <VizCard caption="clamp($92.88) → payout ratio 0.61">
      <svg
        viewBox="0 0 420 240"
        className="w-full h-auto"
        role="img"
        aria-label="Anyone submits the raw email to the DKIM Oracle; the signature, body hash and extracted value checks pass, fixing the payout ratio at 0.61 between the $88 and $96 strikes."
      >
        <Track d={CHIP_PATH} />

        {/* the oracle box with its verification cascade */}
        <rect
          x={150}
          y={20}
          width={246}
          height={132}
          rx={16}
          fill={C.white}
          stroke={C.pine}
          strokeWidth={2.5}
        />
        <text
          x={273}
          y={44}
          textAnchor="middle"
          fontSize={12.5}
          fontWeight={700}
          fill={C.ink}
          fontFamily="var(--font-parkDisplay)"
        >
          DKIM Oracle
        </text>
        {CHECKS.map((c, i) => (
          <CheckRow
            key={c.label}
            at={c.at}
            label={c.label}
            y={66 + i * 25}
            frozen={reducedMotion}
          />
        ))}
        {reducedMotion ? null : (
          <PulseRing
            x={150}
            y={20}
            w={246}
            h={132}
            rx={16}
            color={C.pine}
            phases={[0.22]}
            dur={DUR}
          />
        )}

        {/* the .eml chip travelling in */}
        {reducedMotion ? (
          <EmlChip transform="translate(34 88)" />
        ) : (
          <g opacity={0}>
            <EmlChip />
            <animateMotion
              path={CHIP_PATH}
              dur={DUR}
              begin="0s"
              repeatCount="indefinite"
              calcMode="spline"
              keySplines="0 0 1 1;0.42 0 0.58 1;0 0 1 1"
              keyPoints="0;0;1;1"
              keyTimes="0;0.06;0.21;1"
            />
            <animate
              attributeName="opacity"
              dur={DUR}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values="0;0;1;1;0;0"
              keyTimes="0;0.02;0.05;0.19;0.23;1"
            />
          </g>
        )}

        {/* the payout-ratio bar between the strikes */}
        <rect
          x={BAR.x}
          y={BAR.y}
          width={BAR.w}
          height={BAR.h}
          rx={BAR.h / 2}
          fill={C.paper2}
        />
        <rect
          x={BAR.x}
          y={BAR.y}
          width={reducedMotion ? BAR.w * RATIO : 0}
          height={BAR.h}
          rx={BAR.h / 2}
          fill={C.green}
        >
          {reducedMotion ? null : (
            <>
              <animate
                attributeName="width"
                dur={DUR}
                begin="0s"
                repeatCount="indefinite"
                calcMode="spline"
                keySplines="0 0 1 1;0.22 0.8 0.36 1;0 0 1 1"
                values={`0;0;${BAR.w * RATIO};${BAR.w * RATIO}`}
                keyTimes={`0;${f(FILL_WINDOW[0])};${f(FILL_WINDOW[1])};1`}
              />
              <animate
                attributeName="opacity"
                dur={DUR}
                begin="0s"
                repeatCount="indefinite"
                calcMode="linear"
                values="1;1;0;0"
                keyTimes="0;0.93;0.98;1"
              />
            </>
          )}
        </rect>
        <text
          x={BAR.x}
          y={BAR.y + 30}
          textAnchor="middle"
          fontSize={10.5}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          $88
        </text>
        <text
          x={BAR.x + BAR.w}
          y={BAR.y + 30}
          textAnchor="middle"
          fontSize={10.5}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          $96
        </text>
        <g opacity={reducedMotion ? 1 : 0}>
          <line
            x1={markX}
            x2={markX}
            y1={BAR.y - 6}
            y2={BAR.y + BAR.h + 6}
            stroke={C.pine}
            strokeWidth={2}
          />
          <text
            x={markX}
            y={BAR.y - 12}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill={C.pine}
            fontFamily="var(--font-parkBody)"
          >
            61%
          </text>
          {reducedMotion ? null : (
            <animate
              attributeName="opacity"
              dur={DUR}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values="0;0;1;1;0;0"
              keyTimes="0;0.73;0.76;0.93;0.97;1"
            />
          )}
        </g>
      </svg>
    </VizCard>
  );
}

function EmlChip({ transform }: { transform?: string }) {
  return (
    <g transform={transform}>
      <rect
        x={-24}
        y={-12}
        width={48}
        height={24}
        rx={8}
        fill={C.paper1}
        stroke={C.grey}
        strokeWidth={1.5}
      />
      <text
        y={4}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={C.ink}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        .eml
      </text>
    </g>
  );
}
