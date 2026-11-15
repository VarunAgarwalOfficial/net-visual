import { memo, useId, type ReactNode } from "react"

import { ParamSlider, ParamSwitch } from "../../components/Controls"
import type { ChartFigure } from "../../components/figure"
import type { Series } from "../../components/LineChart"
import { Tex, texNum } from "../../components/Tex"
import type { Netsim } from "../../core/netsim"
import {
  ACK_BYTES,
  ALOHA_SWEEP,
  CD_SWEEP,
  CTS_BYTES,
  DATA_HEADER,
  SWEEP_BYTES,
  SWEEP_GS,
  airUs,
  alohaExact,
  alohaLimit,
  alohaPeak,
  bebMax,
  bps,
  cdApprox,
  fmtTime,
  frameNs,
  metcalfeBoggs,
  minFrameBytes,
  navFields,
  sweepAloha,
  sweepCd,
  tauNs,
  type AlohaEvent,
  type AlohaParams,
  type AlohaPoint,
  type AlohaRun,
  type CaEvent,
  type CaParams,
  type CaRun,
  type CdEvent,
  type CdParams,
  type CdPoint,
  type CdRun,
  type LinkParams,
  type LinkRun,
} from "../../core/link"
import { cn } from "@/lib/utils"
import { KIND_LABEL, stationName } from "./linkFigures"
import { CSS, type Shape, type ShapeFigure } from "./shapes"

// --- The picture -----------------------------------------------------------

/** Draws a shape figure in the page's theme colours. */
export function ShapeView({ fig, label }: { fig: ShapeFigure; label: string }) {
  const id = useId().replace(/:/g, "")
  return (
    <svg viewBox={`0 0 ${fig.w} ${fig.h}`} width="100%" role="img" aria-label={label} className="block font-sans select-none">
      <defs>
        <marker id={`${id}-a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {fig.shapes.map((s, i) => (
        <ShapeEl key={i} s={s} arrow={`url(#${id}-a)`} />
      ))}
    </svg>
  )
}

function ShapeEl({ s, arrow }: { s: Shape; arrow: string }) {
  const paint = (o: { fill?: keyof typeof CSS; stroke?: keyof typeof CSS; opacity?: number; dashed?: boolean }) => ({
    fill: o.fill ? CSS[o.fill] : "none",
    fillOpacity: o.opacity,
    stroke: o.stroke ? CSS[o.stroke] : "none",
    strokeDasharray: o.dashed ? "3 3" : undefined,
  })
  switch (s.kind) {
    case "rect":
      return <rect x={s.x} y={s.y} width={Math.max(0, s.w)} height={Math.max(0, s.h)} {...paint(s)} />
    case "poly":
      return <polygon points={s.points.map(([x, y]) => `${x},${y}`).join(" ")} {...paint(s)} />
    case "circle":
      return <circle cx={s.cx} cy={s.cy} r={s.r} {...paint(s)} />
    case "line":
      return (
        <line
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={CSS[s.stroke]}
          strokeWidth={s.width ?? 1.2}
          strokeDasharray={s.dashed ? "3 3" : undefined}
          markerEnd={s.arrow ? arrow : undefined}
        />
      )
    case "text":
      return (
        <text
          x={s.x}
          y={s.y}
          textAnchor={s.anchor}
          fontSize={s.size}
          fill={CSS[s.fill]}
          fontWeight={s.bold ? 600 : undefined}
          className="stroke-background lining"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {s.text}
        </text>
      )
  }
}

// --- Words for each event --------------------------------------------------

export function eventText(p: LinkParams, r: LinkRun, i: number): string {
  if (p.mode === "aloha" && r.mode === "aloha") return alohaText(p.aloha, r.run, r.run.events[i])
  if (p.mode === "csmacd" && r.mode === "csmacd") return cdText(p.cd, r.run, r.run.events[i])
  if (p.mode === "csmaca" && r.mode === "csmaca") return caText(p.ca, r.run, r.run.events[i])
  return ""
}

/** Who an event is about, for the line above it. */
export function eventWho(p: LinkParams, r: LinkRun, i: number): string {
  if (p.mode === "aloha" && r.mode === "aloha") {
    const f = r.run.frames[r.run.events[i].frame]
    return `station ${stationName(f.station)}, frame #${f.id}`
  }
  if (p.mode === "csmacd" && r.mode === "csmacd") return `station ${p.cd.stations[r.run.events[i].station].name}`
  if (p.mode === "csmaca" && r.mode === "csmaca") return `node ${p.ca.nodes[r.run.events[i].node].name}`
  return ""
}

