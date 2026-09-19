import { EnvelopeSimpleIcon, SealCheckIcon } from "@phosphor-icons/react";
import { C, VizCard, f } from "./shared";

/**
 * Step 3 — EMAIL. A newsletter card with a DKIM seal that brightens on the
 * card's own SMIL timeline when the signature squiggle completes; the
 * snapshot line type-reveals group by group, the rent figure appears, the
 * squiggle draws itself underneath, everything holds and fades.
 */

const DUR = "4.5s";
const GROUPS = [0.08, 0.3, 0.5] as const;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function Reveal({
  at,
  frozen,
  children,
}: {
  at: number;
  frozen: boolean;
  children: React.ReactNode;
}) {
  return (
    <g opacity={frozen ? 1 : 0}>
      {children}
      {frozen ? null : (
        <animate
          attributeName="opacity"
          dur={DUR}
          begin="0s"
          repeatCount="indefinite"
          calcMode="linear"
          values="0;0;1;1;0;0"
          keyTimes={`0;${f(at)};${f(at + 0.03)};0.9;0.97;1`}
        />
      )}
    </g>
  );
}

export function EmailViz({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <VizCard caption="RSA-2048 signed by newyork.credaily.com">
      <svg
        viewBox="0 0 420 240"
        className="w-full h-auto"
        role="img"
        aria-label="The CRE Daily Market Snapshot email, DKIM-sealed, reporting Manhattan Rent Index, average effective, $92.88 per square foot."
      >
        {/* the newsletter card */}
        <rect
          x={40}
          y={36}
          width={340}
          height={178}
          rx={16}
          fill={C.white}
          stroke={C.paper2}
          strokeWidth={2.5}
        />
        <g transform="translate(58 50)">
          <EnvelopeSimpleIcon size={18} color={C.pine} weight="bold" />
        </g>
        <text
          x={84}
          y={64}
          fontSize={12.5}
          fontWeight={700}
          fill={C.ink}
          fontFamily="var(--font-parkDisplay)"
        >
          CRE Daily · Market Snapshot
        </text>
        <line x1={58} y1={78} x2={310} y2={78} stroke={C.paper2} strokeWidth={1.5} />

        {/* DKIM seal badge — phase-locked to the card's SMIL timeline: it
            brightens as a confirmation when the signature squiggle completes
            at 0.76, and rests during the blank reset */}
        <g transform="translate(342 62)" opacity={reducedMotion ? 1 : 0.55}>
          <circle r={17} fill={C.green0} />
          <g transform="translate(-11 -11)">
            <SealCheckIcon size={22} color={C.green2} weight="fill" />
          </g>
          {reducedMotion ? null : (
            <animate
              attributeName="opacity"
              dur={DUR}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values="0.55;0.55;1;1;0.55;0.55"
              keyTimes="0;0.76;0.79;0.88;0.92;1"
            />
          )}
        </g>

        {/* the snapshot line, revealed group by group */}
        <Reveal at={GROUPS[0]} frozen={reducedMotion}>
          <text x={66} y={122} fontSize={12} fill={C.ink} fontFamily={MONO}>
            Manhattan Rent Index
          </text>
        </Reveal>
        <Reveal at={GROUPS[1]} frozen={reducedMotion}>
          <text x={228} y={122} fontSize={12} fill={C.grey2} fontFamily={MONO}>
            · Avg Effective
          </text>
        </Reveal>
        <Reveal at={GROUPS[2]} frozen={reducedMotion}>
          <text
            x={66}
            y={160}
            fontSize={22}
            fontWeight={700}
            fill={C.green2}
            fontFamily="var(--font-parkDisplay)"
          >
            $92.88 / SF
          </text>
        </Reveal>

        {/* signature squiggle drawing itself under the figure */}
        <path
          d="M 66 176 q 9 -7 18 0 t 18 0 t 18 0 t 18 0 t 18 0 t 18 0"
          fill="none"
          stroke={C.pine}
          strokeWidth={1.8}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={reducedMotion ? undefined : 100}
          strokeDashoffset={reducedMotion ? undefined : 100}
        >
          {reducedMotion ? null : (
            <>
              <animate
                attributeName="stroke-dashoffset"
                dur={DUR}
                begin="0s"
                repeatCount="indefinite"
                calcMode="linear"
                values="100;100;0;0"
                keyTimes="0;0.58;0.76;1"
              />
              <animate
                attributeName="opacity"
                dur={DUR}
                begin="0s"
                repeatCount="indefinite"
                calcMode="linear"
                values="1;1;0;0"
                keyTimes="0;0.9;0.97;1"
              />
            </>
          )}
        </path>
      </svg>
    </VizCard>
  );
}
