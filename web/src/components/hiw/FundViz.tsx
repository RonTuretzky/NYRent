import { BankIcon } from "@phosphor-icons/react";
import {
  C,
  DotStream,
  FillSteps,
  IconBox,
  PulseRing,
  Track,
  VizCard,
} from "./shared";

/**
 * Step 1 — FUND. Green currency dots travel underwriter → pool; each arrival bumps
 * a brief border pulse and raises the vault's fill level one increment, then
 * the level soft-fades and the cycle restarts.
 */

const DUR = "4s";
const PATH = "M 138 66 C 210 66 220 140 254 152";
const ARRIVALS = [0.3, 0.54, 0.78] as const;

export function FundViz({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <VizCard caption="escrowed collateral → pool · fully backed">
      <svg
        viewBox="0 0 420 240"
        className="w-full h-auto"
        role="img"
        aria-label="The underwriter deposits currency as escrow into the cover pool; the pool's fill level rises with each deposit."
      >
        <Track d={PATH} />

        <IconBox
          x={18}
          y={20}
          w={120}
          h={80}
          color={C.green}
          title="Underwriter"
          sub="escrowed capital"
          icon={<BankIcon size={22} color={C.green} weight="bold" />}
        />

        {/* the vault: interior fill level rises in three increments */}
        <rect
          x={252}
          y={112}
          width={150}
          height={106}
          rx={16}
          fill={C.white}
          stroke={C.green}
          strokeWidth={2.5}
        />
        <text
          x={327}
          y={134}
          textAnchor="middle"
          fontSize={12.5}
          fontWeight={700}
          fill={C.ink}
          fontFamily="var(--font-parkDisplay)"
        >
          Cover Pool
        </text>
        <FillSteps
          x={266}
          yBottom={206}
          w={122}
          layerH={19}
          color={C.green0}
          phases={ARRIVALS}
          dur={DUR}
          frozen={reducedMotion}
        />
        {reducedMotion ? null : (
          <PulseRing
            x={252}
            y={112}
            w={150}
            h={106}
            rx={16}
            color={C.green}
            phases={ARRIVALS}
            dur={DUR}
          />
        )}

        {reducedMotion ? null : (
          <DotStream
            path={PATH}
            color={C.green}
            dur={DUR}
            windows={[
              [0.04, 0.3],
              [0.28, 0.54],
              [0.52, 0.78],
            ]}
          />
        )}
      </svg>
    </VizCard>
  );
}
