import { memo, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChartFigure } from "../../components/figure"
import { LineChart, useWidth, type Series } from "../../components/LineChart"
import { ParamSlider, ParamSwitch } from "../../components/Controls"
import { Tex, texNum } from "../../components/Tex"
import { lastAtOrBefore } from "../../components/timeline"
import type { Netsim } from "../../core/netsim"
import {
  bps,
  cumulative,
  delays,
  envelopeExcess,
  flow,
  isSingleQueue,
  occupancy,
  offered,
  propUs,
  releases,
  shares,
  sweepQueue,
  theory,
  transUs,
  us,
  type Discipline,
  type Mode,
  type QEvent,
  type QFlow,
  type QPacket,
  type QueueParams,
  type QueueRun,
  type SweepPoint,
} from "../../core/queue"
import { CSS, FLOW_COLORS, W, pathBox, pathShapes, type PathFigure } from "./pathFigure"

const ms = (v: number) => String(Number((v / 1000).toPrecision(4)))
const DISCIPLINE: Record<Discipline, string> = { fifo: "FIFO", priority: "strict priority", wfq: "WFQ" }

/** "Packet 12" for one flow, "voice packet 12" for several. */
export const packetName = (p: QueueParams, q: QPacket) =>
  p.flows.length > 1 ? `Packet ${q.id} (${p.flows[q.flow].name})` : `Packet ${q.id}`

/** What one event means, in a sentence, with the numbers that matter. */
export function eventText(p: QueueParams, run: QueueRun, e: QEvent): string {
  const q = run.packets[e.packet]
  const f = p.flows[q.flow]
  const who = packetName(p, q)
  const tok = e.tokens === null ? "" : `${Math.floor(e.tokens)} bytes of tokens`
  switch (e.step) {
    case "A1":
      return `${who} (${q.size_bytes} bytes) is created and leaves its source for the router.`
    case "B1":
      if (e.what === "released")
        return e.t === q.t_arrive
          ? `${who} (${q.size_bytes} bytes) finds enough tokens and passes at once; ${tok} are left.`
          : `${who} has its tokens after ${us(e.t - q.t_arrive)} in the shaper and leaves; ${tok} are left.`
      if (e.what === "held") return `${who} (${q.size_bytes} bytes) arrives at the token bucket, which has ${tok}: it is held in line.`
      return `${who} (${q.size_bytes} bytes) finds ${tok}, too few, and the policer drops it.`
    case "B2":
      return e.what === "held"
        ? `${who} enters the leaky bucket and will drip out at ${us(q.t_shaped!)}, ${us(q.t_shaped! - q.t_arrive)} from now, at ${bps(f.shaper.rate_bps)}.`
        : `${who} would overfill the ${f.shaper.bucket_bytes}-byte leaky bucket and spills.`
    case "P1":
      if (e.what === "dropped")
        return `${who} has been processed, but ${p.buffer_pkts} packets are already waiting: the buffer is full, so it is thrown away.`
      return `${who} has been processed (${us(p.proc_us)}) and joins the line for the link${e.waiting > 1 ? `, where ${e.waiting - 1} other${e.waiting > 2 ? "s are" : " is"} waiting` : ""}.`
    case "S1": {
      const why =
        p.discipline === "fifo"
          ? ""
          : p.discipline === "priority"
            ? `, the most urgent waiting (class ${f.priority})`
            : `, the waiting packet the ideal split would finish first`
      return `${who} starts onto the link after waiting ${us(e.t - q.t_join!)} in line${why}. Pushing its ${q.size_bytes} bytes onto the wire takes ${us(transUs(q.size_bytes, p.rate_bps))}, its size divided by the link's rate.`
    }
    case "S2":
      return `The last bit of ${who.toLowerCase()} is on the wire; it reaches the far end ${us(propUs(p))} later, the distance divided by the signal's speed. The link takes the next packet.`
    case "R1": {
      const d = delays(p, q)!
      const parts = [d.shaper ? `shaper ${us(d.shaper)}` : "", `processing ${us(d.processing)}`, `queueing ${us(d.queueing)}`]
      return `${who} reaches the far end, ${us(d.total)} after it was created: ${parts.filter(Boolean).join(", ")}, transmission ${us(d.transmission)}, propagation ${us(d.propagation)}.`
    }
    default:
      return ""
  }
}

/** A short title for the step card, by step and outcome. */
export function eventTitle(e: QEvent): string {
  switch (e.step) {
    case "A1":
      return "A packet sets off"
    case "B1":
      return e.what === "released" ? "Through the token bucket" : e.what === "held" ? "Held for tokens" : "Dropped for want of tokens"
    case "B2":
      return e.what === "held" ? "Into the leaky bucket" : "The leaky bucket spills"
    case "P1":
      return e.what === "dropped" ? "The buffer is full" : "Processed, into the line"
    case "S1":
      return "Onto the wire"
    case "S2":
      return "All on the wire"
    case "R1":
      return "Arrived"
    default:
      return ""
  }
}

/** Why an event came out as it did, where that is not plain from the sentence. */
export function eventWhy(p: QueueParams, e: QEvent): string | undefined {
  if (e.step === "P1" && e.what === "dropped") return `The router holds at most ${p.buffer_pkts} waiting packets; any more are lost.`
  if (e.step === "P1" && e.waiting > 1)
    return p.discipline === "fifo"
      ? "The link sends one packet at a time, in the order they came, so this one waits for those ahead of it."
      : "The link sends one packet at a time, and the router chooses which waiting packet goes next."
  if (e.step === "R1") return "Its time from start to end is these delays added up."
  return undefined
}

