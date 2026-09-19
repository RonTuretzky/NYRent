import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * Shared bits for the crowdstake-style "how it works" micro-visualizations.
 * Every loop inside a step card is choreographed on one SMIL timeline: all
 * animate/animateMotion elements share the card's dur with begin=0 and
 * express their phases as keyTimes fractions, so dot arrivals, border pulses
 * and fill increments stay locked in sync forever. With reduced motion the
 * cards render frozen in their most informative state instead.
 */

export const C = {
  green: "var(--color-core-green)",
  green0: "var(--color-green-0)",
  green2: "var(--color-green-2)",
  pine: "var(--color-primary-pine)",
  sky: "var(--color-primary-sky)",
  paper1: "var(--color-paper-1)",
  paper2: "var(--color-paper-2)",
  ink: "var(--color-surface-ink)",
  grey: "var(--color-surface-grey)",
  grey2: "var(--color-surface-grey-2)",
  white: "#ffffff",
  red: "var(--color-system-red)",
};

/* keyTimes fractions formatted without float noise */
export const f = (n: number) => Number(n.toFixed(4)).toString();

export function useReducedMotion(): boolean {
  // Lazy init so the very first render is already frozen for reduced-motion
  // users (client-only Vite app — window always exists).
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return reduced;
}

/* one-time entrance trigger for a step row */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  threshold = 0.25,
): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
}

/* the soft card every step diagram lives in, quiet caption in the corner */
export function VizCard({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-paper-2 bg-gradient-to-br from-paper-1 to-paper-0 p-4 shadow-sm sm:p-6">
      {children}
      <p className="font-parkBody mt-3 text-right text-[11px] text-surface-grey-2">
        {caption}
      </p>
    </div>
  );
}