function alohaText(p: AlohaParams, run: AlohaRun, e: AlohaEvent): string {
  const f = run.frames[e.frame]
  const who = stationName(f.station)
  const other = f.hit !== null ? `#${f.hit}` : "another frame"
  switch (e.what) {
    case "clear":
      return p.slotted
        ? `${who} sends frame #${f.id} at the start of a slot, without listening. No one else has chosen this slot so far.`
        : `${who} sends frame #${f.id} the moment it has it, without listening. Nothing else is on the air yet.`
    case "collides":
      return p.slotted
        ? `${who} sends frame #${f.id} in the same slot as ${other}: the two arrive on top of each other and both are lost.`
        : `${who} sends frame #${f.id} while ${other} is still on the air: the two overlap and both are lost.`
    case "delivered":
      return `Frame #${f.id} ends without any other frame having overlapped it: the receiver decodes it.`
    case "garbled":
      return `Frame #${f.id} ends. It overlapped ${other}, so the receiver could decode neither; ${who} will have to send it again.`
  }
}

function cdText(p: CdParams, run: CdRun, e: CdEvent): string {
  const s = p.stations[e.station].name
  const tx = e.tx !== null ? run.txs[e.tx] : null
  const st = run.stats
  switch (e.step) {
    case "E1":
      return e.what === "idle"
        ? `${s} has a frame and hears silence on the cable. It waits out the interframe gap, ${fmtTime(st.ifg_ns, "csmacd")}, before sending.`
        : `${s} hears another signal passing its tap and defers. It will try again the moment the cable falls quiet.`
    case "E2":
      return `${s} starts frame ${tx!.frame + 1}${tx!.attempt > 1 ? `, attempt ${tx!.attempt}` : ""}: ${p.frame_bytes} bytes, ${fmtTime(st.frame_ns, "csmacd")} on the wire, listening all the while.`
    case "E3":
      return `${s} hears another signal while sending, ${fmtTime(e.t - tx!.start_ns, "csmacd")} after it began: a collision. It stops the frame and sends ${p.jam_bits} bits of jam (${fmtTime(st.jam_ns, "csmacd")}) so every station notices.`
    case "E4":
      if (tx!.outcome === "delivered") return `${s} finishes frame ${tx!.frame + 1} without hearing anyone else: it got through.`
      if (tx!.outcome === "undetected")
        return `${s} finishes frame ${tx!.frame + 1} without having heard anything, so it counts the frame as sent. But the frame was garbled where another station's signal overlapped it, and nothing at this layer will resend it.`
      return `${s} stops jamming.`
    case "E5": {
      const b = run.backoffs.find((x) => x.station === e.station && x.t_ns === e.t)
      if (!b) return `${s} backs off.`
      return `After the frame's collision number ${b.collisions}, ${s} picks K uniformly from {0, …, ${b.max}} and draws K = ${b.k}: it waits ${b.k} × ${fmtTime(st.slot_ns, "csmacd")} = ${fmtTime(b.k * st.slot_ns, "csmacd")} before sensing again.`
    }
    case "E6":
      return `${s} has collided ${p.attempt_limit} times on this frame and gives up on it; the layer above must deal with the loss.`
  }
  return ""
}

function caText(p: CaParams, run: CaRun, e: CaEvent): string {
  const x = p.nodes[e.node].name
  const a = e.air !== null ? run.airs[e.air] : null
  const name = (i: number) => p.nodes[i].name
  switch (e.step) {
    case "W2":
      return e.what === "freeze"
        ? `${x} hears the medium busy and freezes its backoff with ${e.backoff} slots left; it keeps them for later.`
        : `${x} will count down its ${e.backoff} slots (${e.backoff * p.slot_us} µs) once the medium has been idle for a DIFS, ${run.stats.difs_us} µs.`
    case "W3":
      return `${x}'s counter reaches zero: it sends ${KIND_LABEL[a!.kind]} to ${name(a!.to)}, ${a!.end_us - a!.start_us} µs on the air${a!.nav_us ? `, with a duration field of ${a!.nav_us} µs` : ""}.`
    case "W4":
      if (e.what === "nav")
        return `${x} hears ${name(a!.from)}'s ${KIND_LABEL[a!.kind]}, meant for ${name(a!.to)}, and sets its NAV for ${a!.nav_us} µs: it will treat the medium as busy until then, whatever it hears.`
      if (e.what === "decoded") return `${name(a!.from)}'s ${KIND_LABEL[a!.kind]} reaches ${name(a!.to)} intact.`
      if (e.what === "lost")
        return `${name(a!.from)}'s ${KIND_LABEL[a!.kind]} is garbled at ${name(a!.to)}: another frame overlapped it there. ${name(a!.from)} cannot tell while sending; it will notice only when no answer comes.`
      if (e.what === "cts")
        return `${x} answers with a CTS a SIFS (${p.sifs_us} µs) later. Its duration field, ${a!.nav_us} µs, reaches every node in ${x}'s range.`
      return `${x} acknowledges with an ACK a SIFS (${p.sifs_us} µs) later.`
    case "W5":
      return `${x} has its CTS: it sends the data frame a SIFS later, ${a!.end_us - a!.start_us} µs on the air.`
    case "W6":
      return e.what === "drop"
        ? `No answer again: ${x} has tried ${p.attempt_limit} times and drops the frame.`
        : `No answer came back in time: ${x} doubles its window to ${e.cw} and draws a new backoff of ${e.backoff} slots.`
    case "W7":
      return `${x} receives its ACK: the frame is delivered. Its window goes back to ${p.cw_min}.`
  }
  return ""
}