/** The path, drawn in the theme's colours. Text grows on narrow screens so it stays legible. */
export const PathView = memo(function PathView({ fig, label }: { fig: PathFigure; label: string }) {
  const [box, width] = useWidth<HTMLDivElement>()
  const k = width > 0 && width < 560 ? Math.min(1.45, 560 / width) : 1
  const shapes = useMemo(() => pathShapes(fig, k), [fig, k])
  return (
    <div ref={box}>
      <svg viewBox={`0 ${pathBox(fig).y0} ${W} ${pathBox(fig).h}`} className="block h-auto w-full font-sans" role="img" aria-label={label}>
        <defs>
          <marker id="nvq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {shapes.map((s, i) =>
          s.kind === "rect" ? (
            <rect
              key={i}
              x={s.x}
              y={s.y}
              width={Math.max(0, s.w)}
              height={Math.max(0, s.h)}
              fill={s.fill ? CSS[s.fill] : "none"}
              fillOpacity={s.opacity}
              stroke={s.stroke ? CSS[s.stroke] : "none"}
              strokeWidth={s.stroke === "ink" && s.fill?.startsWith("flow") ? 2 : 1.2}
              strokeDasharray={s.dashed ? "3 3" : undefined}
            />
          ) : s.kind === "line" ? (
            <line
              key={i}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke={CSS[s.stroke]}
              strokeWidth={s.width ?? 1.2}
              strokeDasharray={s.dashed ? "3 3" : undefined}
              markerEnd={s.arrow ? "url(#nvq-arrow)" : undefined}
            />
          ) : (
            <text key={i} x={s.x} y={s.y} textAnchor={s.anchor} fontSize={s.size} fill={CSS[s.fill]} fontWeight={s.bold ? 600 : undefined}>
              {s.text}
            </text>
          ),
        )}
      </svg>
    </div>
  )
})

/** Measured values up to time t: mean time in the system of packets gone by then, time-average number in it, arrival rate. */
export function useRunning(run: QueueRun) {
  return useMemo(() => {
    const gone = run.packets
      .filter((q) => q.dropped === null && q.t_join !== null && q.t_depart !== null)
      .sort((a, b) => a.t_depart! - b.t_depart!)
    const departs = gone.map((q) => q.t_depart!)
    const sum = [0]
    for (const q of gone) sum.push(sum[sum.length - 1] + (q.t_depart! - q.t_join!))
    const joins = run.packets
      .filter((q) => q.dropped === null && q.t_join !== null)
      .map((q) => q.t_join!)
      .sort((a, b) => a - b)
    const occ = occupancy(run)
    const times = occ.map((o) => o.t)
    const area = [0]
    for (let i = 1; i < occ.length; i++) area.push(area[i - 1] + occ[i - 1].n * (occ[i].t - occ[i - 1].t))
    return (t: number) => {
      const k = lastAtOrBefore(departs, t) + 1
      const i = Math.max(0, lastAtOrBefore(times, t))
      const a = area[i] + occ[i].n * (t - occ[i].t)
      const n = lastAtOrBefore(joins, t) + 1
      return { gone: k, w: k ? sum[k] / k : null, l: t > 0 ? a / t : 0, lambda: t > 0 ? (n / t) * 1e6 : 0, now: occ[i].n }
    }
  }, [run])
}

const Row = ({ k, v, bad }: { k: string; v: string; bad?: boolean }) => (
  <div>
    <dt className="text-xs text-muted-foreground">{k}</dt>
    <dd className={cn("tabular-nums lining", bad && "text-destructive")}>{v}</dd>
  </div>
)

export const Totals = memo(function Totals({ run, p }: { run: QueueRun; p: QueueParams }) {
  const s = run.stats
  const sent = run.packets.length
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
      <Row
        k="Traffic sent, as a share of what the link can carry"
        v={`${offered(p) >= 10 ? "more than 1000%" : `${(100 * offered(p)).toFixed(0)}%`} of ${bps(p.rate_bps)}`}
      />
      <Row k="Arrived at the far end" v={`${s.served} of ${sent} packets`} />
      <Row k="Lost" v={s.dropped ? `${s.dropped} packets (${((100 * s.dropped) / sent).toFixed(1)}%)` : "none"} />
      <Row k="Average wait in line" v={us(s.wait_us)} />
      <Row k="Longest line" v={`${s.max_waiting} packets`} />
      <Row k="Time the link was busy" v={`${(100 * s.busy).toFixed(1)}%`} />
    </dl>
  )
})

