import { BankIcon, UserIcon, VaultIcon } from "@phosphor-icons/react";
import {
  C,
  DotStream,
  IconBox,
  MiniBar,
  PulseRing,
  Track,
  VizCard,
} from "./shared";

/**
 * Step 5 — REDEEM. Green claim dots (61%) stream pool → buyer while pine
 * release dots (39%) stream pool → underwriter; the mini bars under each
 * recipient fill to their share and reset with the cycle.
 */

const DUR = "4s";
const CLAIM_PATH = "M 146 112 C 210 96 216 66 270 54";
const RELEASE_PATH = "M 146 142 C 210 158 216 176 270 168";
/* dot arrivals drive everything: each PulseRing flash and each MiniBar step
   land on the same phase. All activity ends by 0.8, the complete 61/39 state
   holds 0.8→0.93, then the shared fade and a real dark beat before restart. */
const CLAIM_ARRIVALS = [0.28, 0.52, 0.76] as const;
const RELEASE_ARRIVALS = [0.4, 0.7] as const;

export function RedeemViz({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <VizCard caption="claims 61% · releases 39% · never pausable">
      <svg
        viewBox="0 0 420 240"
        className="w-full h-auto"
        role="img"
        aria-label="After settlement, 61% of reserves stream to RENT holders as claims and 39% release back to the insurer."
      >
        <Track d={CLAIM_PATH} />
        <Track d={RELEASE_PATH} />

        <IconBox
          x={18}
          y={82}
          w={126}
          h={88}
          color={C.green}
          title="Cover Pool"
          sub="settled at 0.61"
          icon={<VaultIcon size={22} color={C.green} weight="bold" />}
        />
        <IconBox
          x={272}
          y={16}
          w={126}
          h={76}
          color={C.sky}
          title="Renter"
          sub="burns RENT"
          icon={<UserIcon size={22} color={C.sky} weight="bold" />}
        />
        <IconBox
          x={272}
          y={130}
          w={126}
          h={76}
          color={C.pine}
          title="Insurer"
          sub="free capital"
          icon={<BankIcon size={22} color={C.pine} weight="bold" />}
        />

        {/* each recipient's share, filling under their box */}
        <MiniBar
          x={282}
          y={100}
          w={82}
          h={7}
          color={C.green}
          target={0.61}
          phases={CLAIM_ARRIVALS}
          dur={DUR}
          frozen={reducedMotion}
        />
        <text
          x={370}
          y={107}
          fontSize={10}
          fontWeight={700}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          61%
        </text>
        <MiniBar
          x={282}
          y={214}
          w={82}
          h={7}
          color={C.pine}
          target={0.39}
          phases={RELEASE_ARRIVALS}
          dur={DUR}
          frozen={reducedMotion}
        />
        <text
          x={370}
          y={221}
          fontSize={10}
          fontWeight={700}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          39%
        </text>

        {reducedMotion ? null : (
          <>
            <PulseRing
              x={272}
              y={16}
              w={126}
              h={76}
              rx={14}
              color={C.sky}
              phases={CLAIM_ARRIVALS}
              dur={DUR}
            />
            <PulseRing
              x={272}
              y={130}
              w={126}
              h={76}
              rx={14}
              color={C.pine}
              phases={RELEASE_ARRIVALS}
              dur={DUR}
            />
            <DotStream
              path={CLAIM_PATH}
              color={C.green}
              dur={DUR}
              windows={[
                [0.02, 0.28],
                [0.26, 0.52],
                [0.5, 0.76],
              ]}
            />
            <DotStream
              path={RELEASE_PATH}
              color={C.pine}
              dur={DUR}
              r={4}
              windows={[
                [0.14, 0.4],
                [0.44, 0.7],
              ]}
            />
          </>
        )}
      </svg>
    </VizCard>
  );
}
