import { memo, useMemo } from "react"

import { LineChart, type Series } from "../../components/LineChart"
import { Tex, texNum } from "../../components/Tex"
import { lastAtOrBefore } from "../../components/timeline"
import { mbps, smooth, valueAt, type State, type TcpParams, type TcpRun } from "../../core/tcp"
import { FLOW_COLORS } from "./CwndChart"

const seconds = (us: number) => {
  const s = us / 1e6
  return s >= 10 || Number.isInteger(s) ? s.toFixed(0) : s.toFixed(s >= 1 ? 1 : 2)
}
const txOf = (p: TcpParams) => (8 * p.mss_bytes * 1e6) / p.rate_bps

/** CUBIC's C (RFC 9438, 4.1), as in the model. */
const C = 0.4

/**
 * The network at time t: every sender, the bottleneck router with its
 * drop-tail buffer, and the receiver. The buffer fills from the link end;
 * past 40 slots it is drawn as a bar.
 */
export function Dumbbell({ run, p, t }: { run: TcpRun; p: TcpParams; t: number }) {
  const q = valueAt(run.queue, t)
  const B = p.buffer_pkts
  const tx = txOf(p)
  const n = p.flows.length
  const rowY = (i: number) => 30 + ((i + 0.5) * 140) / n
  const rx = 330
  const slots = B <= 40 && B > 0
  const bufW = 130
  const bufX = rx - 18 - bufW
  return (
    <figure className="font-sans">
      <figcaption className="mb-1 text-sm text-muted-foreground">The path at {seconds(t)} s</figcaption>
      <svg
        viewBox="0 0 520 200"
        className="h-auto w-full max-w-[40rem]"
        role="img"
        aria-label={`Bottleneck queue: ${q} of ${B} packets waiting`}
      >
        {p.flows.map((f, i) => {
          const cwnd = valueAt(run.series[i].cwnd, t)
          const started = t >= f.start_us
          return (
            <g key={i} opacity={started ? 1 : 0.35}>
              <line x1={52} y1={rowY(i)} x2={bufX} y2={100} stroke={FLOW_COLORS[i]} strokeWidth={2} />
              <circle cx={36} cy={rowY(i)} r={14} fill="var(--background)" stroke={FLOW_COLORS[i]} strokeWidth={2.5} />
              <text x={36} y={rowY(i)} dy="0.35em" textAnchor="middle" fontSize="12" fill="var(--foreground)">
                {i + 1}
              </text>
              <text x={56} y={rowY(i) - (n > 2 ? 8 : 12)} fontSize="11" fill="var(--muted-foreground)">
                {started
                  ? `cwnd ${cwnd >= 100 ? cwnd.toFixed(0) : cwnd.toFixed(1)}, ${f.rtt_us / 1000} ms`
                  : `starts at ${seconds(f.start_us)} s`}
              </text>
            </g>
          )
        })}
        {/* the buffer */}
        <rect x={bufX} y={86} width={bufW} height={28} fill="none" stroke="var(--foreground)" />
        {B === 0 ? (
          <text x={bufX + bufW / 2} y={100} dy="0.35em" textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">
            no buffer
          </text>
        ) : slots ? (
          Array.from({ length: B }, (_, k) => {
            const w = bufW / B
            const filled = k >= B - q
            return (
              <rect
                key={k}
                x={bufX + k * w + 1}
                y={89}
                width={Math.max(1, w - 2)}
                height={22}
                fill={filled ? "var(--chart-1)" : "transparent"}
                stroke="var(--border)"
              />
            )
          })
        ) : (
          <rect x={bufX + bufW * (1 - q / B)} y={89} width={(bufW * q) / B} height={22} fill="var(--chart-1)" />
        )}
        <text x={bufX + bufW / 2} y={78} textAnchor="middle" fontSize="11" fill="var(--foreground)">
          buffer: {q} of {B} waiting
        </text>
        <text x={bufX + bufW / 2} y={132} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">
          adds {texFree(q * tx)} of queueing delay
        </text>
        {/* router and link */}
        <circle cx={rx} cy={100} r={16} fill="var(--background)" stroke="var(--foreground)" strokeWidth={1.5} />
        <path d={`M${rx - 8},${100}h16M${rx},${92}v16`} stroke="var(--foreground)" strokeWidth={1.5} />
        <line x1={rx + 16} y1={100} x2={470} y2={100} stroke="var(--foreground)" strokeWidth={q > 0 ? 4 : 2} />
        <text x={(rx + 470) / 2 + 8} y={90} textAnchor="middle" fontSize="11" fill="var(--foreground)">
          {mbps(p.rate_bps)}
        </text>
        <text x={(rx + 470) / 2 + 8} y={118} textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">
          {q > 0 ? "busy" : "may idle"}
        </text>
        <rect x={470} y={86} width={34} height={28} rx={4} fill="var(--background)" stroke="var(--foreground)" strokeWidth={1.5} />
        <text x={487} y={100} dy="0.35em" textAnchor="middle" fontSize="11" fill="var(--foreground)">
          rcv
        </text>
        <text x={260} y={190} textAnchor="middle" fontSize="10.5" fill="var(--muted-foreground)">
          ACKs return over an uncongested path; each flow's round trip is its own propagation delay plus the queue
        </text>
      </svg>
    </figure>
  )
}