/** The formulas that govern the current mode, with this run's numbers in them. */
export function EquationCard({
  mode,
  p,
  run,
  t,
  running,
  focus,
}: {
  mode: Mode
  p: QueueParams
  run: QueueRun
  t: number
  running: ReturnType<typeof useRunning>
  focus: QPacket | null
}) {
  if (mode === "delay") return <DelayEquations p={p} run={run} t={t} running={running} focus={focus} />
  if (mode === "shaping") return <ShapingEquations p={p} run={run} />
  return <SchedulingEquations p={p} run={run} />
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-border p-3">
      <p className="font-sans text-xs text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function DelayEquations({
  p,
  run,
  t,
  running,
  focus,
}: {
  p: QueueParams
  run: QueueRun
  t: number
  running: ReturnType<typeof useRunning>
  focus: QPacket | null
}) {
  const th = theory(p)
  const now = running(t)
  const s = run.stats
  const d = focus ? delays(p, focus) : null
  const nodal = (
    <>
      <Tex display>
        {d
          ? `d = \\underbrace{${texNum(d.processing / 1000)}}_{\\text{proc}} + \\underbrace{${texNum(d.queueing / 1000)}}_{\\text{queue}} + \\underbrace{${texNum(d.transmission / 1000)}}_{L/R} + \\underbrace{${texNum(d.propagation / 1000)}}_{d/s} = ${texNum((d.total - d.shaper) / 1000)}\\ \\text{ms}`
          : `d = d_{\\text{proc}} + d_{\\text{queue}} + L/R + d/s`}
      </Tex>
      <p className="font-sans text-xs text-muted-foreground">
        {focus
          ? `${packetName(p, focus)}, in milliseconds. Pick another in the Packets tab.`
          : "Pick a packet in the Packets tab, or let one reach the far end, to see its four delays."}
      </p>
    </>
  )
  if (!isSingleQueue(p) || th.w === null) {
    const rho = offered(p)
    return (
      <Card title="The four delays of one hop">
        {nodal}
        {rho >= 1 && (
          <p className="font-sans text-sm">
            Offered load ρ = {rho.toFixed(2)} ≥ 1: no buffer is big enough.{" "}
            {p.buffer_pkts > 0
              ? `With room for ${p.buffer_pkts}, the long-run share dropped is 1 − 1/ρ = ${(1 - 1 / rho).toFixed(3)}; this run dropped ${(s.dropped / run.packets.length).toFixed(3)} of all packets, counting the time the buffer took to fill.`
              : "With no limit the queue grows for as long as the run lasts."}
          </p>
        )}
        {rho < 1 && !isSingleQueue(p) && (
          <p className="font-sans text-xs text-muted-foreground">
            The M/M/1 and M/D/1 formulas need one Poisson flow, no shaper and no buffer limit; load the M/M/1 scenario to compare with them.
          </p>
        )}
      </Card>
    )
  }
  const mm1 = th.model === "M/M/1"
  return (
    <Card title={`${th.model}: theory against this run`}>
      <Tex display>{`\\rho = \\frac{\\lambda}{\\mu} = \\frac{${texNum(th.lambda, 0)}}{${texNum(th.mu, 1)}} = ${texNum(th.rho)}`}</Tex>
      {mm1 ? (
        <Tex
          display
        >{`W = \\frac{1}{\\mu - \\lambda} = ${texNum(th.w! / 1000)}\\ \\text{ms}, \\qquad L = \\frac{\\rho}{1-\\rho} = ${texNum(th.l!, 2)}`}</Tex>
      ) : (
        <Tex
          display
        >{`W_q = \\frac{\\rho}{2\\mu(1-\\rho)} = ${texNum(th.wq! / 1000)}\\ \\text{ms}, \\quad W = W_q + \\frac{1}{\\mu} = ${texNum(th.w! / 1000)}\\ \\text{ms}`}</Tex>
      )}
      <dl className="grid grid-cols-3 gap-x-3 font-sans text-sm">
        <Row k="W so far" v={now.w === null ? "–" : us(now.w)} />
        <Row k="L so far" v={now.l.toFixed(2)} />
        <Row k="in system now" v={String(now.now)} />
      </dl>
      <p className="font-sans text-xs text-muted-foreground">
        Over the whole run of {s.served} packets: W = {us(s.system_us)}, L = {s.l.toFixed(3)}, λ = {s.lambda_pps.toFixed(1)}/s. Little's law
        L = λW holds exactly: {s.lambda_pps.toFixed(1)} × {us(s.system_us)} = {((s.lambda_pps * s.system_us) / 1e6).toFixed(3)}.
      </p>
      {nodal}
    </Card>
  )
}

/** The flow a shaping view follows: the first with a shaper, or the first. */
export const shapedFlow = (p: QueueParams) =>
  Math.max(
    0,
    p.flows.findIndex((f) => f.shaper.kind !== "none"),
  )

/** The burst the output of flow k's shaper should fit: the bucket for a token bucket, one packet for a leaky one. */
export function burstOf(p: QueueParams, k: number) {
  const f = p.flows[k]
  if (f.shaper.kind === "token") return f.shaper.bucket_bytes
  if (f.shaper.kind === "leaky") return f.sizes === "fixed" ? f.size_bytes : null
  return null
}

function ShapingEquations({ p, run }: { p: QueueParams; run: QueueRun }) {
  const k = shapedFlow(p)
  const f = p.flows[k]
  const out = useMemo(() => releases(run, k), [run, k])
  const input = useMemo(
    () =>
      run.packets
        .filter((q) => q.flow === k)
        .map((q): [number, number] => [q.t_arrive, q.size_bytes])
        .sort((a, b) => a[0] - b[0]),
    [run, k],
  )
  const r = f.shaper.kind === "none" ? p.rate_bps : f.shaper.rate_bps
  const tight = useMemo(() => envelopeExcess(out, r), [out, r])
  const need = useMemo(() => envelopeExcess(input, r), [input, r])
  const hold = run.packets.filter((q) => q.flow === k && q.t_shaped !== null && q.dropped === null).map((q) => q.t_shaped! - q.t_arrive)
  const b = burstOf(p, k)
  return (
    <Card title={f.shaper.kind === "none" ? "No shaper on this flow" : f.shaper.kind === "token" ? "Token bucket (r, b)" : "Leaky bucket"}>
      <Tex display>{`A(s, t) \\le b + r\\,(t - s) \\quad \\text{for every interval } [s, t]`}</Tex>
      {f.shaper.kind === "none" ? (
        <p className="font-sans text-sm">Add a shaper to this flow in Setup to see its output held to an arrival curve.</p>
      ) : (
        <>
          <p className="font-sans text-sm">
            r = {bps(r)}, {f.shaper.kind === "token" ? `b = ${b} bytes of tokens` : `b = one packet, ${b ?? "the largest"} bytes`}. The
            smallest b that the shaper's output fits at rate r is <b className="tabular-nums">{Math.ceil(tight)} bytes</b>
            {b !== null && (tight <= b + 1e-9 ? ", within b." : `, more than b.`)} The source itself would need b = {Math.ceil(need)}.
          </p>
          <dl className="grid grid-cols-3 gap-x-3 font-sans text-sm">
            <Row k="held, mean" v={hold.length ? us(hold.reduce((a, x) => a + x, 0) / hold.length) : "–"} />
            <Row k="held, longest" v={hold.length ? us(Math.max(...hold)) : "–"} />
            <Row k="dropped" v={String(run.stats.flows[k].dropped)} bad={run.stats.flows[k].dropped > 0} />
          </dl>
        </>
      )}
    </Card>
  )
}

/** The largest packet in the scenario, and how long the link takes to send it. */
export function lmax(p: QueueParams, run: QueueRun) {
  const L = Math.max(...run.packets.map((q) => q.size_bytes))
  return { L, us: transUs(L, p.rate_bps) }
}