/* a labeled icon-box actor (rounded rect, phosphor icon, tiny label) */
export function IconBox({
  x,
  y,
  w,
  h,
  color,
  title,
  sub,
  icon,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  title: string;
  sub?: string;
  icon: ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} rx={14} fill={C.white} stroke={color} strokeWidth={2.5} />
      <g transform={`translate(${w / 2 - 11} 11)`}>{icon}</g>
      <text
        x={w / 2}
        y={h - (sub ? 24 : 12)}
        textAnchor="middle"
        fontSize={12.5}
        fontWeight={700}
        fill={C.ink}
        fontFamily="var(--font-parkDisplay)"
      >
        {title}
      </text>
      {sub ? (
        <text
          x={w / 2}
          y={h - 10}
          textAnchor="middle"
          fontSize={9.5}
          fill={C.grey2}
          fontFamily="var(--font-parkBody)"
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/* faint dotted guide between actors — the dots travel along the same d */
export function Track({ d }: { d: string }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={C.paper2}
      strokeWidth={1.5}
      strokeDasharray="1 7"
      strokeLinecap="round"
    />
  );
}

/* dots travelling along an invisible path, fading in at the origin and out
   at the destination; each window is [start,end] as fractions of the cycle */
export function DotStream({
  path,
  color,
  dur,
  windows,
  r = 4.5,
}: {
  path: string;
  color: string;
  dur: string;
  windows: ReadonlyArray<readonly [number, number]>;
  r?: number;
}) {
  return (
    <g>
      {windows.map(([from, to], i) => (
        <circle key={i} r={r} fill={color} opacity={0}>
          <animateMotion
            path={path}
            dur={dur}
            begin="0s"
            repeatCount="indefinite"
            calcMode="spline"
            keySplines="0 0 1 1;0.42 0 0.58 1;0 0 1 1"
            keyPoints="0;0;1;1"
            keyTimes={`0;${f(from)};${f(to)};1`}
          />
          <animate
            attributeName="opacity"
            dur={dur}
            begin="0s"
            repeatCount="indefinite"
            calcMode="linear"
            values="0;0;1;1;0;0"
            keyTimes={`0;${f(from)};${f(Math.min(from + 0.05, to))};${f(
              Math.max(to - 0.05, from),
            )};${f(to)};1`}
          />
        </circle>
      ))}
    </g>
  );
}

/* an actor's border flashing briefly at each arrival phase */
export function PulseRing({
  x,
  y,
  w,
  h,
  rx,
  color,
  phases,
  dur,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  rx: number;
  color: string;
  phases: readonly number[];
  dur: string;
}) {
  const values: string[] = ["0"];
  const times: string[] = ["0"];
  for (const p of phases) {
    values.push("0", "0.85", "0");
    times.push(f(p - 0.01), f(p + 0.02), f(Math.min(p + 0.1, 0.995)));
  }
  values.push("0");
  times.push("1");
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      rx={rx}
      fill="none"
      stroke={color}
      strokeWidth={4}
      opacity={0}
    >
      <animate
        attributeName="opacity"
        dur={dur}
        begin="0s"
        repeatCount="indefinite"
        calcMode="linear"
        values={values.join(";")}
        keyTimes={times.join(";")}
      />
    </rect>
  );
}

/* a fill level rising in increments (one layer per phase, bottom-up), then
   resetting with a soft fade at the end of the cycle */
export function FillSteps({
  x,
  yBottom,
  w,
  layerH,
  gap = 3,
  color,
  opacity = 1,
  phases,
  dur,
  fadeAt = 0.93,
  frozen,
}: {
  x: number;
  yBottom: number;
  w: number;
  layerH: number;
  gap?: number;
  color: string;
  opacity?: number;
  phases: readonly number[];
  dur: string;
  fadeAt?: number;
  frozen: boolean;
}) {
  return (
    <g>
      {phases.map((p, i) => (
        <rect
          key={i}
          x={x}
          y={yBottom - (i + 1) * layerH - i * gap}
          width={w}
          height={layerH}
          rx={4}
          fill={color}
          fillOpacity={frozen ? opacity : 0}
        >
          {frozen ? null : (
            <animate
              attributeName="fill-opacity"
              dur={dur}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values={`0;0;${opacity};${opacity};0;0`}
              keyTimes={`0;${f(p)};${f(p + 0.03)};${f(fadeAt)};${f(
                fadeAt + 0.05,
              )};1`}
            />
          )}
        </rect>
      ))}
    </g>
  );
}

/* ease-out spline for bar fills: launch quickly, decelerate into the mark */
const BAR_EASE = "0.22 0.8 0.36 1";

/* a small horizontal bar filling once per cycle to a target fraction —
   either continuously over one `window`, or stepping up on each of the
   given `phases` (one equal increment per phase, rising over 0.03 so each
   step lands exactly on its dot arrival / pulse) */
export function MiniBar({
  x,
  y,
  w,
  h = 8,
  color,
  target,
  window: win,
  phases,
  dur,
  frozen,
}: {
  x: number;
  y: number;
  w: number;
  h?: number;
  color: string;
  target: number;
  window?: readonly [number, number];
  phases?: readonly number[];
  dur: string;
  frozen: boolean;
}) {
  const fill = w * target;
  let values: string;
  let times: string;
  let splines: string;
  if (phases && phases.length > 0) {
    const v: string[] = ["0", "0"];
    const t: string[] = ["0", f(phases[0])];
    const s: string[] = ["0 0 1 1"];
    phases.forEach((p, i) => {
      const level = f((fill * (i + 1)) / phases.length);
      v.push(level, level);
      t.push(f(p + 0.03), i + 1 < phases.length ? f(phases[i + 1]) : "1");
      s.push(BAR_EASE, "0 0 1 1");
    });
    values = v.join(";");
    times = t.join(";");
    splines = s.join(";");
  } else {
    const [start, end] = win ?? [0.06, 0.78];
    values = `0;0;${fill};${fill}`;
    times = `0;${f(start)};${f(end)};1`;
    splines = `0 0 1 1;${BAR_EASE};0 0 1 1`;
  }
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={C.paper2} />
      <rect
        x={x}
        y={y}
        width={frozen ? fill : 0}
        height={h}
        rx={h / 2}
        fill={color}
      >
        {frozen ? null : (
          <>
            <animate
              attributeName="width"
              dur={dur}
              begin="0s"
              repeatCount="indefinite"
              calcMode="spline"
              keySplines={splines}
              values={values}
              keyTimes={times}
            />
            <animate
              attributeName="opacity"
              dur={dur}
              begin="0s"
              repeatCount="indefinite"
              calcMode="linear"
              values="1;1;0;0"
              keyTimes="0;0.93;0.98;1"
            />
          </>
        )}
      </rect>
    </g>
  );
}
