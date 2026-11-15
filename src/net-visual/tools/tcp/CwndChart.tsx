import { memo, useMemo } from "react"

import type { ChartFigure } from "../../components/figure"
import { LineChart, type Series } from "../../components/LineChart"
import { algoName, thinMarks, valueAt, type Algo, type TcpParams, type TcpRun } from "../../core/tcp"

/** One colour per flow, in order; flow 0 matches the data packets in the ladder. */
export const FLOW_COLORS = ["var(--chart-1)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const COMPARE_COLOR = "var(--chart-2)"
const SSTHRESH_COLOR = "var(--muted-foreground)"

/** Microseconds as seconds, with as many decimals as the value needs (up to three; one from 10 s). */
export const seconds = (us: number) => {
  const s = us / 1e6
  return String(Number(s.toFixed(s >= 10 ? 1 : 3)))
}

/** A step series carried on to the end of the run, so a last value that never changes is still drawn. */
export function toEnd(points: [number, number][], end: number): [number, number][] {
  const last = points[points.length - 1]
  return last && last[0] < end ? [...points, [end, last[1]]] : points
}

export const flowLabel = (p: TcpParams, i: number) =>
  p.flows.length > 1 ? `flow ${i + 1}, ${algoName(p.flows[i].algo)}, ${p.flows[i].rtt_us / 1000} ms` : algoName(p.flows[i].algo)

interface Built {
  series: Series[]
  top: number
}

/** The series of the window chart, shared by the screen and the exported figure. */
function build(run: TcpRun, compare: TcpRun | null, cmp: Algo | null, p: TcpParams): Built {
  const cwndMax = Math.max(1, ...run.series.flatMap((s) => s.cwnd.map(([, c]) => c)), ...(compare?.series[0].cwnd.map(([, c]) => c) ?? []))
  const bdp = run.theory.bdp_pkts
  const top = (bdp <= 2 * cwndMax ? Math.max(cwndMax, bdp) : cwndMax) * 1.08
  const series: Series[] = run.series.map((s, i) => ({
    id: `cwnd${i}`,
    label: `cwnd, ${flowLabel(p, i)}`,
    color: FLOW_COLORS[i],
    kind: "step",
    points: s.cwnd,
  }))
  if (compare && cmp)
    series.push({
      id: "compare",
      label: `cwnd, ${algoName(cmp)} on the same path`,
      color: COMPARE_COLOR,
      kind: "step",
      points: compare.series[0].cwnd,
      dashed: true,
    })
  if (p.flows.length === 1) {
    // Before the first loss ssthresh may be effectively infinite; draw it from where it fits.
    const ss = toEnd(run.series[0].ssthresh, p.duration_us).filter(([, v]) => v <= top)
    if (ss.length) series.push({ id: "ssthresh", label: "ssthresh", color: SSTHRESH_COLOR, kind: "step", points: ss, dashed: true })
  }
  return { series, top }
}

/**
 * The congestion window of every flow over the whole run, with ssthresh, the
 * same flow under another algorithm (dashed), the bandwidth-delay product and
 * the most the path holds (BDP + B + 1), fast retransmits, timeouts and a rug
 * of drops. The shaded band is the stretch whose packets the ladder can show.
 */
export const CwndChart = memo(function CwndChart({
  run,
  compare,
  cmp,
  p,
  t,
  band,
  onSeek,
}: {
  run: TcpRun
  compare: TcpRun | null
  cmp: Algo | null
  p: TcpParams
  t: number
  band: [number, number] | null
  onSeek(t: number): void
}) {
  const { series, top } = useMemo(() => build(run, compare, cmp, p), [run, compare, cmp, p])
  const marks = useMemo(() => {
    const s = run.series[0]
    const at = (time: number) => valueAt(s.cwnd, time - 1)
    return {
      fast: thinMarks(s.marks, "fast", 150).map((m) => [m.t, at(m.t)] as const),
      timeout: thinMarks(s.marks, "timeout", 150).map((m) => [m.t, at(m.t)] as const),
      drops: run.series.map((f) => thinMarks(f.marks, "drop", 1500).map((m) => m.t)),
    }
  }, [run])
  const { bdp_pkts: bdp, pipe_pkts: pipe } = run.theory
  return (
    <div>
      <LineChart
        title="Congestion window"
        series={series}
        xLabel="time (s)"
        yLabel="segments"
        xFormat={seconds}
        yFormat={(y) => (y >= 100 ? y.toFixed(0) : String(Number(y.toFixed(1))))}
        xDomain={[0, p.duration_us]}
        yDomain={[0, top]}
        height={280}
        cursor={t}
        onSeek={onSeek}
      >
        {({ sx, sy, left, right, top: y0, bottom }) => (
          <g pointerEvents="none">
            {band && (
              <rect
                x={sx(band[0])}
                y={y0}
                width={Math.max(1, sx(Math.min(band[1], p.duration_us)) - sx(band[0]))}
                height={bottom - y0}
                fill="var(--link)"
                fillOpacity={0.07}
              />
            )}
            {[
              [bdp, `BDP ${bdp.toFixed(0)}`],
              [pipe, `BDP + B + 1 = ${pipe.toFixed(0)}`],
            ].map(([v, text]) =>
              (v as number) <= top ? (
                <g key={text}>
                  <line x1={left} x2={right} y1={sy(v as number)} y2={sy(v as number)} stroke="var(--chart-ink)" strokeDasharray="1 3" />
                  <text x={right - 4} y={sy(v as number) - 4} textAnchor="end" fontSize="10.5" fill="var(--chart-ink)">
                    {text}
                  </text>
                </g>
              ) : null,
            )}
            {marks.drops.map((ts, i) => (
              <path
                key={i}
                d={ts.map((x) => `M${sx(x).toFixed(1)},${bottom}v-${5 + 3 * i}`).join("")}
                stroke={FLOW_COLORS[i]}
                strokeOpacity={0.7}
              />
            ))}
            {marks.fast.map(([x, y], i) => (
              <path
                key={`f${i}`}
                d={`M${sx(x)},${sy(y) - 3}l-4,-7h8z`}
                fill="var(--foreground)"
                stroke="var(--background)"
                strokeWidth={1}
              />
            ))}
            {marks.timeout.map(([x, y], i) => (
              <rect
                key={`t${i}`}
                x={sx(x) - 4}
                y={sy(y) - 12}
                width={8}
                height={8}
                fill="var(--background)"
                stroke="var(--destructive)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </LineChart>
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-sans text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <svg width="10" height="9" aria-hidden>
            <path d="M1,1h8l-4,7z" fill="var(--foreground)" />
          </svg>
          fast retransmit
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden>
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="var(--destructive)" strokeWidth="2" />
          </svg>
          timeout
        </span>
        <span className="flex items-center gap-1">
          <svg width="6" height="10" aria-hidden>
            <path d="M3,10v-8" stroke="var(--chart-1)" />
          </svg>
          drop (along the bottom)
        </span>
        {band && <span>shaded: the stretch the ladder shows; click the chart to move there</span>}
      </p>
    </div>
  )
})

/** The window chart as an exportable figure. */
export function cwndFigure(run: TcpRun, compare: TcpRun | null, cmp: Algo | null, p: TcpParams, caption: string): ChartFigure {
  const { series, top } = build(run, compare, cmp, p)
  return {
    xLabel: "time (s)",
    yLabel: "congestion window (segments)",
    xFormat: seconds,
    yFormat: (y) => y.toFixed(0),
    xDomain: [0, p.duration_us],
    yDomain: [0, top],
    series: series.map((s) => ({ label: s.label, color: s.color, points: s.points, dashed: s.dashed, step: s.kind === "step" })),
    refs: [
      { y: run.theory.bdp_pkts, label: "BDP" },
      { y: run.theory.pipe_pkts, label: "BDP + B + 1" },
    ],
    caption,
  }
}
