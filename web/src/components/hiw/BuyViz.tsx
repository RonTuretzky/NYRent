import { UserIcon } from "@phosphor-icons/react";
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
 * Step 2 — BUY. Green premium dots run buyer → pool on the upper path,
 * sky cover-unit dots come back pool → buyer on the lower path, and a darker
 * "reserved" stripe grows inside the pool as each premium lands.
 */

const DUR = "4s";
const PREMIUM_PATH = "M 140 96 C 200 66 212 74 260 88";
const TOKEN_PATH = "M 262 156 C 212 180 200 170 142 146";
/* all activity ends by ~0.88: last pulse decays 0.78→0.88, complete state
   holds 0.88→0.93, fade 0.93→0.98, dark rest to the wrap — FundViz's rhythm */
const PREMIUM_ARRIVALS = [0.22, 0.38, 0.54] as const;
const TOKEN_ARRIVALS = [0.46, 0.62, 0.78] as const;

export function BuyViz({ reducedMotion, trading = false }: { reducedMotion: boolean; trading?: boolean }) {
  return (
    <VizCard caption={trading ? "premium in · RENT out · backing stays in escrow" : "premium in · RENT out · claim reserved"}>
      <svg
        viewBox="0 0 420 240"
        className="w-full h-auto"
        role="img"
        aria-label={trading ? "A renter exchanges a premium for RENT in the trading pool. Backing remains in a separate escrow." : "A renter pays a premium into the pool and receives RENT back; the matching claim is reserved inside the pool."}
      >
        <Track d={PREMIUM_PATH} />
        <Track d={TOKEN_PATH} />
        <text
          x={200}
          y={58}
          textAnchor="middle"
          fontSize={10}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          premium
        </text>
        <text
          x={200}
          y={194}
          textAnchor="middle"
          fontSize={10}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          RENT
        </text>

        <IconBox
          x={18}
          y={78}
          w={120}
          h={84}
          color={C.sky}
          title="Renter"
          sub="holds RENT"
          icon={<UserIcon size={22} color={C.sky} weight="bold" />}
        />

        {/* the pool: standing capital plus a growing reserved stripe */}
        <rect
          x={262}
          y={54}
          width={140}
          height={132}
          rx={16}
          fill={C.white}
          stroke={C.green}
          strokeWidth={2.5}
        />
        <text
          x={332}
          y={76}
          textAnchor="middle"
          fontSize={12.5}
          fontWeight={700}
          fill={C.ink}
          fontFamily="var(--font-parkDisplay)"
        >
          {trading ? "Trading pool" : "Cover Pool"}
        </text>
        <rect x={274} y={86} width={116} height={88} rx={8} fill={C.green0} />
        <text
          x={332}
          y={102}
          textAnchor="middle"
          fontSize={9.5}
          fill={C.green2}
          fontFamily="var(--font-parkBody)"
        >
          {trading ? "separate liquidity" : "capital"}
        </text>
        {!trading ? <FillSteps
          x={280}
          yBottom={168}
          w={104}
          layerH={13}
          color={C.pine}
          opacity={0.85}
          phases={PREMIUM_ARRIVALS}
          dur={DUR}
          frozen={reducedMotion}
        /> : null}
        {trading ? (
          <text x={332} y={146} textAnchor="middle" fontSize={12} fill={C.pine} fontFamily="var(--font-parkDisplay)">RENT ⇄ premium</text>
        ) : reducedMotion ? (
          <text
            x={332}
            y={162}
            textAnchor="middle"
            fontSize={9.5}
            fontWeight={700}
            fill={C.white}
            fontFamily="var(--font-parkBody)"
          >
            reserved
          </text>
        ) : (
          /* animated viewers get the label too, revealed with the first
             stripe and fading with FillSteps */
          <g opacity={0}>
            <text
              x={332}
              y={162}
              textAnchor="middle"
              fontSize={9.5}
              fontWeight={700}
              fill={C.white}
              fontFamily="var(--font-parkBody)"
            >
              reserved
            </text>
            <animate
              attributeName="opacity"
              dur={DUR}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values="0;0;1;1;0;0"
              keyTimes="0;0.22;0.25;0.93;0.98;1"
            />
          </g>
        )}

        {reducedMotion ? null : (
          <>
            <PulseRing
              x={262}
              y={54}
              w={140}
              h={132}
              rx={16}
              color={C.green}
              phases={PREMIUM_ARRIVALS}
              dur={DUR}
            />
            <PulseRing
              x={18}
              y={78}
              w={120}
              h={84}
              rx={14}
              color={C.sky}
              phases={TOKEN_ARRIVALS}
              dur={DUR}
            />
            <DotStream
              path={PREMIUM_PATH}
              color={C.green}
              dur={DUR}
              windows={[
                [0.02, 0.22],
                [0.18, 0.38],
                [0.34, 0.54],
              ]}
            />
            <DotStream
              path={TOKEN_PATH}
              color={C.sky}
              dur={DUR}
              r={4}
              windows={[
                [0.26, 0.46],
                [0.42, 0.62],
                [0.58, 0.78],
              ]}
            />
          </>
        )}
      </svg>
    </VizCard>
  );
}