function SchedulingEquations({ p, run }: { p: QueueParams; run: QueueRun }) {
  const sh = useMemo(() => shares(p, run), [p, run])
  const m = lmax(p, run)
  const late = run.packets.filter((q) => q.t_depart !== null).map((q) => q.t_depart! - q.gps_finish)
  const worst = late.length ? Math.max(...late) : 0
  return (
    <Card title={`${DISCIPLINE[p.discipline]}: who goes next`}>
      {p.discipline === "wfq" ? (
        <Tex
          display
        >{`F_i^k = \\max\\bigl(F_i^{k-1},\\, V(a_i^k)\\bigr) + \\frac{L_i^k}{w_i}, \\qquad \\hat F - F_{\\text{GPS}} \\le \\frac{L_{\\max}}{R} = ${texNum(m.us / 1000)}\\ \\text{ms}`}</Tex>
      ) : p.discipline === "priority" ? (
        <Tex display>{`\\text{wait behind less urgent classes} \\le \\frac{L_{\\max}}{R} = ${texNum(m.us / 1000)}\\ \\text{ms}`}</Tex>
      ) : (
        <Tex display>{`\\text{FIFO share}_i \\approx \\frac{\\lambda_i L_i}{\\sum_j \\lambda_j L_j}`}</Tex>
      )}
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left">
              <th className="pr-2 font-normal">flow</th>
              <th className="pr-2 font-normal">{p.discipline === "priority" ? "class" : "weight"}</th>
              <th className="pr-2 font-normal">bytes share</th>
              <th className="pr-2 font-normal">by weight</th>
              <th className="pr-2 font-normal">mean wait</th>
              <th className="font-normal">longest</th>
            </tr>
          </thead>
          <tbody>
            {p.flows.map((f, k) => (
              <tr key={k}>
                <td className="pr-2">
                  <span className="mr-1.5 inline-block size-2.5 rounded-[2px]" style={{ background: FLOW_COLORS[k] }} />
                  {f.name}
                </td>
                <td className="pr-2">{p.discipline === "priority" ? f.priority : f.weight}</td>
                <td className="pr-2">{(100 * sh.share[k]).toFixed(1)}%</td>
                <td className="pr-2">{(100 * sh.fair[k]).toFixed(1)}%</td>
                <td className="pr-2">{us(run.stats.flows[k].wait_us)}</td>
                <td>{us(run.stats.flows[k].max_wait_us)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-sans text-xs text-muted-foreground">
        Shares are of the bytes sent up to {us(sh.until)}, when the first flow sent its last packet; they match the weights only while every
        flow has packets waiting. Latest departure behind GPS in this run: {us(Math.max(0, worst))}
        {p.discipline === "wfq" ? `, within L_max/R = ${us(m.us)}.` : " (the bound is WFQ's, not this discipline's)."}
      </p>
    </Card>
  )
}

/** The chart beside the path for each mode, as series for the screen and the exported figure alike. */
export function modeChart(mode: Mode, p: QueueParams, run: QueueRun, end: number) {
  if (mode === "delay") {
    const occ = occupancy(run)
    const th = isSingleQueue(p) ? theory(p) : null
    const series: Series[] = [
      { id: "n", label: "packets in the system", color: FLOW_COLORS[0], kind: "step", points: occ.map((o) => [o.t, o.n]) },
    ]
    const lTh = th?.l ?? null
    const lRun = run.stats.l
    const wire = p.buffer_pkts ? p.buffer_pkts + 1 : null
    const top = Math.max(2, ...occ.map((o) => o.n), lTh ?? 0, lRun, wire ?? 0) * 1.08
    const refs: { y: number; label: string }[] = []
    // Two reference lines closer than 6% of the axis would print their labels over each other.
    if (lTh != null && Math.abs(lTh - lRun) < 0.06 * top) {
      refs.push({ y: lTh, label: `theory L = ${lTh.toFixed(2)}, measured ${lRun.toFixed(2)}` })
    } else {
      if (lTh != null) refs.push({ y: lTh, label: `theory L = ${lTh.toFixed(2)}` })
      refs.push({ y: lRun, label: `measured L = ${lRun.toFixed(2)}` })
    }
    if (wire != null) {
      const last = refs[refs.length - 1]
      if (Math.abs(last.y - wire) < 0.06 * top) last.label += `; buffer + 1 = ${wire}`
      else refs.push({ y: wire, label: `buffer + 1 on the wire = ${wire}` })
    }
    return {
      title: "Packets in the system (waiting or being sent)",
      yLabel: "packets",
      yFormat: (v: number) => String(Math.round(v)),
      yDomain: [0, top] as [number, number],
      series,
      refs,
    }
  }
  if (mode === "shaping") {
    const k = shapedFlow(p)
    const c = cumulative(run, k)
    const f = p.flows[k]
    const series: Series[] = [
      { id: "in", label: "bytes the source sent", color: FLOW_COLORS[1], kind: "step", points: c.input, dashed: true },
      { id: "out", label: "bytes the shaper released", color: FLOW_COLORS[0], kind: "step", points: c.output },
    ]
    const b = burstOf(p, k)
    if (b !== null && f.shaper.kind !== "none") {
      series.push({
        id: "env",
        label: "ceiling: least over s of out(s) + b + r(t − s)",
        color: FLOW_COLORS[2],
        kind: "line",
        points: bound(releases(run, k), b, f.shaper.rate_bps, end),
      })
    }
    const top = Math.max(1, c.input[c.input.length - 1][1]) * 1.05
    return {
      title: `Flow ${f.name}: what went in and what came out`,
      yLabel: "bytes",
      yFormat: (v: number) =>
        v >= 1e6 ? `${Number((v / 1e6).toPrecision(3))}M` : v >= 1e3 ? `${Number((v / 1e3).toPrecision(3))}k` : String(Math.round(v)),
      yDomain: [0, top] as [number, number],
      series,
      refs: [],
    }
  }
  const series: Series[] = p.flows.map((f, k) => ({
    id: `w${k}`,
    label: f.name,
    color: FLOW_COLORS[k],
    kind: "dots" as const,
    points: run.packets
      .filter((q) => q.flow === k && q.t_start !== null && q.t_join !== null)
      .map((q): [number, number] => [q.t_start!, q.t_start! - q.t_join!]),
  }))
  const top = Math.max(1000, ...series.flatMap((s) => s.points.map((x) => x[1]))) * 1.08
  return {
    title: "Each packet's wait in the queue, by when it started onto the link",
    yLabel: "wait (ms)",
    yFormat: ms,
    yDomain: [0, top] as [number, number],
    series,
    refs: [] as { y: number; label: string }[],
  }
}

/**
 * The bound the shaper's output must stay under: from every earlier release
 * s, what was out before s plus b + r(t − s). Its least value at each t is
 * the curve; between releases it rises at r.
 */
export function bound(rel: [number, number][], b: number, rate_bps: number, end: number): [number, number][] {
  const r = rate_bps / 8e6
  let m = 0 // least of out(s−) − r s over the starts so far
  let out = 0
  const pts: [number, number][] = [[0, b]]
  for (const [s, size] of rel) {
    const before = m + b + r * s
    m = Math.min(m, out - r * s)
    const after = m + b + r * s
    pts.push([s, before])
    if (after !== before) pts.push([s, after])
    out += size
  }
  pts.push([end, m + b + r * end])
  return pts
}

export function chartFigure(c: ReturnType<typeof modeChart>, end: number, caption: string): ChartFigure {
  return {
    xLabel: "time (ms)",
    yLabel: c.yLabel,
    xFormat: ms,
    yFormat: c.yFormat,
    xDomain: [0, end],
    yDomain: c.yDomain,
    series: c.series.map((s) => ({ label: s.label, color: s.color, points: s.points, dashed: s.dashed, step: s.kind === "step" })),
    refs: c.refs,
    caption,
  }
}

/** Reference lines across a chart, labelled at the right. */
export function RefLines({ refs, s }: { refs: { y: number; label: string }[]; s: { sy(y: number): number; left: number; right: number } }) {
  return (
    <g pointerEvents="none">
      {refs.map((r, i) => (
        <g key={i}>
          <line
            x1={s.left}
            x2={s.right}
            y1={s.sy(r.y)}
            y2={s.sy(r.y)}
            stroke="var(--chart-ink)"
            strokeOpacity={0.55}
            strokeDasharray={i === 0 ? "6 4" : "2 3"}
          />
          <text
            x={s.right - 4}
            y={s.sy(r.y) - 4}
            textAnchor="end"
            fontSize="11"
            fill="var(--chart-ink)"
            className="stroke-background"
            strokeWidth={4}
            paintOrder="stroke"
          >
            {r.label}
          </text>
        </g>
      ))}
    </g>
  )
}

/** Each packet's delays, around the current moment; a row picks the packet. */
export const PacketTable = memo(function PacketTable({
  p,
  run,
  t,
  selected,
  onPick,
}: {
  p: QueueParams
  run: QueueRun
  t: number
  selected: number | null
  onPick(q: QPacket): void
}) {
  const arrivals = useMemo(() => run.packets.map((q) => q.t_arrive), [run])
  // Packets are numbered in order of creation, so the last created by t is a binary search away.
  const i = Math.max(0, lastAtOrBefore(arrivals, t))
  const from = Math.max(0, Math.min(i - 12, run.packets.length - 40))
  const rows = run.packets.slice(from, from + 40)
  const shaped = p.flows.some((f) => f.shaper.kind !== "none")
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          Packets {from} to {from + rows.length - 1} of {run.packets.length}, in milliseconds; the table follows the clock.
        </caption>
        <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
          <tr className="text-right">
            <th className="pr-2 text-left font-normal">packet</th>
            <th className="pr-2 font-normal">bytes</th>
            <th className="pr-2 font-normal">created</th>
            {shaped && <th className="pr-2 font-normal">shaper</th>}
            <th className="pr-2 font-normal">proc</th>
            <th className="pr-2 font-normal">queue</th>
            <th className="pr-2 font-normal">L/R</th>
            <th className="pr-2 font-normal">d/s</th>
            <th className="font-normal">total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => {
            const d = delays(p, q)
            const future = q.t_arrive > t
            return (
              <tr
                key={q.id}
                className={cn(
                  "cursor-pointer text-right hover:bg-muted",
                  future && "text-muted-foreground",
                  q.id === selected && "bg-[color-mix(in_oklab,var(--link)_14%,transparent)]",
                )}
                onClick={() => onPick(q)}
              >
                <td className="pr-2 text-left">
                  <button type="button" className="text-left" aria-label={`Show ${packetName(p, q).toLowerCase()}`}>
                    <span className="mr-1.5 inline-block size-2.5 rounded-[2px]" style={{ background: FLOW_COLORS[q.flow] }} />
                    {q.id}
                  </button>
                </td>
                <td className="pr-2">{q.size_bytes}</td>
                <td className="pr-2">{ms(q.t_arrive)}</td>
                {d ? (
                  <>
                    {shaped && <td className="pr-2">{ms(d.shaper)}</td>}
                    <td className="pr-2">{ms(d.processing)}</td>
                    <td className="pr-2">{ms(d.queueing)}</td>
                    <td className="pr-2">{ms(d.transmission)}</td>
                    <td className="pr-2">{ms(d.propagation)}</td>
                    <td>{ms(d.total)}</td>
                  </>
                ) : (
                  <td colSpan={shaped ? 6 : 5} className="text-left text-destructive">
                    dropped{" "}
                    {q.dropped === "buffer"
                      ? "at the full buffer"
                      : q.dropped === "policer"
                        ? "by the policer"
                        : "by the full leaky bucket"}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

const RHOS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9]

/** Mean time in the system against load, simulated with long runs, beside both formulas. */
export function SweepPanel({ sim, p }: { sim: Netsim; p: QueueParams }) {
  const [packets, setPackets] = useState(20_000)
  const f = p.flows[0]
  const sweep = useMemo(() => {
    const at = (sizes: QFlow["sizes"]) => {
      const base = { ...p, flows: [{ ...f, sizes }] }
      try {
        return sweepQueue(sim, base, RHOS, packets)
      } catch {
        return null
      }
    }
    return { exp: at("exp"), fixed: at("fixed") }
  }, [sim, p, f, packets])
  const s = 1e6 / (p.rate_bps / (8 * f.size_bytes))
  const grid = Array.from({ length: 91 }, (_, i) => i / 100)
  const curve = (k: number): [number, number][] => grid.map((r) => [r, (1 + (k * r) / (1 - r)) * s])
  const dots = (pts: SweepPoint[] | null): [number, number][] => (pts ?? []).map((x) => [x.rho, x.system_us])
  const series: Series[] = [
    { id: "mm1", label: "M/M/1: W = 1/(μ − λ)", color: FLOW_COLORS[0], kind: "line", points: curve(1) },
    { id: "md1", label: "M/D/1: W = 1/μ + ρ/(2μ(1 − ρ))", color: FLOW_COLORS[1], kind: "line", points: curve(0.5) },
    { id: "mm1s", label: "simulated, exponential sizes", color: FLOW_COLORS[0], kind: "dots", points: dots(sweep.exp) },
    { id: "md1s", label: "simulated, fixed sizes", color: FLOW_COLORS[1], kind: "dots", points: dots(sweep.fixed) },
  ]
  return (
    <div className="space-y-3">
      <p className="font-sans text-xs text-muted-foreground">
        One Poisson flow of {f.size_bytes}-byte packets (mean) on {bps(p.rate_bps)}, so 1/μ = {us(s)}. Each dot is a run of{" "}
        {packets.toLocaleString("en")} packets at that load, without a trace; the lines are the formulas.
      </p>
      <LineChart
        title="Mean time in the system against load"
        series={series}
        xLabel="load ρ = λ/μ"
        yLabel="W (ms)"
        xFormat={(v) => v.toFixed(1)}
        yFormat={ms}
        xDomain={[0, 0.92]}
        yDomain={[0, Math.max(11 * s, ...series.slice(2).flatMap((x) => x.points.map((pt) => pt[1] * 1.05)))]}
        height={240}
      />
      <ParamSlider
        label="Packets per run"
        value={packets}
        min={1000}
        max={100_000}
        log
        format={(v) => v.toLocaleString("en")}
        onChange={setPackets}
      />
      <p className="font-sans text-xs text-muted-foreground">
        Near ρ = 0.9 the dots scatter more: successive waits are strongly correlated there, so a run of a given length tells you less. The
        relative spread of the mean shrinks only as the square root of the run's length.
      </p>
    </div>
  )
}

/** Tokens in flow k's bucket over time, from the model's token-bucket steps. */
export function tokenSeries(p: QueueParams, run: QueueRun, k: number, end: number): [number, number][] {
  const s = p.flows[k].shaper
  const r = s.rate_bps / 8e6
  let level = s.bucket_bytes
  let at = 0
  const pts: [number, number][] = [[0, level]]
  const rise = (to: number) => {
    const full = at + (s.bucket_bytes - level) / r
    if (full < to) pts.push([full, s.bucket_bytes], [to, s.bucket_bytes])
    else pts.push([to, level + r * (to - at)])
  }
  for (const e of run.events) {
    if (e.step !== "B1" || e.tokens === null || run.packets[e.packet].flow !== k) continue
    rise(e.t)
    pts.push([e.t, e.tokens])
    level = e.tokens
    at = e.t
  }
  rise(end)
  return pts
}

export function ShaperPanel({
  p,
  run,
  end,
  cursor,
  onSeek,
}: {
  p: QueueParams
  run: QueueRun
  end: number
  cursor: number
  onSeek(t: number): void
}) {
  const k = shapedFlow(p)
  const f = p.flows[k]
  const tokens = useMemo(() => (f.shaper.kind === "token" ? tokenSeries(p, run, k, end) : null), [p, run, k, end, f.shaper.kind])
  const held = useMemo(() => {
    const ch: [number, number][] = []
    for (const q of run.packets)
      if (q.flow === k && q.dropped === null && q.t_shaped !== null && q.t_shaped > q.t_arrive) ch.push([q.t_arrive, 1], [q.t_shaped, -1])
    ch.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const pts: [number, number][] = [[0, 0]]
    let n = 0
    for (const [t, d] of ch) pts.push([t, (n += d)])
    return pts
  }, [run, k])
  if (f.shaper.kind === "none")
    return <p className="font-sans text-sm text-muted-foreground">No flow has a shaper. Give one a token or leaky bucket in Setup.</p>
  return (
    <div className="space-y-4">
      {tokens && (
        <LineChart
          title={`Tokens in flow ${f.name}'s bucket`}
          series={[{ id: "tok", label: "tokens (bytes)", color: FLOW_COLORS[0], kind: "line", points: tokens }]}
          xLabel="time (ms)"
          yLabel="bytes"
          xFormat={ms}
          yFormat={(v) => String(Math.round(v))}
          xDomain={[0, end]}
          yDomain={[0, f.shaper.bucket_bytes * 1.08]}
          height={180}
          cursor={cursor}
          onSeek={onSeek}
        />
      )}
      <LineChart
        title={`Packets held in flow ${f.name}'s shaper`}
        series={[{ id: "held", label: "held", color: FLOW_COLORS[1], kind: "step", points: held }]}
        xLabel="time (ms)"
        yLabel="packets"
        xFormat={ms}
        yFormat={(v) => String(Math.round(v))}
        xDomain={[0, end]}
        height={160}
        cursor={cursor}
        onSeek={onSeek}
      />
      <p className="font-sans text-xs text-muted-foreground">
        {f.shaper.kind === "token"
          ? f.shaper.police
            ? "A policer never holds a packet: one that finds too few tokens is dropped, and the bucket keeps its tokens."
            : "The bucket starts full. A packet that finds enough tokens spends them and goes; otherwise it waits in line until the tokens for its whole length have arrived."
          : "The leaky bucket holds bytes, not tokens, and lets them out at exactly r; it is a queue with a fixed-rate server and a size limit."}
      </p>
    </div>
  )
}

export function SchedulerPanel({
  p,
  run,
  end,
  cursor,
  onSeek,
}: {
  p: QueueParams
  run: QueueRun
  end: number
  cursor: number
  onSeek(t: number): void
}) {
  const m = lmax(p, run)
  const late: Series[] = useMemo(
    () =>
      p.flows.map((f, k) => ({
        id: `l${k}`,
        label: f.name,
        color: FLOW_COLORS[k],
        kind: "dots" as const,
        points: run.packets
          .filter((q) => q.flow === k && q.t_depart !== null)
          .map((q): [number, number] => [q.t_depart!, q.t_depart! - q.gps_finish]),
      })),
    [p, run],
  )
  const served: Series[] = useMemo(() => {
    const curves = (key: (q: QPacket) => number | null) =>
      p.flows.map((_, k) => {
        const pts = run.packets
          .filter((q) => q.flow === k && key(q) !== null)
          .map((q): [number, number] => [key(q)!, q.size_bytes])
          .sort((a, b) => a[0] - b[0])
        const out: [number, number][] = [[0, 0]]
        let sum = 0
        for (const [t, b] of pts) out.push([t, (sum += b)])
        return out
      })
    const real = curves((q) => q.t_depart)
    const gps = curves((q) => (q.dropped ? null : q.gps_finish))
    return p.flows.flatMap((f, k) => [
      { id: `r${k}`, label: `${f.name}, sent`, color: FLOW_COLORS[k], kind: "step" as const, points: real[k] },
      { id: `g${k}`, label: `${f.name}, under GPS`, color: FLOW_COLORS[k], kind: "step" as const, points: gps[k], dashed: true },
    ])
  }, [p, run])
  const ys = late.flatMap((s) => s.points.map((x) => x[1]))
  const lo = Math.min(-m.us, ...ys) * 1.08
  const hi = Math.max(m.us, ...ys) * 1.08
  return (
    <div className="space-y-4">
      <LineChart
        title="Each packet's departure minus its GPS finish"
        series={late}
        xLabel="departure (ms)"
        yLabel="behind GPS (ms)"
        xFormat={ms}
        yFormat={ms}
        xDomain={[0, end]}
        yDomain={[lo, hi]}
        height={200}
        cursor={cursor}
        onSeek={onSeek}
        overlay={(s) => (
          <RefLines
            s={s}
            refs={[
              { y: m.us, label: `L_max/R = ${us(m.us)}` },
              { y: 0, label: "on time" },
            ]}
          />
        )}
      />
      <LineChart
        title="Bytes sent by each flow, and what GPS would have sent"
        series={served}
        xLabel="time (ms)"
        yLabel="bytes"
        xFormat={ms}
        yFormat={(v) => (v >= 1e3 ? `${Number((v / 1e3).toPrecision(3))}k` : String(Math.round(v)))}
        xDomain={[0, end]}
        height={220}
        cursor={cursor}
        onSeek={onSeek}
      />
      <p className="font-sans text-xs text-muted-foreground">
        The model runs the fluid GPS system beside every discipline. Under WFQ no dot rises above L_max/R (Parekh and Gallager); under FIFO
        and priority nothing keeps them there. Dots below zero are packets that left earlier than GPS would have finished them, which WFQ
        allows: it never idles while packets wait.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- Setup

function Radios<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string
  name: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange(v: T): void
}) {
  return (
    <fieldset className="space-y-1.5 font-sans text-sm">
      <legend className="mb-1 text-xs text-muted-foreground">{legend}</legend>
      {options.map(([v, text]) => (
        <label key={v} className="flex items-start gap-2">
          <input type="radio" name={name} className="mt-1" checked={value === v} onChange={() => onChange(v)} />
          <span>{text}</span>
        </label>
      ))}
    </fieldset>
  )
}

const NAMES = ["a", "b", "c", "d"]

export function QueueSetup({ p, set }: { p: QueueParams; set(p: QueueParams): void }) {
  const total = p.flows.reduce((a, f) => a + f.packets, 0)
  const setFlow = (i: number, change: Partial<QFlow>) => set({ ...p, flows: p.flows.map((f, j) => (j === i ? { ...f, ...change } : f)) })
  return (
    <div className="space-y-5">
      <Radios
        legend="Which waiting packet the link sends next"
        name="queue-discipline"
        value={p.discipline}
        options={[
          ["fifo", "FIFO: the one that joined first"],
          [
            "priority",
            "Strict priority: the most urgent class (smallest number), FIFO within it; a packet on the wire is never interrupted",
          ],
          ["wfq", "Weighted fair queueing: the smallest GPS finish tag, so bytes are shared in proportion to weight"],
        ]}
        onChange={(v) => set({ ...p, discipline: v })}
      />
      <fieldset className="space-y-4 rounded-sm border border-border p-3">
        <legend className="px-1 font-sans text-xs text-muted-foreground">The router and the link</legend>
        <ParamSlider
          label="Link rate R"
          value={p.rate_bps}
          min={100_000}
          max={1e9}
          log
          format={bps}
          onChange={(v) => set({ ...p, rate_bps: v })}
        />
        <ParamSlider
          label="Processing time"
          value={p.proc_us}
          min={0}
          max={2000}
          step={10}
          format={us}
          onChange={(v) => set({ ...p, proc_us: v })}
        />
        <ParamSlider
          label="Link length d"
          value={Math.max(1, p.distance_m)}
          min={1}
          max={40_000_000}
          log
          format={(v) => (p.distance_m === 0 ? "0 km" : v >= 1000 ? `${Number((v / 1000).toPrecision(3))} km` : `${v} m`)}
          onChange={(v) => set({ ...p, distance_m: v <= 1 ? 0 : v })}
        />
        <ParamSlider
          label="Signal speed s"
          value={p.speed_mps / 1e8}
          min={1}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)} × 10⁸ m/s`}
          onChange={(v) => set({ ...p, speed_mps: Math.round(v * 1e8) })}
        />
        <ParamSlider
          label="Buffer (packets that may wait)"
          value={p.buffer_pkts}
          min={0}
          max={500}
          step={1}
          format={(v) => (v === 0 ? "no limit" : String(v))}
          onChange={(v) => set({ ...p, buffer_pkts: v })}
        />
        <ParamSlider label="Random seed" value={p.seed} min={1} max={50} step={1} onChange={(v) => set({ ...p, seed: v })} />
        <p className="font-sans text-xs text-muted-foreground">
          L/R for a {p.flows[0].size_bytes}-byte packet: {us(transUs(p.flows[0].size_bytes, p.rate_bps))}; d/s: {us(propUs(p))}.
        </p>
      </fieldset>
      {p.flows.map((f, i) => (
        <fieldset key={i} className="space-y-4 rounded-sm border border-border p-3">
          <legend className="flex items-center gap-2 px-1 font-sans text-xs text-muted-foreground">
            <span className="inline-block size-2.5 rounded-[2px]" style={{ background: FLOW_COLORS[i] }} />
            Flow {f.name}
          </legend>
          <Radios
            legend="Arrivals"
            name={`queue-arrivals-${i}`}
            value={f.arrivals}
            options={[
              ["poisson", "Poisson: independent random gaps"],
              ["periodic", "Periodic: evenly spaced"],
              ["onoff", "On-off: evenly spaced bursts, then silence"],
            ]}
            onChange={(v) => setFlow(i, { arrivals: v })}
          />
          <ParamSlider
            label={f.arrivals === "onoff" ? "Rate within a burst" : f.arrivals === "poisson" ? "Mean rate λ" : "Rate"}
            value={f.rate_pps}
            min={1}
            max={100_000}
            log
            format={(v) => `${Number(v.toPrecision(4))} packets/s (${bps(v * 8 * f.size_bytes)})`}
            onChange={(v) => setFlow(i, { rate_pps: v })}
          />
          {f.arrivals === "onoff" && (
            <>
              <ParamSlider
                label="On for"
                value={f.on_us}
                min={1000}
                max={1_000_000}
                log
                format={us}
                onChange={(v) => setFlow(i, { on_us: v })}
              />
              <ParamSlider
                label="Off for"
                value={f.off_us}
                min={1000}
                max={1_000_000}
                log
                format={us}
                onChange={(v) => setFlow(i, { off_us: v })}
              />
            </>
          )}
          <ParamSlider
            label={f.sizes === "exp" ? "Mean packet size" : "Packet size"}
            value={f.size_bytes}
            min={40}
            max={9000}
            log
            format={(v) => `${v} bytes`}
            onChange={(v) => setFlow(i, { size_bytes: v })}
          />
          <ParamSwitch
            label="Packet sizes"
            name="Exponential packet sizes"
            checked={f.sizes === "exp"}
            onChange={(v) => setFlow(i, { sizes: v ? "exp" : "fixed" })}
            on="Exponential, as M/M/1 assumes"
            off="All the same, as M/D/1 assumes"
          />
          <ParamSlider
            label="Packets"
            value={f.packets}
            min={1}
            max={Math.min(3000, 6000 - (total - f.packets))}
            step={1}
            onChange={(v) => setFlow(i, { packets: v })}
          />
          {p.flows.length > 1 && (
            <ParamSlider
              label="Starts at"
              value={f.start_us}
              min={0}
              max={1_000_000}
              step={1000}
              format={us}
              onChange={(v) => setFlow(i, { start_us: v })}
            />
          )}
          {p.discipline === "wfq" && (
            <ParamSlider label="Weight w" value={f.weight} min={1} max={100} step={1} onChange={(v) => setFlow(i, { weight: v })} />
          )}
          {p.discipline === "priority" && (
            <ParamSlider
              label="Priority class (0 is most urgent)"
              value={f.priority}
              min={0}
              max={7}
              step={1}
              onChange={(v) => setFlow(i, { priority: v })}
            />
          )}
          <Radios
            legend="Shaper at the source"
            name={`queue-shaper-${i}`}
            value={f.shaper.kind}
            options={[
              ["none", "None"],
              ["token", "Token bucket: bursts up to b, then rate r (fixed sizes only)"],
              ["leaky", "Leaky bucket: a queue of up to b bytes drained at exactly r"],
            ]}
            onChange={(v) =>
              setFlow(i, {
                shaper: { ...f.shaper, kind: v, bucket_bytes: Math.max(f.shaper.bucket_bytes, v === "token" ? f.size_bytes : 0) },
              })
            }
          />
          {f.shaper.kind !== "none" && (
            <>
              <ParamSlider
                label="Shaper rate r"
                value={f.shaper.rate_bps}
                min={10_000}
                max={1e9}
                log
                format={bps}
                onChange={(v) => setFlow(i, { shaper: { ...f.shaper, rate_bps: v } })}
              />
              <ParamSlider
                label={f.shaper.kind === "token" ? "Bucket b (bytes of tokens)" : "Bucket (bytes it may hold)"}
                value={f.shaper.bucket_bytes}
                min={f.shaper.kind === "token" ? f.size_bytes : 100}
                max={1_000_000}
                log
                format={(v) => `${v} bytes`}
                onChange={(v) => setFlow(i, { shaper: { ...f.shaper, bucket_bytes: v } })}
              />
              {f.shaper.kind === "token" && (
                <ParamSwitch
                  label="When tokens run short"
                  name="Police instead of shape"
                  checked={f.shaper.police}
                  onChange={(v) => setFlow(i, { shaper: { ...f.shaper, police: v } })}
                  on="Police: drop the packet"
                  off="Shape: hold the packet until its tokens arrive"
                />
              )}
            </>
          )}
          {p.flows.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => set({ ...p, flows: p.flows.filter((_, j) => j !== i) })}>
              Remove flow {f.name}
            </Button>
          )}
        </fieldset>
      ))}
      {p.flows.length < 4 && (
        <Button
          size="sm"
          variant="outline"
          disabled={total >= 6000}
          onClick={() => {
            const name = NAMES.find((n) => !p.flows.some((f) => f.name === n)) ?? `f${p.flows.length}`
            set({ ...p, flows: [...p.flows, flow(name, { packets: Math.min(200, 6000 - total), priority: 1 })] })
          }}
        >
          Add a flow
        </Button>
      )}
    </div>
  )
}