/** A step series held at its last value to the end of the run. */
function toEnd(points: [number, number][], end: number): [number, number][] {
  const last = points[points.length - 1]
  return last && last[0] < end ? [...points, [end, last[1]]] : points
}

/** A duration in plain text: microseconds, milliseconds or seconds. */
function texFree(us: number) {
  if (us < 1000) return `${us.toFixed(0)} µs`
  if (us < 1e6) return `${(us / 1000).toFixed(us < 1e4 ? 1 : 0)} ms`
  return `${(us / 1e6).toFixed(2)} s`
}

/**
 * The bottleneck queue over the run. Each waiting packet adds one
 * transmission time to the round trip of every packet behind it.
 */
export const QueueChart = memo(function QueueChart({
  run,
  p,
  t,
  onSeek,
}: {
  run: TcpRun
  p: TcpParams
  t: number
  onSeek(t: number): void
}) {
  const series = useMemo<Series[]>(
    () => [{ id: "q", label: "packets waiting", color: "var(--chart-1)", kind: "step", points: run.queue }],
    [run],
  )
  const top = Math.max(1, p.buffer_pkts, run.totals.max_queue) * 1.08
  return (
    <LineChart
      title="Bottleneck queue"
      series={series}
      xLabel="time (s)"
      yLabel="packets"
      xFormat={seconds}
      yFormat={(y) => y.toFixed(0)}
      xDomain={[0, p.duration_us]}
      yDomain={[0, top]}
      height={180}
      cursor={t}
      onSeek={onSeek}
    >
      {({ sy, left, right }) =>
        p.buffer_pkts > 0 && (
          <g pointerEvents="none">
            <line x1={left} x2={right} y1={sy(p.buffer_pkts)} y2={sy(p.buffer_pkts)} stroke="var(--destructive)" strokeDasharray="4 3" />
            <text x={right - 4} y={sy(p.buffer_pkts) - 4} textAnchor="end" fontSize="10.5" fill="var(--destructive)">
              B = {p.buffer_pkts}: the next arrival is dropped
            </text>
          </g>
        )
      }
    </LineChart>
  )
})

/**
 * Flow 1's smoothed round trip and retransmission timeout (RFC 6298), against
 * the shortest round trip (an empty queue) and the longest (a full one).
 */