// --- Totals ----------------------------------------------------------------

const Row = ({ k, v, bad }: { k: string; v: string; bad?: boolean }) => (
  <div>
    <dt className="text-xs text-muted-foreground">{k}</dt>
    <dd className={cn("tabular-nums lining", bad && "text-destructive")}>{v}</dd>
  </div>
)

const pct = (x: number) => `${(100 * x).toFixed(1)}%`

export const Totals = memo(function Totals({ p, r }: { p: LinkParams; r: LinkRun }) {
  let rows: ReactNode = null
  if (p.mode === "aloha" && r.mode === "aloha") {
    const s = r.run.stats
    rows = (
      <>
        <Row k="frames sent" v={`${s.attempts} in ${p.aloha.length} frame times`} />
        <Row k="delivered" v={`${s.delivered}`} />
        <Row k="lost to overlap" v={`${s.attempts - s.delivered}`} bad={s.attempts > s.delivered} />
        <Row k="offered load G" v={s.g.toFixed(3)} />
        <Row k="throughput S" v={s.s.toFixed(3)} />
        <Row k="S from the formula" v={s.theory.toFixed(3)} />
      </>
    )
  } else if (p.mode === "csmacd" && r.mode === "csmacd") {
    const s = r.run.stats
    rows = (
      <>
        <Row k="delivered" v={`${s.delivered}`} />
        <Row k="collisions" v={`${s.collided}`} bad={s.collided > 0} />
        <Row k="unnoticed collisions" v={s.undetected ? `${s.undetected}` : "none"} bad={s.undetected > 0} />
        <Row k="frames dropped after 16 tries" v={s.aborted ? `${s.aborted}` : "none"} bad={s.aborted > 0} />
        <Row k="cable carrying good frames" v={pct(s.efficiency)} />
        <Row k="a = τ / frame time" v={s.a.toFixed(3)} />
      </>
    )
  } else if (p.mode === "csmaca" && r.mode === "csmaca") {
    const s = r.run.stats
    const name = (i: number) => p.ca.nodes[i].name
    rows = (
      <>
        <Row k="delivered" v={s.flows.map((f) => f.delivered).join(" + ")} />
        <Row k="data frames lost" v={pct(s.data_loss)} bad={s.data_loss > 0.05} />
        <Row k="RTS frames lost" v={p.ca.rts ? pct(s.rts_loss) : "no RTS"} />
        <Row k="throughput" v={s.flows.map((f) => bps(f.throughput_bps)).join(" + ")} />
        <Row k="dropped after 7 tries" v={`${s.flows.reduce((a, f) => a + f.dropped, 0)}`} />
        <Row
          k="needless deferral"
          v={s.flows.map((f, i) => `${name(p.ca.flows[i].from)} ${pct(f.needless_us / p.ca.duration_us)}`).join(", ")}
          bad={s.flows.some((f) => f.needless_us > 0.05 * p.ca.duration_us)}
        />
      </>
    )
  }
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">{rows}</dl>
})

// --- Equations -------------------------------------------------------------

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-border p-3">
      <p className="font-sans text-xs text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

const n3 = (x: number) => texNum(x, 3)
const usT = (ns: number) => texNum(ns / 1000, 2)

/** The formulas behind the mode, with this run's numbers in them, updated with the clock. */
export function EquationCard({ p, r, t }: { p: LinkParams; r: LinkRun; t: number }) {
  if (p.mode === "aloha" && r.mode === "aloha") return <AlohaEquations p={p.aloha} run={r.run} t={t} />
  if (p.mode === "csmacd" && r.mode === "csmacd") return <CdEquations p={p.cd} run={r.run} t={t} />
  if (p.mode === "csmaca" && r.mode === "csmaca") return <CaEquations p={p.ca} run={r.run} t={t} />
  return null
}

