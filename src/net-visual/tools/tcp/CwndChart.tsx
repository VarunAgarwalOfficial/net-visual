import { memo, useMemo } from "react"

import type { ChartFigure } from "../../components/figure"
import { LineChart, type Series } from "../../components/LineChart"
import { algoName, thinMarks, valueAt, type Algo, type TcpParams, type TcpRun } from "../../core/tcp"

/** Flows are told apart by tone and dash, and named at their line ends; colour is kept for meaning. */
export const FLOW_COLORS = ["var(--foreground)", "var(--muted-foreground)", "var(--foreground)", "var(--muted-foreground)"]
export const FLOW_DASH = [undefined, undefined, "7 3", "2 3"]
const COMPARE_COLOR = "var(--foreground)"
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

/** What each version does to its window when a packet is lost, for the chart's key. */
const afterLoss = (a: Algo) =>
  a === "tahoe"
    ? "after a loss, starts again from 1 packet"
    : a === "reno" || a === "newreno"
      ? "after a loss, halves its window"
      : undefined

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
    label: `window, ${flowLabel(p, i)}`,
    color: FLOW_COLORS[i],
    dash: FLOW_DASH[i],
    kind: "step",
    points: s.cwnd,
    note: p.flows.length === 1 ? afterLoss(p.flows[0].algo) : undefined,
  }))
  if (compare && cmp)
    series.push({
      id: "compare",
      label: `window, ${algoName(cmp)} on the same path (dashed)`,
      color: COMPARE_COLOR,
      kind: "step",
      points: compare.series[0].cwnd,
      dashed: true,
      dash: "10 5",
      note: afterLoss(cmp),
    })
  if (p.flows.length === 1) {
    // Before the first loss ssthresh may be effectively infinite; draw it from where it fits.
    const ss = toEnd(run.series[0].ssthresh, p.duration_us).filter(([, v]) => v <= top)
    if (ss.length)
      series.push({
        id: "ssthresh",
        label: "slow-start threshold (grey dashed)",
        note: "below it the window doubles each round trip;\na loss sets it to half the window",
        color: SSTHRESH_COLOR,
        kind: "step",
        points: ss,
        dashed: true,
        dash: "3 4",
      })
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
  const all = useMemo(() => {
    const s = run.series[0]
    const at = (time: number) => valueAt(s.cwnd, time - 1)
    return {
      fast: thinMarks(s.marks, "fast", 150).map((m) => [m.t, at(m.t)] as const),
      timeout: thinMarks(s.marks, "timeout", 150).map((m) => [m.t, at(m.t)] as const),
      drops: run.series.map((f) => thinMarks(f.marks, "drop", 1500).map((m) => m.t)),
    }
  }, [run])
  // Only what has happened by the clock is marked; the rest of the run is not known yet.
  const marks = {
    fast: all.fast.filter(([x]) => x <= t),
    timeout: all.timeout.filter(([x]) => x <= t),
    drops: all.drops.map((ts) => ts.filter((x) => x <= t)),
  }
  const firstDrop = marks.drops.flat().reduce((a, b) => Math.min(a, b), Infinity)
  const { bdp_pkts: bdp, pipe_pkts: pipe } = run.theory
  const refs: [number, string][] = [
    [bdp, `the path holds ${bdp.toFixed(0)} (bandwidth-delay product)`],
    [pipe, `path and router buffer full: ${pipe.toFixed(0)}`],
  ]
  return (
    <div>
      <LineChart
        title="Congestion window: how many packets the sender may have on the way"
        series={series}
        xLabel="simulated time (seconds)"
        yLabel="packets"
        xFormat={seconds}
        yFormat={(y) => (y >= 100 ? y.toFixed(0) : String(Number(y.toFixed(1))))}
        xDomain={[0, p.duration_us]}
        yDomain={[0, top]}
        height={280}
        keyEarly
        cursor={t}
        upTo={t}
        onSeek={onSeek}
        overlay={({ sx, sy, right, top: y0, bottom }) => (
          // Words and marks go over the lines, each on a ground of the page colour.
          <g pointerEvents="none">
            {band && (
              <text x={sx(band[0]) + 4} y={y0 + 18} fontSize="17" fill="var(--chart-ink)">
                shaded: in the sequence diagram
              </text>
            )}
            {refs.map(([v, text]) =>
              v <= top ? (
                <text key={text} x={right - 4} y={sy(v) - 4} textAnchor="end" fontSize="17" fill="var(--chart-ink)" {...HALO}>
                  {text}
                </text>
              ) : null,
            )}
            {firstDrop < Infinity && (
              <text x={sx(firstDrop) + 5} y={bottom - 4} fontSize="17" fill="var(--chart-ink)" {...HALO}>
                {marks.drops.length > 1 ? "packet lost (ticks, one row per flow)" : "packet lost (ticks)"}
              </text>
            )}
            {marks.fast.slice(0, 1).map(([x, y]) => (
              <text key="fast-label" x={sx(x) + 7} y={sy(y) - 12} fontSize="17" fill="var(--nv-again)" {...HALO}>
                fast retransmit
              </text>
            ))}
            {marks.timeout.slice(0, 1).map(([x, y]) => (
              <text key="timeout-label" x={sx(x) + 7} y={sy(y) - 3} fontSize="17" fill="var(--nv-bad)" {...HALO}>
                timer ran out
              </text>
            ))}
            {marks.fast.map(([x, y], i) => (
              <path key={`f${i}`} d={`M${sx(x)},${sy(y) - 3}l-4,-7h8z`} fill="var(--nv-again)" stroke="var(--background)" strokeWidth={1} />
            ))}
            {marks.timeout.map(([x, y], i) => (
              <rect
                key={`t${i}`}
                x={sx(x) - 4}
                y={sy(y) - 12}
                width={8}
                height={8}
                fill="var(--background)"
                stroke="var(--nv-bad)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      >
        {({ sx, sy, left, right, top: y0, bottom }) => (
          // Under the lines: the shaded span, the two reference levels, the loss ticks.
          <g pointerEvents="none">
            {band && (
              <rect
                x={sx(band[0])}
                y={y0}
                width={Math.max(1, sx(Math.min(band[1], p.duration_us)) - sx(band[0]))}
                height={bottom - y0}
                fill="var(--nv-mark)"
              />
            )}
            {refs.map(([v, text]) =>
              v <= top ? <line key={text} x1={left} x2={right} y1={sy(v)} y2={sy(v)} stroke="var(--chart-ink)" strokeDasharray="1 3" /> : null,
            )}
            {marks.drops.map((ts, i) => (
              <path key={i} d={ts.map((x) => `M${sx(x).toFixed(1)},${bottom}v-${5 + 3 * i}`).join("")} stroke="var(--nv-bad)" fill="none" />
            ))}
          </g>
        )}
      </LineChart>
    </div>
  )
})

/** A ground of the page colour round a label, so a line under it does not run through its letters. */
const HALO = { stroke: "var(--background)", strokeWidth: 4, strokeLinejoin: "round", paintOrder: "stroke" } as const

/** The window chart as an exportable figure. */
export function cwndFigure(run: TcpRun, compare: TcpRun | null, cmp: Algo | null, p: TcpParams, caption: string): ChartFigure {
  const { series, top } = build(run, compare, cmp, p)
  return {
    xLabel: "time (seconds)",
    yLabel: "congestion window (packets)",
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