export const RttChart = memo(function RttChart({ run, p, t, onSeek }: { run: TcpRun; p: TcpParams; t: number; onSeek(t: number): void }) {
  const tx = txOf(p)
  const base = p.flows[0].rtt_us + tx
  const full = base + p.buffer_pkts * tx
  const { series, top, clipped } = useMemo(() => {
    const s = run.series[0]
    const srttMax = Math.max(base, ...s.srtt.map(([, v]) => v))
    const top = Math.max(full, srttMax) * 1.25
    const clipped = s.rto.some(([, v]) => v > top)
    const series: Series[] = [
      { id: "srtt", label: "SRTT", color: "var(--chart-1)", kind: "step", points: toEnd(s.srtt, p.duration_us) },
      {
        id: "rto",
        label: clipped ? "RTO (cut off at the top)" : "RTO",
        color: "var(--chart-2)",
        kind: "step",
        points: toEnd(s.rto, p.duration_us).map(([x, v]) => [x, Math.min(v, top)]),
        dashed: true,
      },
    ]
    return { series, top, clipped }
  }, [run, base, full, p.duration_us])
  const ms = (us: number) => (us / 1000).toFixed(us < 10_000 ? 1 : 0)
  return (
    <div>
      <LineChart
        title="Round trip and timeout, flow 1"
        series={series}
        xLabel="time (s)"
        yLabel="ms"
        xFormat={seconds}
        yFormat={ms}
        xDomain={[0, p.duration_us]}
        yDomain={[0, top]}
        height={180}
        cursor={t}
        onSeek={onSeek}
      >
        {({ sy, left, right }) => (
          <g pointerEvents="none">
            {[
              [base, "empty queue"],
              [full, "full queue"],
            ].map(([v, text]) =>
              (v as number) < top && (text === "empty queue" || p.buffer_pkts > 0) ? (
                <g key={text}>
                  <line x1={left} x2={right} y1={sy(v as number)} y2={sy(v as number)} stroke="var(--chart-ink)" strokeDasharray="1 3" />
                  <text x={left + 4} y={sy(v as number) - 4} fontSize="10.5" fill="var(--chart-ink)">
                    {text}, {ms(v as number)} ms
                  </text>
                </g>
              ) : null,
            )}
          </g>
        )}
      </LineChart>
      {clipped && (
        <p className="mt-1 font-sans text-xs text-muted-foreground">
          The timeout never falls below {texFree(p.min_rto_us)} (the minimum RTO), so it runs off the top of this scale.
        </p>
      )}
    </div>
  )
})

/**
 * Chiu and Jain's phase plane (1989): one axis per flow's rate. Points on the
 * efficiency line use the whole link; points on the 45-degree line are fair.
 * Additive increase moves the point parallel to the fairness line;
 * multiplicative decrease moves it towards the origin, which shrinks the
 * gap between the flows.
 */