function AlohaEquations({ p, run, t }: { p: AlohaParams; run: AlohaRun; t: number }) {
  const { g, stations: n, slotted } = p
  const q = g / n
  const peak = alohaPeak(slotted, n)
  const done = run.frames.filter((f) => f.end_us <= t && f.end_us > 0)
  const ok = done.filter((f) => f.ok).length
  const elapsed = t / p.frame_us
  return (
    <Card
      title={
        slotted
          ? "Slotted ALOHA: a frame survives if no one else picks its slot"
          : "Pure ALOHA: a frame survives if no one else starts within a frame time either side"
      }
    >
      <Tex display>
        {slotted
          ? `S_\\infty = G e^{-G} = ${n3(g)}\\, e^{-${n3(g)}} = ${n3(alohaLimit(true, g))}`
          : `S_\\infty = G e^{-2G} = ${n3(g)}\\, e^{-${n3(2 * g)}} = ${n3(alohaLimit(false, g))}`}
      </Tex>
      <Tex display>
        {slotted
          ? `S_{${n}} = G\\left(1 - \\tfrac{G}{n}\\right)^{n-1} = ${n3(g)}\\,(${n3(1 - q)})^{${n - 1}} = ${n3(alohaExact(true, n, g))}`
          : `S_{${n}} = G\\left[(1-q)\\,e^{-q/(1-q)}\\right]^{n-1},\\ q = \\tfrac{G}{n} = ${n3(q)}:\\ S_{${n}} = ${n3(alohaExact(false, n, g))}`}
      </Tex>
      <Tex
        display
      >{`S_{\\text{so far}} = \\frac{\\text{delivered}}{\\text{frame times}} = \\frac{${ok}}{${texNum(elapsed, 1)}} = ${elapsed > 0 ? n3(ok / elapsed) : "\\text{–}"}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        With {n} stations S peaks at {peak.s.toFixed(3)} when G = {peak.g.toFixed(3)}; with very many, at{" "}
        {slotted ? "1/e ≈ 0.368 when G = 1" : "1/(2e) ≈ 0.184 when G = 0.5"}. The exact form counts only the other n − 1 stations, each
        silent while it sends its own frame.
      </p>
    </Card>
  )
}

function CdEquations({ p, run, t }: { p: CdParams; run: CdRun; t: number }) {
  const s = run.stats
  const L = Math.max(...p.stations.map((x) => x.pos_m)) - Math.min(...p.stations.map((x) => x.pos_m))
  const need = minFrameBytes(p)
  const b = run.backoffs.filter((x) => x.t_ns <= t).pop()
  const d = run.txs.filter((x) => x.detect_ns !== null && x.detect_ns <= t).pop()
  const saturated = p.stations.every((x) => x.frames === 0)
  return (
    <Card title="CSMA/CD: listen before, listen during, back off after">
      <Tex
        display
      >{`\\tau = \\frac{d}{v} = \\frac{${L}\\ \\text{m}}{${texNum(p.speed_mps)}\\ \\text{m/s}} = ${usT(s.tau_ns)}\\ \\mu\\text{s},\\quad a = \\frac{\\tau}{L/R} = \\frac{${usT(s.tau_ns)}}{${usT(s.frame_ns)}} = ${n3(s.a)}`}</Tex>
      <Tex
        display
      >{`\\frac{L}{R} \\ge 2\\tau \\iff L \\ge \\frac{2\\tau R}{8} = ${need}\\ \\text{bytes}:\\quad ${p.frame_bytes} ${p.frame_bytes >= need ? "\\ge" : "<"} ${need}\\ ${p.frame_bytes >= need ? "\\checkmark" : "\\times"}`}</Tex>
      {d && (
        <Tex
          display
        >{`t_{\\text{detect}} - t_{\\text{start}} = ${usT(d.detect_ns! - d.start_ns)}\\ \\mu\\text{s} \\le 2\\tau = ${usT(2 * s.tau_ns)}\\ \\mu\\text{s}`}</Tex>
      )}
      {b && (
        <Tex
          display
        >{`n = ${b.collisions}:\\ K \\in \\{0,\\dots,2^{\\min(n,10)}-1\\} = \\{0,\\dots,${b.max}\\},\\ K = ${b.k} \\Rightarrow ${b.k} \\times ${usT(s.slot_ns)} = ${usT(b.k * s.slot_ns)}\\ \\mu\\text{s}`}</Tex>
      )}
      <Tex
        display
      >{`E \\approx \\frac{1}{1 + 5a} = ${n3(cdApprox(s.a))}${saturated ? `,\\quad E_{\\text{this run}} = ${n3(s.efficiency)}` : ""}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        A slot is {p.slot_bits} bit times ({fmtTime(s.slot_ns, "csmacd")}); a frame is dropped after {p.attempt_limit} attempts.
        {saturated
          ? " The simulation beats 1/(1 + 5a): the station that just won starts afresh with K from {0, 1} while the losers' ranges have grown, so it tends to win again (capture), and fewer slots are wasted than the approximation assumes."
          : " The efficiency formula describes busy stations that always have a frame; the CSMA/CD tab compares it with simulations."}
      </p>
    </Card>
  )
}

function CaEquations({ p, run, t }: { p: CaParams; run: CaRun; t: number }) {
  const st = run.stats
  const f = navFields(p)
  const cts = airUs(p, CTS_BYTES)
  const ack = airUs(p, ACK_BYTES)
  const data = airUs(p, p.payload_bytes + DATA_HEADER)
  const sent = run.airs.filter((a) => a.kind === "data" && a.end_us <= t)
  const lost = sent.filter((a) => !a.ok).length
  const cws: number[] = []
  for (let c = p.cw_min; cws.length < 5; c = Math.min(2 * c + 1, p.cw_max)) cws.push(c)
  return (
    <Card title="802.11 DCF: wait for silence, count down, expect an answer">
      <Tex
        display
      >{`\\text{DIFS} = \\text{SIFS} + 2\\,\\sigma = ${p.sifs_us} + 2 \\times ${p.slot_us} = ${st.difs_us}\\ \\mu\\text{s}`}</Tex>
      <Tex
        display
      >{`T_{\\text{data}} = T_{\\text{pre}} + \\frac{8(${p.payload_bytes} + ${DATA_HEADER})}{R} = ${p.preamble_us} + ${data - p.preamble_us} = ${data}\\ \\mu\\text{s}`}</Tex>
      {p.rts ? (
        <>
          <Tex
            display
          >{`\\text{NAV}_{\\text{RTS}} = 3\\,\\text{SIFS} + T_{\\text{CTS}} + T_{\\text{data}} + T_{\\text{ACK}} = ${3 * p.sifs_us} + ${cts} + ${data} + ${ack} = ${f.rts}\\ \\mu\\text{s}`}</Tex>
          <Tex
            display
          >{`\\text{NAV}_{\\text{CTS}} = \\text{NAV}_{\\text{RTS}} - \\text{SIFS} - T_{\\text{CTS}} = ${f.cts}\\ \\mu\\text{s}`}</Tex>
        </>
      ) : (
        <Tex
          display
        >{`\\text{NAV}_{\\text{data}} = \\text{SIFS} + T_{\\text{ACK}} = ${p.sifs_us} + ${ack} = ${f.data}\\ \\mu\\text{s}`}</Tex>
      )}
      <Tex display>{`CW_k = \\min\\!\\big(2^k(CW_{\\min}+1) - 1,\\ ${p.cw_max}\\big):\\ ${cws.join(", ")}, \\dots`}</Tex>
      <Tex
        display
      >{`\\text{data lost so far} = \\frac{${lost}}{${sent.length}}${sent.length ? ` = ${texNum((100 * lost) / sent.length, 1)}\\%` : ""}`}</Tex>
      <p className="font-sans text-xs text-muted-foreground">
        A backoff is drawn from {"{0, …, CW}"} slots of {p.slot_us} µs and counts down only while the medium is idle, after a DIFS of
        silence; the NAV makes a node treat the medium as busy for the time a frame's duration field announces.
      </p>
    </Card>
  )
}

// --- Charts ----------------------------------------------------------------

export interface LinkChart {
  title: string
  series: Series[]
  xLabel: string
  yLabel: string
  xFormat(x: number): string
  yFormat(y: number): string
  xDomain: [number, number]
  yDomain: [number, number]
  log?: { x?: boolean }
  refs: { y: number; label: string }[]
  /** Whether the x axis is the run's clock. */
  timed: boolean
}

const cache = new WeakMap<Netsim, Map<string, unknown>>()
export function cached<T>(sim: Netsim, key: string, f: () => T): T {
  let m = cache.get(sim)
  if (!m) cache.set(sim, (m = new Map()))
  if (!m.has(key)) m.set(key, f())
  return m.get(key) as T
}

export const alohaSweeps = (sim: Netsim) =>
  cached(sim, "aloha", () => ({
    pure: sweepAloha(sim, { ...ALOHA_SWEEP, slotted: false }, SWEEP_GS),
    slotted: sweepAloha(sim, { ...ALOHA_SWEEP, slotted: true }, SWEEP_GS),
  })) as { pure: AlohaPoint[]; slotted: AlohaPoint[] }

export const cdSweep = (sim: Netsim) => cached(sim, "cd", () => sweepCd(sim, CD_SWEEP, SWEEP_BYTES)) as CdPoint[]

const grid = (lo: number, hi: number, n: number) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n)

