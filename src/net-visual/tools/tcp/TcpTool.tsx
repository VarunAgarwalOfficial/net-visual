import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ZoomIn, ZoomOut } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { chartExports, ladderExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { Ladder, type LadderFlight, type LadderMark } from "../../components/Ladder"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { formatTime, lastAtOrBefore, timelineKeys, useTimeline, type Timeline } from "../../components/timeline"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import { linkFor, readHash } from "../../core/share"
import {
  LABS,
  PRESETS,
  TOUR,
  algoName,
  mbps,
  runOverview,
  runWindow,
  valueAt,
  windowFor,
  windowSpan,
  withAlgo,
  type Algo,
  type Flight,
  type State,
  type TcpParams,
  type TcpRun,
  type Window,
} from "../../core/tcp"
import { CongestionFsm } from "./CongestionFsm"
import { TcpAnalysis, TcpFrontier, TcpInternals, TcpIntro } from "./TcpArticle"
import { CwndChart, cwndFigure, flowLabel } from "./CwndChart"
import { TcpPacket } from "./TcpPacket"
import { TcpSetup } from "./TcpSetup"
import { CubicCurve, Dumbbell, LiveEquations, PhasePlane, QueueChart, RttChart } from "./TcpViews"

interface Shared {
  p: TcpParams
  t?: number
  cmp?: Algo | null
}

/** TCP congestion control: Tahoe, Reno, NewReno and CUBIC sharing a bottleneck. */
export function TcpTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <TcpLoaded sim={sim} />
}

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
const LADDER_HEIGHT = 560
/** Rows of the trace drawn at once, centred on the current event. */
const TRACE_ROWS = 400

/**
 * Flights of flow 0 for the ladder. A lost segment is drawn heading for the
 * receiver and cut halfway, the usual convention; the model drops it at the
 * bottleneck queue, which sits next to the sender.
 */
function toLadder(run: TcpRun, rtt: number): LadderFlight[] {
  return run.flights.map((f) => ({
    id: f.id,
    from: f.ack ? 1 : 0,
    t_start: f.t_start,
    t_sent: f.t_sent,
    t_arrive: f.lost || f.t_arrive > 1e15 ? f.t_sent + rtt / 2 : f.t_arrive,
    lost: f.lost,
    label: f.ack ? `ACK ${f.seg}` : `seg ${f.seg}${f.occurrence > 1 ? "′" : ""}`,
    fate: f.fate || "in flight",
    color: f.ack ? (f.fate === "duplicate ACK" ? "var(--chart-4)" : "var(--chart-2)") : "var(--chart-1)",
    alarm: f.fate === "duplicate, already had it",
  }))
}

interface Pick {
  ack: boolean
  seg: number
  occurrence: number
  t: number
}
const pickOf = (f: Flight): Pick => ({ ack: f.ack, seg: f.seg, occurrence: f.occurrence, t: f.t_start })
const matches = (k: Pick) => (f: Flight) =>
  f.ack === k.ack && f.seg === k.seg && (f.ack ? f.t_start === k.t : f.occurrence === k.occurrence)

const PHASE = { S: "slow start", A: "congestion avoidance", R: "fast recovery" } as const

function TcpLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("tcp"), [])
  const first = PRESETS[0]
  const startT = shared?.t ?? 0
  // The parameters and the window of the trace move together, so a window always belongs to its run.
  const [model, setModel] = useState<{ p: TcpParams; w: Window }>(() => {
    const p = shared?.p ?? first.params
    return { p, w: windowFor(p, startT) }
  })
  const params = model.p
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [cmp, setCmp] = useState<Algo | null>(shared ? (shared.cmp ?? null) : (first.compare ?? null))
  const [pick, setPick] = useState<Pick | null>(null)
  const [zoom, setZoom] = useState(1)
  const [follow, setFollow] = useState(true)
  const [tab, setTab] = useState("trace")
  const [tour, setTour] = useState<number | null>(null)
  // A step that left the window, waiting for the next window's trace.
  const pending = useRef<{ dir: 1 | -1; at: number; from: TcpRun } | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("tcp", "source"), [sim])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  const result = useMemo<{ run: TcpRun } | { error: string }>(() => {
    try {
      return { run: runOverview(sim, params) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [sim, params])
  const overview = "run" in result ? result.run : null
  const compare = useMemo(() => {
    if (!overview || !cmp || cmp === params.flows[0].algo) return null
    try {
      return runOverview(sim, withAlgo(params, cmp))
    } catch {
      return null
    }
  }, [sim, params, cmp, overview])
  const detail = useMemo(() => {
    if (!overview) return null
    try {
      return runWindow(sim, model.p, model.w)
    } catch {
      return null
    }
  }, [sim, model, overview])

  const times = useMemo(() => detail?.events.map((e) => e.t) ?? [], [detail])
  const rtt0 = params.flows[0].rtt_us
  const tx = (8 * params.mss_bytes * 1e6) / params.rate_bps
  // At speed 1, one round trip of flow 1 takes 0.8 s.
  const rate = (rtt0 + tx) / 0.8
  const tl = useTimeline(times, params.duration_us, rate, startT)

  const lo = model.w.from
  const hi = detail?.trace_end ?? model.w.to
  const inside = tl.t >= lo && tl.t <= hi
  const { span } = windowSpan(params)
  // Faster than a window per real second, recomputing the trace would stutter: wait for a pause.
  const racing = tl.playing && tl.speed * rate > span

  // Move the trace window when the clock leaves it (a guarded update during render, so no extra pass).
  if (!inside && !racing) {
    let w = windowFor(params, tl.t)
    // The model caps a trace's length, so a busy window can end before its
    // nominal end; past that point the aligned window is the same one again.
    // Start the next window at the clock instead.
    if (w.from === model.w.from && tl.t > hi) {
      const { lead } = windowSpan(params)
      w = { from: tl.t, to: Math.min(params.duration_us, tl.t + span), lead }
    }
    if (w.from !== model.w.from || w.to !== model.w.to) setModel({ p: params, w })
  }

  // A step past the edge of a window lands on the next event of the new one.
  useEffect(() => {
    const pd = pending.current
    if (!pd || !detail || detail === pd.from) return
    pending.current = null
    tl.seekIndex(pd.dir > 0 ? lastAtOrBefore(times, pd.at) + 1 : lastAtOrBefore(times, pd.at - 1))
  }, [detail, times, tl])

  const apply = (p: TcpParams, id = "", t = tl.t) => {
    setModel({ p, w: windowFor(p, t) })
    setPreset(id)
  }

  const step = (d: number) => {
    const i = tl.index + d
    if (detail && i >= times.length && detail.trace_end < params.duration_us) {
      tl.pause()
      pending.current = { dir: 1, at: detail.trace_end, from: detail }
      tl.seek(detail.trace_end + 1)
    } else if (detail && i < 0 && model.w.from > 0) {
      tl.pause()
      const at = times[0] ?? model.w.from
      pending.current = { dir: -1, at, from: detail }
      tl.seek(Math.max(0, at - 1))
    } else tl.step(d)
  }
  const tlx: Timeline = {
    ...tl,
    step,
    toggle: () => {
      setFollow(true)
      tl.toggle()
    },
  }

  const loadPreset = (id: string) => {
    const pr = PRESETS.find((x) => x.id === id)
    if (!pr) return
    apply(pr.params, pr.id, 0)
    setCmp(pr.compare ?? null)
    setPick(null)
    setTour(null)
    tl.home()
  }
  // The article is memoised, so it gets a stable function that calls the latest loader.
  const loader = useRef(loadPreset)
  useEffect(() => {
    loader.current = loadPreset
  })
  const onLoad = useCallback((id: string) => {
    loader.current(id)
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    const s = TOUR[i]
    const pr = PRESETS.find((x) => x.id === s.preset)!
    const t = s.at * pr.params.duration_us
    apply(pr.params, pr.id, t)
    setCmp(pr.compare ?? null)
    tl.pause()
    tl.seek(t)
    setFollow(true)
  }

  const ladderFlights = useMemo(() => (detail ? toLadder(detail, rtt0) : []), [detail, rtt0])
  const ladderMarks = useMemo<LadderMark[]>(
    () =>
      detail
        ? detail.events
            .filter((e) => e.step === "T1" || e.step === "F1")
            .map((e) => ({ t: e.t, lane: 0, text: e.step === "T1" ? "timeout" : "fast retransmit" }))
        : [],
    [detail],
  )
  const ladderStart = Math.max(0, model.w.from - model.w.lead)
  const usPerPx = Math.max(1, (rtt0 + tx) / (LADDER_HEIGHT - 60) / zoom)

  if (!overview) {
    return (
      <div className="space-y-3">
        <p role="alert">These settings cannot run: {"error" in result ? result.error : ""}</p>
        <Button onClick={() => apply(first.params, first.id, 0)}>Back to the first scenario</Button>
      </div>
    )
  }

  const event = detail && inside && tl.index >= 0 ? detail.events[tl.index] : null
  const before = detail && inside && tl.index >= 1 ? detail.events[tl.index - 1].state.phase : null
  const seekTo = (x: number) => {
    tl.pause()
    tl.seek(x)
    setFollow(true)
  }
  const flight = pick && detail ? (detail.flights.find(matches(pick)) ?? null) : null
  const scripted = (f: Flight) => params.drops.some((d) => d.flow === 0 && d.seg === f.seg && d.occurrence === f.occurrence)
  const toggleDrop = (f: Flight) => {
    if (f.ack) return
    const has = scripted(f)
    if (!has && (f.lost || params.drops.length >= 64)) return
    const drops = has
      ? params.drops.filter((d) => !(d.flow === 0 && d.seg === f.seg && d.occurrence === f.occurrence))
      : [...params.drops, { flow: 0, seg: f.seg, occurrence: f.occurrence }]
    apply({ ...params, drops }, preset)
  }

  const presetInfo = PRESETS.find((x) => x.id === preset)
  const traceFrom = Math.max(0, Math.min(tl.index - TRACE_ROWS / 2, times.length - TRACE_ROWS))
  const caption = `${params.flows.map((_, i) => flowLabel(params, i)).join("; ")}; ${mbps(params.rate_bps)}, B = ${params.buffer_pkts}`

  return (
    <section
      ref={root}
      className="nv-tool space-y-5 [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tlx, e)) {
          e.preventDefault()
          setFollow(true)
        } else if ((e.key === "d" || e.key === "D") && flight) {
          toggleDrop(flight)
          e.preventDefault()
        } else if (e.key === "Escape") setPick(null)
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="tcp-preset">
            Scenario
          </label>
          <Select value={preset || "custom"} onValueChange={loadPreset}>
            <SelectTrigger id="tcp-preset" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((pr) => (
                <SelectItem key={pr.id} value={pr.id}>
                  {pr.title}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Your own settings
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("tcp", { p: params, t: Math.round(tl.t), cmp } satisfies Shared)}
          figures={[
            {
              label: "Window chart",
              stem: `tcp-${preset || "custom"}-cwnd`,
              ...chartExports(() => cwndFigure(overview, compare, cmp, params, caption)),
            },
            {
              label: "Sequence diagram, last two round trips",
              stem: `tcp-${preset || "custom"}-ladder`,
              ...ladderExports({
                lanes: ["Sender", "Receiver"],
                flights: ladderFlights,
                marks: ladderMarks,
                from: Math.max(ladderStart, tl.t - 2 * (rtt0 + tx)),
                upTo: tl.t,
                caption: `${caption}; up to ${formatTime(tl.t)}`,
              }),
            },
          ]}
        />
      </div>

      {tour !== null ? (
        <div className="rounded-sm border border-border bg-muted/40 p-4" aria-live="polite">
          <p className="font-sans text-xs text-muted-foreground">
            Tour, {tour + 1} of {TOUR.length}
          </p>
          <p className="mt-1 max-w-[70ch]">{TOUR[tour].text}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" disabled={tour === 0} onClick={() => goTour(tour - 1)}>
              Back
            </Button>
            <Button size="sm" onClick={() => goTour(tour + 1 < TOUR.length ? tour + 1 : null)}>
              {tour + 1 < TOUR.length ? "Next" : "Finish"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => tlx.toggle()}>
              {tl.playing ? "Pause" : "Play from here"}
            </Button>
          </div>
        </div>
      ) : (
        presetInfo && (
          <p className="max-w-[70ch] text-[0.98rem]">
            {presetInfo.note} <span className="text-muted-foreground">({presetInfo.source}.)</span>
          </p>
        )
      )}

      <CwndChart
        run={overview}
        compare={compare}
        cmp={cmp}
        p={params}
        t={tl.t}
        band={detail ? [model.w.from, detail.trace_end] : null}
        onSeek={seekTo}
      />
      <Transport tl={tlx} events={null} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between font-sans text-sm text-muted-foreground">
            <span>Flow 1, every packet{inside ? "" : racing ? " (catches up when paused)" : ""}</span>
            <span className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out in time" onClick={() => setZoom(zoom / 1.6)}>
                <ZoomOut />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in in time" onClick={() => setZoom(zoom * 1.6)}>
                <ZoomIn />
              </Button>
            </span>
          </div>
          <div onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
            <Ladder
              lanes={["Sender", "Receiver"]}
              flights={ladderFlights}
              marks={ladderMarks}
              t={tl.t}
              start={ladderStart}
              duration={hi}
              usPerPx={usPerPx}
              selected={flight?.id ?? null}
              onSelect={(id) => {
                const f = id !== null && detail ? detail.flights[id] : null
                setPick(f ? pickOf(f) : null)
                if (f) setTab("packet")
              }}
              follow={follow}
              height={LADDER_HEIGHT}
            />
          </div>
          <p className="font-sans text-xs text-muted-foreground">
            Click a segment to see its header; press <kbd>D</kbd> to drop it, or to undo your drop. Duplicate ACKs are amber. Space plays,
            arrow keys step through events, Home and End jump.
          </p>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
            {event ? (
              <>
                <p className="font-sans text-xs text-muted-foreground">{formatTime(event.t)}, flow 1</p>
                <p className="mt-0.5">
                  <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {event.text}
                </p>
              </>
            ) : (
              <p className="font-sans text-sm text-muted-foreground">
                {formatTime(tl.t)}: no event of flow 1 yet{tl.playing ? "; pause to step through events" : ""}.
              </p>
            )}
          </div>
          <CongestionFsm event={event} before={before} algo={params.flows[0].algo} />
          <StateView s={event?.state ?? null} run={overview} t={tl.t} p={params} />
          <Totals run={overview} p={params} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="packet">Packet</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <p className="mb-1 font-sans text-xs text-muted-foreground">
                Every step flow 1 took near this moment, lettered as in the source. Click a row to go there.
              </p>
              <TraceList
                events={detail?.events.slice(traceFrom, traceFrom + TRACE_ROWS) ?? []}
                index={tl.index - traceFrom}
                onSeek={(i) => tl.seekIndex(i + traceFrom)}
              />
            </TabsContent>
            <TabsContent value="setup">
              <TcpSetup p={params} set={(p) => apply(p)} cmp={cmp} setCmp={setCmp} />
            </TabsContent>
            <TabsContent value="packet">
              {flight ? (
                <TcpPacket f={flight} p={params} scripted={scripted(flight)} onToggle={() => toggleDrop(flight)} />
              ) : (
                <p className="text-muted-foreground">Click a packet in the ladder to see its header.</p>
              )}
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/tcp.rs), compiled into the page. The step behind the current event is
                shaded.
              </p>
              <LiterateSource source={source} active={event?.step ?? ""} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
              <LabPanel
                labs={LABS}
                load={(p) => {
                  apply(p, "", 0)
                  setCmp(null)
                  tl.home()
                }}
                check={(lab) => LABS.find((l) => l.id === lab.id)!.check(params, overview, sim)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Dumbbell run={overview} p={params} t={tl.t} />
          <QueueChart run={overview} p={params} t={tl.t} onSeek={seekTo} />
          <RttChart run={overview} p={params} t={tl.t} onSeek={seekTo} />
        </div>
        <div className="min-w-0 space-y-5">
          {params.flows.length > 1 && <PhasePlane run={overview} p={params} t={tl.t} />}
          {params.flows[0].algo === "cubic" && event && event.state.w_max > 0 && <CubicCurve s={event.state} />}
          <section aria-label="Equations with this run's numbers">
            <h3 className="mb-1 font-sans text-sm text-muted-foreground">The formulas, with this moment's numbers</h3>
            <LiveEquations run={overview} p={params} s={event?.state ?? null} t={tl.t} />
          </section>
        </div>
      </div>

      <Article sim={sim} p={params} run={overview} onLoad={onLoad} />
    </section>
  )
}

// The article is long; playback re-renders the tool many times a second, so it
// re-renders only when the run changes.
const Article = memo(function Article(props: { sim: Netsim; p: TcpParams; run: TcpRun; onLoad(id: string): void }) {
  return (
    <>
      <TcpIntro onLoad={props.onLoad} />
      <TcpAnalysis sim={props.sim} p={props.p} run={props.run} />
      <TcpFrontier />
      <TcpInternals />
    </>
  )
})

const us = (v: number) => formatTime(Math.max(0, v))
const num = (v: number) => (v >= 1e8 ? "∞" : v >= 100 ? v.toFixed(0) : String(Number(v.toFixed(2))))

/** The sender's variables at the current event (or, between windows, from the curves). */
function StateView({ s, run, t, p }: { s: State | null; run: TcpRun; t: number; p: TcpParams }) {
  const f = run.series[0]
  const items: [string, string][] = s
    ? [
        ["cwnd", num(s.cwnd)],
        ["ssthresh", num(s.ssthresh)],
        ["phase", PHASE[s.phase]],
        ["oldest unACKed, next", `${s.una}, ${s.nxt}`],
        ["in flight", String(s.nxt - s.una)],
        ["duplicate ACKs", String(s.dupacks)],
        ["SRTT, RTTVAR", s.srtt_us > 0 ? `${us(s.srtt_us)}, ${us(s.rttvar_us)}` : "no sample yet"],
        ["RTO", us(s.rto_us)],
        ["timer fires", s.timer_at === null ? "off" : formatTime(s.timer_at)],
        ["queue at the bottleneck", `${s.queue} of ${p.buffer_pkts}`],
        ...(p.flows[0].algo === "cubic" && s.w_max > 0
          ? ([
              ["CUBIC W_max, K", `${num(s.w_max)}, ${s.k.toFixed(2)} s`],
              ["CUBIC region", { F: "Reno-friendly", C: "concave", X: "convex", "-": "not in an epoch" }[s.region]],
            ] as [string, string][])
          : []),
      ]
    : [
        ["cwnd", num(valueAt(f.cwnd, t))],
        ["ssthresh", num(valueAt(f.ssthresh, t))],
        ["SRTT", us(valueAt(f.srtt, t))],
        ["RTO", us(valueAt(f.rto, t))],
        ["queue at the bottleneck", `${valueAt(run.queue, t)} of ${p.buffer_pkts}`],
      ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="tabular-nums lining">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Measured over the second half of the run, after the start-up. */
const Totals = memo(function Totals({ run, p }: { run: TcpRun; p: TcpParams }) {
  const T = run.totals
  const items: [string, string][] = [
    ["link utilisation", T.utilisation.toFixed(3)],
    ...(p.flows.length === 1 ? ([["sawtooth formula", run.theory.reno_utilisation.toFixed(3)]] as [string, string][]) : []),
    ...T.flows.map(
      (f, i) => [p.flows.length > 1 ? `flow ${i + 1} (${algoName(p.flows[i].algo)})` : "goodput", mbps(f.goodput_bps)] as [string, string],
    ),
    ...(p.flows.length > 1 ? ([["Jain's fairness index", T.jain.toFixed(3)]] as [string, string][]) : []),
    ["fast retransmits, timeouts (whole run)", `${T.flows[0].fast_retransmits}, ${T.flows[0].timeouts}`],
    ["mean round trip", formatTime(T.flows[0].mean_rtt_us)],
    ["mean queue", `${T.mean_queue.toFixed(1)} packets`],
  ]
  return (
    <div>
      <p className="mb-1 font-sans text-xs text-muted-foreground">Measured over the second half of the run, after start-up</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-3">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="tabular-nums lining">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
})