export const PhasePlane = memo(function PhasePlane({ run, p, t }: { run: TcpRun; p: TcpParams; t: number }) {
  const R = p.rate_bps
  const tx = txOf(p)
  const { xs, ys, all } = useMemo(() => {
    const g = run.grid
    // Average over about two of the longest round trips, so that one sawtooth
    // tooth reads as one move rather than packet-level noise.
    const w = Math.max(1, Math.round((2 * (Math.max(...p.flows.map((f) => f.rtt_us)) + tx)) / g.dt_us))
    const all = g.rate.map((r) => smooth(r, w))
    return { xs: all[0], ys: all[1] ?? [], all }
  }, [run, p, tx])
  const g = run.grid
  const i = Math.min(g.t.length - 1, lastAtOrBefore(g.t, t))
  const S = 260
  const pad = 36
  const max = R * 1.08
  const X = (v: number) => pad + (v / max) * S
  const Y = (v: number) => pad + S - (v / max) * S
  const path = (from: number, to: number) => {
    let d = ""
    for (let k = from; k <= to && k < xs.length; k++) d += `${k > from ? "L" : "M"}${X(xs[k]).toFixed(1)},${Y(ys[k]).toFixed(1)}`
    return d
  }
  const now = i >= 0 ? all.map((r) => r[i]) : all.map(() => 0)
  const sum = now.reduce((a, b) => a + b, 0)
  const sq = now.reduce((a, b) => a + b * b, 0)
  const jain = sq > 0 ? (sum * sum) / (now.length * sq) : 1
  const recent = Math.max(0, i - Math.round(2e6 / g.dt_us))
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <figure className="font-sans">
      <figcaption className="mb-1 text-sm text-muted-foreground">
        Phase plane: flow 1 against flow 2 (Chiu and Jain, 1989){p.flows.length > 2 ? "; flows 3 and on count only in Jain's index" : ""}
      </figcaption>
      <svg
        viewBox={`0 0 ${S + pad + 12} ${S + pad + 30}`}
        className="h-auto w-full max-w-[22rem]"
        role="img"
        aria-label={`At ${seconds(t)} s flow 1 gets ${mbps(now[0] ?? 0)} and flow 2 ${mbps(now[1] ?? 0)}; Jain's index ${jain.toFixed(3)}`}
      >
        <rect x={pad} y={pad} width={S} height={S} fill="none" stroke="var(--border)" />
        {ticks.map((f) => (
          <g key={f} fontSize="10" fill="var(--muted-foreground)">
            <text x={X(f * R)} y={pad + S + 14} textAnchor="middle">
              {f === 0 ? "0" : `${f}R`}
            </text>
            <text x={pad - 6} y={Y(f * R)} dy="0.35em" textAnchor="end">
              {f === 0 ? "" : `${f}R`}
            </text>
          </g>
        ))}
        <line x1={X(0)} y1={Y(0)} x2={X(max)} y2={Y(max)} stroke="var(--chart-ink)" strokeDasharray="5 4" />
        <text x={X(R * 0.98)} y={Y(R * 1.02)} textAnchor="end" fontSize="10.5" fill="var(--chart-ink)">
          fair: x = y
        </text>
        <line x1={X(R)} y1={Y(0)} x2={X(0)} y2={Y(R)} stroke="var(--chart-ink)" />
        <text
          x={X(R * 0.52)}
          y={Y(R * 0.52) + 18}
          fontSize="10.5"
          fill="var(--chart-ink)"
          transform={`rotate(45 ${X(R * 0.52)} ${Y(R * 0.52) + 18})`}
        >
          efficient: x + y = R
        </text>
        <path d={path(0, xs.length - 1)} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.25} strokeWidth={1} />
        <path d={path(0, i)} fill="none" stroke="var(--chart-1)" strokeOpacity={0.45} strokeWidth={1.25} />
        {i > recent && <path d={path(recent, i)} fill="none" stroke="var(--chart-1)" strokeWidth={2.25} />}
        {i >= 0 && <circle cx={X(xs[i])} cy={Y(ys[i])} r={5} fill="var(--chart-1)" stroke="var(--background)" strokeWidth={1.5} />}
        <text x={pad + S / 2} y={S + pad + 28} textAnchor="middle" fontSize="11" fill="var(--foreground)">
          flow 1 goodput (x)
        </text>
        <text x={12} y={pad + S / 2} textAnchor="middle" fontSize="11" fill="var(--foreground)" transform={`rotate(-90 12 ${pad + S / 2})`}>
          flow 2 goodput (y)
        </text>
      </svg>
      <p className="mt-1 font-sans text-sm tabular-nums">
        Jain's index now <b>{jain.toFixed(3)}</b>{" "}
        <span className="text-muted-foreground">
          (1 is equal shares; 1/n is one flow taking everything). The bold trail is the last two seconds.
        </span>
      </p>
    </figure>
  )
})

/**
 * CUBIC's window curve for the current epoch, W(t) = C(t - K)^3 + W_max
 * (RFC 9438, eq. 1): concave while it climbs back to the old maximum, flat
 * near it, convex as it probes beyond. The model does not report when the
 * epoch began, so the dot is placed where the curve equals today's window.
 */