export function modeChart(sim: Netsim, p: LinkParams, r: LinkRun): LinkChart {
  if (p.mode === "aloha" && r.mode === "aloha") {
    const sw = alohaSweeps(sim)
    const gs = grid(0, 3, 120)
    return {
      title: "Throughput S against offered load G",
      series: [
        { id: "pl", label: "pure: G e^(−2G)", color: "var(--chart-1)", kind: "line", points: gs.map((g) => [g, alohaLimit(false, g)]) },
        { id: "sl", label: "slotted: G e^(−G)", color: "var(--chart-2)", kind: "line", points: gs.map((g) => [g, alohaLimit(true, g)]) },
        { id: "pd", label: "pure, simulated", color: "var(--chart-1)", kind: "dots", points: sw.pure.map((x) => [x.measured_g, x.s]) },
        {
          id: "sd",
          label: "slotted, simulated",
          color: "var(--chart-2)",
          kind: "dots",
          points: sw.slotted.map((x) => [x.measured_g, x.s]),
        },
        { id: "now", label: "this run", color: "var(--chart-3)", kind: "dots", points: [[r.run.stats.g, r.run.stats.s]] },
      ],
      xLabel: "offered load G (frames per frame time)",
      yLabel: "S (good frames per frame time)",
      xFormat: (v) => String(Number(v.toFixed(2))),
      yFormat: (v) => v.toFixed(2),
      xDomain: [0, 3],
      yDomain: [0, 0.45],
      refs: [
        { y: 1 / Math.E, label: "1/e ≈ 0.368" },
        { y: 1 / (2 * Math.E), label: "1/(2e) ≈ 0.184" },
      ],
      timed: false,
    }
  }
  if (p.mode === "csmacd" && r.mode === "csmacd") {
    const sw = cdSweep(sim)
    const tau = tauNs(CD_SWEEP)
    const slot = Math.round((CD_SWEEP.slot_bits * 1e9) / CD_SWEEP.rate_bps)
    const curve = grid(Math.log(24), Math.log(2000), 80).map((x) => frameNs({ ...CD_SWEEP, frame_bytes: Math.exp(x) }))
    const series: Series[] = [
      {
        id: "sim",
        label: "simulated: 10 busy stations",
        color: "var(--chart-1)",
        kind: "dots",
        points: sw.map((x) => [x.a, x.efficiency]),
      },
      { id: "approx", label: "1/(1 + 5a)", color: "var(--chart-2)", kind: "line", points: curve.map((f) => [tau / f, cdApprox(tau / f)]) },
      {
        id: "mb",
        label: "Metcalfe and Boggs, N = 10",
        color: "var(--chart-4)",
        kind: "line",
        dashed: true,
        points: curve.map((f) => [tau / f, metcalfeBoggs(10, f, slot)]),
      },
    ]
    if (p.cd.stations.every((x) => x.frames === 0))
      series.push({
        id: "now",
        label: "this run",
        color: "var(--chart-3)",
        kind: "dots",
        points: [[r.run.stats.a, r.run.stats.efficiency]],
      })
    return {
      title: "Efficiency against a = τ / frame time",
      series,
      xLabel: "a (log scale)",
      yLabel: "efficiency",
      xFormat: (v) => String(Number(v.toPrecision(2))),
      yFormat: (v) => v.toFixed(1),
      xDomain: [0.008, 0.5],
      yDomain: [0, 1],
      log: { x: true },
      refs: [],
      timed: false,
    }
  }
  if (p.mode === "csmaca" && r.mode === "csmaca") {
    const end = p.ca.duration_us
    const name = (i: number) => p.ca.nodes[i].name
    const step = (times: number[]): [number, number][] => [
      [0, 0],
      ...times.map((t, i): [number, number] => [t, i + 1]),
      [end, times.length],
    ]
    const series: Series[] = p.ca.flows.map((f, i) => ({
      id: `f${i}`,
      label: `${name(f.from)} → ${name(f.to)} delivered`,
      color: `var(--chart-${(i % 5) + 1})`,
      kind: "step",
      points: step(r.run.airs.filter((a) => a.kind === "ack" && a.ok && a.flow === i).map((a) => a.end_us)),
    }))
    series.push({
      id: "lost",
      label: "data frames lost",
      color: "var(--chart-6)",
      kind: "step",
      dashed: true,
      points: step(r.run.airs.filter((a) => a.kind === "data" && !a.ok).map((a) => a.end_us)),
    })
    const top = Math.max(1, ...series.map((s) => s.points[s.points.length - 1][1]))
    return {
      title: "Frames delivered and lost over time",
      series,
      xLabel: "time (ms)",
      yLabel: "frames",
      xFormat: (v) => String(Number((v / 1000).toPrecision(4))),
      yFormat: (v) => String(Math.round(v)),
      xDomain: [0, end],
      yDomain: [0, Math.ceil(top * 1.1)],
      refs: [],
      timed: true,
    }
  }
  throw new Error("mode and run disagree")
}