export function CubicCurve({ s }: { s: State }) {
  const { w_max, k, cwnd, region } = s
  const span = Math.max(2 * k, 1)
  const points = useMemo<[number, number][]>(
    () => Array.from({ length: 121 }, (_, j) => [(j / 120) * span, C * ((j / 120) * span - k) ** 3 + w_max]),
    [span, k, w_max],
  )
  const tNow = Math.min(span, Math.max(0, k + Math.cbrt((cwnd - w_max) / C)))
  const lo = Math.min(...points.map(([, w]) => w), cwnd)
  const hi = Math.max(...points.map(([, w]) => w), cwnd)
  const series: Series[] = [
    { id: "w", label: "W_cubic(t)", color: "var(--chart-1)", kind: "line", points },
    {
      id: "wmax",
      label: "W_max",
      color: "var(--chart-ink)",
      kind: "line",
      points: [
        [0, w_max],
        [span, w_max],
      ],
      dashed: true,
    },
  ]
  return (
    <div>
      <LineChart
        title="CUBIC's curve this epoch"
        series={series}
        xLabel="seconds since the epoch began"
        yLabel="segments"
        xFormat={(x) => x.toFixed(1)}
        yFormat={(y) => y.toFixed(0)}
        xDomain={[0, span]}
        yDomain={[Math.max(0, lo - (hi - lo) * 0.1), hi + (hi - lo) * 0.1 + 1]}
        height={180}
      >
        {({ sx, sy, top, bottom }) => (
          <g pointerEvents="none">
            <line x1={sx(k)} x2={sx(k)} y1={top} y2={bottom} stroke="var(--chart-ink)" strokeDasharray="1 3" />
            <text x={sx(k) + 4} y={bottom - 6} fontSize="10.5" fill="var(--chart-ink)">
              K = {k.toFixed(2)} s
            </text>
            {region !== "F" && (
              <circle cx={sx(tNow)} cy={sy(cwnd)} r={5} fill="var(--chart-1)" stroke="var(--background)" strokeWidth={1.5} />
            )}
          </g>
        )}
      </LineChart>
      <p className="mt-1 font-sans text-xs text-muted-foreground">
        {region === "F"
          ? "Reno-friendly region: the curve is below what Reno would have by now (W_est), so cwnd follows W_est instead."
          : region === "C"
            ? "Concave region: climbing back towards W_max, fast at first and slowing as it nears."
            : region === "X"
              ? "Convex region: past W_max, probing for more, slowly at first and then faster."
              : "Between epochs."}{" "}
        The dot sits where the curve equals the current window.
      </p>
    </div>
  )
}

/** The model's closed forms with the numbers of this run and this moment. */
export const LiveEquations = memo(function LiveEquations({ run, p, s, t }: { run: TcpRun; p: TcpParams; s: State | null; t: number }) {
  const tx = txOf(p)
  const f0 = p.flows[0]
  const q = s?.queue ?? valueAt(run.queue, t)
  const cwnd = s?.cwnd ?? valueAt(run.series[0].cwnd, t)
  const rtt = f0.rtt_us + tx + q * tx
  const ms = (us: number) => texNum(us / 1000, 2)
  const P = run.theory.bdp_pkts
  const W = run.theory.pipe_pkts
  const T = run.totals.flows[0]
  const reno = p.flows.length === 1 && f0.algo !== "cubic"
  const offered = (cwnd * p.mss_bytes * 8) / (rtt / 1e6)
  return (
    <div className="space-y-3 text-[0.95rem]">
      <div>
        <p className="font-sans text-xs text-muted-foreground">The round trip now: propagation, one transmission, and the queue ahead</p>
        <Tex
          display
        >{`\\mathit{RTT} = \\mathit{RTT}_0 + (1 + q)\\,\\frac{\\mathit{MSS}}{R} = ${ms(f0.rtt_us)} + (1 + ${q})\\times ${ms(tx)} = ${ms(rtt)}\\ \\text{ms}`}</Tex>
      </div>
      <div>
        <p className="font-sans text-xs text-muted-foreground">What the window allows, against the link</p>
        <Tex
          display
        >{`\\frac{\\mathit{cwnd}\\cdot\\mathit{MSS}}{\\mathit{RTT}} = \\frac{${texNum(cwnd, 1)}\\times ${p.mss_bytes * 8}\\ \\text{b}}{${ms(rtt)}\\ \\text{ms}} = ${texNum(offered / 1e6, 2)}\\ \\text{Mb/s} \\quad\\text{vs}\\quad R = ${texNum(p.rate_bps / 1e6, 2)}\\ \\text{Mb/s}`}</Tex>
        <p className="font-sans text-xs text-muted-foreground">
          While cwnd is below the bandwidth-delay product {P.toFixed(1)} the link idles part of the time; above it the extra packets queue.
        </p>
      </div>
      {s && (
        <div>
          <p className="font-sans text-xs text-muted-foreground">
            The retransmission timeout (RFC 6298, 2.3 and 2.4), with the model's minimum
          </p>
          <Tex
            display
          >{`\\begin{aligned}\\mathit{RTO} &= \\max\\bigl(${ms(p.min_rto_us)},\\ \\mathit{SRTT} + 4\\,\\mathit{RTTVAR}\\bigr) \\\\ &= \\max\\bigl(${ms(p.min_rto_us)},\\ ${ms(s.srtt_us)} + 4\\times ${ms(s.rttvar_us)}\\bigr) = ${ms(s.rto_us)}\\ \\text{ms}\\end{aligned}`}</Tex>
          {s.srtt_us === 0 && (
            <p className="font-sans text-xs text-muted-foreground">No sample yet: RTO starts at one second (RFC 6298, 2.1).</p>
          )}
          {s.srtt_us > 0 && Math.abs(s.rto_us - Math.max(p.min_rto_us, s.srtt_us + 4 * s.rttvar_us)) > 1 && (
            <p className="font-sans text-xs text-muted-foreground">
              RTO is doubled by back-off after a timeout and stays so until a fresh sample (Karn).
            </p>
          )}
        </div>
      )}
      {reno && (
        <div>
          <p className="font-sans text-xs text-muted-foreground">
            One Reno sawtooth between W/2 and W = P + B + 1 packets, buffer full at the top (derived in the model's source)
          </p>
          <Tex
            display
          >{`U = \\frac{3W^2/8}{P\\,(P - W/2) + (W^2 - P^2)/2} = ${W >= 2 * P ? "1 \\ (\\text{since } W \\ge 2P)" : texNum(run.theory.reno_utilisation, 3)}, \\qquad P = ${texNum(P, 1)},\\ W = ${texNum(W, 1)}`}</Tex>
          <p className="font-sans text-xs text-muted-foreground">
            Measured: {run.totals.utilisation.toFixed(3)}.{" "}
            {p.drops.length > 0 || p.drop_every > 0 || p.loss > 0
              ? "This run also loses packets on purpose, so its losses are not only buffer overflows and the formula need not hold."
              : T.drops === 0
                ? "No packet overflowed the buffer in this run, so the sawtooth never started and the formula does not apply yet."
                : ""}
          </p>
        </div>
      )}
      {T.loss_rate > 0 && run.theory.mathis_bps > 0 && (
        <div>
          <p className="font-sans text-xs text-muted-foreground">
            Mathis, Semke, Mahdavi and Ott (1997), with flow 1's measured loss rate p and mean round trip
          </p>
          <Tex
            display
          >{`X = \\frac{\\mathit{MSS}}{\\mathit{RTT}}\\sqrt{\\frac{3}{2p}} = \\frac{${p.mss_bytes * 8}\\ \\text{b}}{${ms(T.mean_rtt_us)}\\ \\text{ms}}\\sqrt{\\frac{3}{2\\times ${texNum(T.loss_rate, 4)}}} = ${texNum(run.theory.mathis_bps / 1e6, 3)}\\ \\text{Mb/s}`}</Tex>
          <p className="font-sans text-xs text-muted-foreground">
            Measured goodput {mbps(T.goodput_bps)}; with timeouts (Padhye et al., 1998) the prediction is {mbps(run.theory.pftk_bps)}.
            {f0.algo === "cubic" &&
              " Both formulas describe Reno. CUBIC grows faster at the same loss rate, so it can beat them; its Reno-friendly region (RFC 9438, Section 4.3) only keeps its window from falling below an estimate of Reno's."}
            {f0.algo !== "cubic" &&
              run.totals.utilisation > 0.97 &&
              " The link is full here, so goodput cannot rise above the link rate whatever the formula says."}
          </p>
        </div>
      )}
      {f0.algo === "cubic" && s && s.w_max > 0 && (
        <div>
          <p className="font-sans text-xs text-muted-foreground">CUBIC (RFC 9438, eq. 1 and 2) with C = 0.4 and β = 0.7</p>
          <Tex
            display
          >{`W(t) = C\\,(t - K)^3 + W_{\\max}, \\qquad K = \\sqrt[3]{\\frac{W_{\\max} - \\mathit{cwnd}_{\\text{epoch}}}{C}} = ${texNum(s.k, 3)}\\ \\text{s}, \\quad W_{\\max} = ${texNum(s.w_max, 1)}`}</Tex>
          <p className="font-sans text-xs text-muted-foreground">
            After a loss at the full pipe, cwnd_epoch = β W_max and K = ∛(W_max(1 − β)/C) = {run.theory.cubic_k_s.toFixed(2)} s, whatever
            the round trip.
          </p>
        </div>
      )}
    </div>
  )
})