export function chartFigure(c: LinkChart, caption: string): ChartFigure {
  return {
    xLabel: c.xLabel,
    yLabel: c.yLabel,
    xFormat: c.xFormat,
    yFormat: c.yFormat,
    xDomain: c.xDomain,
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

// --- The mode's own tab ----------------------------------------------------

const TH = "pr-2 font-normal"

export function AlohaFrames({ run, t }: { run: AlohaRun; t: number }) {
  const shown = run.frames.filter((f) => f.start_us <= t)
  const rows = shown.slice(-40)
  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full font-sans text-sm tabular-nums lining">
        <caption className="pb-1 text-left text-xs text-muted-foreground">
          The last {rows.length} of {shown.length} frames sent by now, in milliseconds; the table follows the clock.
        </caption>
        <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
          <tr className="text-right">
            <th className={cn(TH, "text-left")}>frame</th>
            <th className={cn(TH, "text-left")}>station</th>
            <th className={TH}>starts</th>
            <th className={TH}>ends</th>
            <th className="text-left font-normal">outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id} className="text-right">
              <td className="pr-2 text-left">#{f.id}</td>
              <td className="pr-2 text-left">{stationName(f.station)}</td>
              <td className="pr-2">{(f.start_us / 1000).toFixed(3)}</td>
              <td className="pr-2">{(f.end_us / 1000).toFixed(3)}</td>
              <td className={cn("text-left", f.end_us <= t && !f.ok && "text-destructive")}>
                {f.end_us > t ? "on the air" : f.ok ? "delivered" : `overlapped #${f.hit}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CdBackoffs({ p, run, t }: { p: CdParams; run: CdRun; t: number }) {
  const shown = run.backoffs.filter((b) => b.t_ns <= t)
  const rows = shown.slice(-30)
  const slot = run.stats.slot_ns
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <caption className="pb-1 text-left text-xs text-muted-foreground">
            Binary exponential backoff (IEEE 802.3, Clause 4.2.3.2.5): after the nth collision of a frame, K is uniform on{" "}
            {"{0, …, 2^min(n, 10) − 1}"}, and the station waits K slots of {fmtTime(slot, "csmacd")}.
          </caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="text-right">
              <th className={cn(TH, "text-left")}>collision n</th>
              {[1, 2, 3, 4, 5, 10, 15, 16].map((n) => (
                <th key={n} className={TH}>
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="text-right">
              <td className="pr-2 text-left text-muted-foreground">largest K</td>
              {[1, 2, 3, 4, 5, 10, 15, 16].map((n) => (
                <td key={n} className="pr-2">
                  {bebMax(n, p.backoff_cap, p.attempt_limit) ?? "drop"}
                </td>
              ))}
            </tr>
            <tr className="text-right">
              <td className="pr-2 text-left text-muted-foreground">mean wait</td>
              {[1, 2, 3, 4, 5, 10, 15, 16].map((n) => {
                const m = bebMax(n, p.backoff_cap, p.attempt_limit)
                return (
                  <td key={n} className="pr-2">
                    {m === null ? "–" : fmtTime((m / 2) * slot, "csmacd")}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="max-h-80 overflow-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <caption className="pb-1 text-left text-xs text-muted-foreground">
            {shown.length
              ? `The last ${rows.length} of ${shown.length} backoffs drawn by now; the table follows the clock.`
              : "No backoff drawn yet."}
          </caption>
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="text-right">
              <th className={cn(TH, "text-left")}>at</th>
              <th className={cn(TH, "text-left")}>station</th>
              <th className={TH}>n</th>
              <th className={TH}>K from</th>
              <th className={TH}>K</th>
              <th className="font-normal">waits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => (
              <tr key={i} className="text-right">
                <td className="pr-2 text-left">{fmtTime(b.t_ns, "csmacd")}</td>
                <td className="pr-2 text-left">{p.stations[b.station].name}</td>
                <td className="pr-2">{b.collisions}</td>
                <td className="pr-2">0…{b.max}</td>
                <td className="pr-2">{b.k}</td>
                <td>{fmtTime(b.k * slot, "csmacd")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function CaStations({ p, run, t }: { p: CaParams; run: CaRun; t: number }) {
  const name = (i: number) => p.nodes[i].name
  const navs = run.navs.filter((q) => q.from_us <= t).slice(-20)
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <caption className="pb-1 text-left text-xs text-muted-foreground">Each flow over the whole run.</caption>
          <thead className="text-xs text-muted-foreground">
            <tr className="text-right">
              <th className={cn(TH, "text-left")}>flow</th>
              <th className={TH}>delivered</th>
              <th className={TH}>data sent</th>
              <th className={TH}>data lost</th>
              <th className={TH}>RTS sent</th>
              <th className={TH}>RTS lost</th>
              <th className={TH}>dropped</th>
              <th className="font-normal">needless wait</th>
            </tr>
          </thead>
          <tbody>
            {run.stats.flows.map((f, i) => (
              <tr key={i} className="text-right">
                <td className="pr-2 text-left">
                  {name(p.flows[i].from)} → {name(p.flows[i].to)}
                </td>
                <td className="pr-2">{f.delivered}</td>
                <td className="pr-2">{f.data_sent}</td>
                <td className={cn("pr-2", f.data_lost > 0 && "text-destructive")}>{f.data_lost}</td>
                <td className="pr-2">{f.rts_sent}</td>
                <td className="pr-2">{f.rts_lost}</td>
                <td className="pr-2">{f.dropped}</td>
                <td>{fmtTime(f.needless_us, "csmaca")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full font-sans text-sm tabular-nums lining">
          <caption className="pb-1 text-left text-xs text-muted-foreground">
            {navs.length ? "The latest NAVs set by now: who heard which frame, and until when it stays quiet." : "No NAV set yet."}
          </caption>
          <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
            <tr className="text-right">
              <th className={cn(TH, "text-left")}>node</th>
              <th className={cn(TH, "text-left")}>heard</th>
              <th className={TH}>from</th>
              <th className="font-normal">until</th>
            </tr>
          </thead>
          <tbody>
            {navs.map((q, i) => {
              const a = run.airs[q.air]
              return (
                <tr key={i} className="text-right">
                  <td className="pr-2 text-left">{name(q.node)}</td>
                  <td className="pr-2 text-left">
                    {name(a.from)}'s {KIND_LABEL[a.kind]}
                  </td>
                  <td className="pr-2">{fmtTime(q.from_us, "csmaca")}</td>
                  <td>{fmtTime(q.until_us, "csmaca")}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Setup -----------------------------------------------------------------

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-sm border border-border p-3">
      <legend className="px-1 font-sans text-xs text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  )
}

export function LinkSetup({ p, set }: { p: LinkParams; set(p: LinkParams): void }) {
  if (p.mode === "aloha") {
    const a = p.aloha
    const put = (o: Partial<AlohaParams>) => set({ mode: "aloha", aloha: { ...a, ...o } })
    return (
      <div className="space-y-5">
        <Group legend="The channel">
          <ParamSwitch
            label="Slots"
            name="Slotted ALOHA"
            checked={a.slotted}
            onChange={(v) => put({ slotted: v })}
            on="Frames start only on slot boundaries"
            off="Frames start whenever a station has one"
          />
          <ParamSlider label="Stations" value={a.stations} min={2} max={10} onChange={(v) => put({ stations: v })} />
          <ParamSlider
            label="Offered load G"
            value={a.g}
            min={0.05}
            max={3}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => put({ g: v })}
          />
        </Group>
        <Group legend="The run">
          <ParamSlider label="Length (frame times)" value={a.length} min={10} max={200} step={5} onChange={(v) => put({ length: v })} />
          <ParamSlider label="Random seed" value={a.seed} min={1} max={50} onChange={(v) => put({ seed: v })} />
        </Group>
      </div>
    )
  }
  if (p.mode === "csmacd") {
    const c = p.cd
    const put = (o: Partial<CdParams>) => set({ mode: "csmacd", cd: { ...c, ...o } })
    const L = Math.max(...c.stations.map((s) => s.pos_m))
    return (
      <div className="space-y-5">
        <Group legend="The frame">
          <ParamSlider
            label="Frame size"
            value={c.frame_bytes}
            min={8}
            max={1518}
            format={(v) => `${v} bytes`}
            onChange={(v) => put({ frame_bytes: v })}
          />
          <p className="font-sans text-xs text-muted-foreground">
            At {bps(c.rate_bps)} that is {fmtTime(frameNs(c), "csmacd")} on the wire; this bus needs at least {minFrameBytes(c)} bytes.
          </p>
        </Group>
        <Group legend="The cable">
          <ParamSlider
            label="Length"
            value={L}
            min={100}
            max={5000}
            step={50}
            format={(v) => `${v} m`}
            onChange={(v) => put({ stations: c.stations.map((s) => ({ ...s, pos_m: L > 0 ? Math.round((s.pos_m * v) / L) : s.pos_m })) })}
          />
          <ParamSlider
            label="Busy stations (always have a frame)"
            value={c.stations.filter((s) => s.frames === 0).length}
            min={0}
            max={c.stations.length}
            onChange={(v) => put({ stations: c.stations.map((s, i) => ({ ...s, frames: i < v ? 0 : 1 })) })}
          />
        </Group>
        <Group legend="Backoff">
          <ParamSlider
            label="Attempts before giving up"
            value={c.attempt_limit}
            min={1}
            max={16}
            onChange={(v) => put({ attempt_limit: v })}
          />
          <ParamSlider
            label="Doubling stops after collision"
            value={c.backoff_cap}
            min={1}
            max={10}
            onChange={(v) => put({ backoff_cap: v })}
          />
          <ParamSlider label="Random seed" value={c.seed} min={1} max={50} onChange={(v) => put({ seed: v })} />
        </Group>
      </div>
    )
  }
  const c = p.ca
  const put = (o: Partial<CaParams>) => set({ mode: "csmaca", ca: { ...c, ...o } })
  const move = (i: number, o: { x_m?: number; y_m?: number }) => put({ nodes: c.nodes.map((v, j) => (j === i ? { ...v, ...o } : v)) })
  return (
    <div className="space-y-5">
      <Group legend="The protocol">
        <ParamSwitch
          label="RTS/CTS"
          name="Use RTS/CTS"
          checked={c.rts}
          onChange={(v) => put({ rts: v })}
          on="Every data frame is preceded by RTS and CTS"
          off="Data frames are sent straight after backoff"
        />
        <ParamSlider
          label="Payload"
          value={c.payload_bytes}
          min={100}
          max={2000}
          step={50}
          format={(v) => `${v} bytes`}
          onChange={(v) => put({ payload_bytes: v })}
        />
        <ParamSlider label="Random seed" value={c.seed} min={1} max={50} onChange={(v) => put({ seed: v })} />
      </Group>
      <Group legend="The radios">
        <ParamSlider
          label="Range"
          value={c.range_m}
          min={40}
          max={250}
          step={5}
          format={(v) => `${v} m`}
          onChange={(v) => put({ range_m: v })}
        />
        {c.nodes.map((v, i) => (
          <div key={i} className="grid grid-cols-2 gap-4">
            <ParamSlider
              label={`${v.name} across`}
              value={v.x_m}
              min={-150}
              max={400}
              step={5}
              format={(x) => `${x} m`}
              onChange={(x) => move(i, { x_m: x })}
            />
            <ParamSlider
              label={`${v.name} down`}
              value={v.y_m}
              min={-150}
              max={150}
              step={5}
              format={(y) => `${y} m`}
              onChange={(y) => move(i, { y_m: y })}
            />
          </div>
        ))}
      </Group>
    </div>
  )
}
