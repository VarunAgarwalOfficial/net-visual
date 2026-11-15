import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { chartExports, ladderExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { Ladder, type LadderFlight, type LadderMark } from "../../components/Ladder"
import { LiterateSource } from "../../components/LiterateSource"
import {
  DeeperHeading,
  Disclosure,
  AboutExample,
  ExampleIntro,
  Readouts,
  StepCard,
  TourAndSharing,
  TourCard,
  scrollBehavior,
  sourceLine,
} from "../../components/ToolFrame"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { formatTime, keepFocus, lastAtOrBefore, timeIn, timelineKeys, useTimeline, type Timeline } from "../../components/timeline"
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
import { packets, plainTcp } from "./plain"
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

const LADDER_HEIGHT = 480
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
    label: f.ack ? `ACK ${f.seg}` : `packet ${f.seg}${f.occurrence > 1 ? ", again" : ""}`,
    fate: FATES[f.fate] ?? (f.fate || "on the way"),
    color: f.ack ? (f.fate === "duplicate ACK" ? "var(--nv-again)" : "var(--nv-ok)") : "var(--nv-busy)",
    alarm: f.fate === "duplicate, already had it",
  }))
}

// What happened to a packet, in a few words that fit beside the lane.
const FATES: Record<string, string> = {
  "duplicate ACK": "repeated ACK",
  "buffered out of order": "kept, out of order",
  "duplicate, already had it": "a copy",
  "dropped as scripted": "lost (on purpose)",
  "dropped: every n-th packet": "lost",
  "dropped at random": "lost",
  "dropped: queue full": "lost: buffer full",
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

const PHASE = { S: "slow start (growing fast)", A: "congestion avoidance (growing slowly)", R: "fast recovery (repairing a loss)" } as const

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
  const [ladderOpen, setLadderOpen] = useState(false)
  const [tour, setTour] = useState<number | null>(null)
  // A step that left the window, waiting for the next window's trace.
  const pending = useRef<{ dir: 1 | -1; at: number; from: TcpRun } | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("tcp", "source"), [sim])

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
    keepFocus(root)
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
    root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
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
            .map((e) => ({ t: e.t, lane: 0, text: e.step === "T1" ? "timer ran out" : "fast retransmit" }))
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
  const plain = event ? plainTcp(event, params) : null
  const many = params.flows.length > 1
  const sofar = overview.series[0].marks.filter((m) => m.t <= tl.t && m.t > 0)
  const count = (k: string) => sofar.filter((m) => m.kind === k).length

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="TCP congestion control"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
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
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={tlx.toggle} />}

      <ExampleIntro title={presetInfo?.title ?? "Your own settings"} />

      <Transport tl={tlx} events={null} />

      <figure className="space-y-2">
        <CwndChart
          run={overview}
          compare={compare}
          cmp={cmp}
          p={params}
          t={tl.t}
          band={ladderOpen && detail ? [model.w.from, detail.trace_end] : null}
          onSeek={seekTo}
        />
        <figcaption className="max-w-(--site-measure) font-sans text-sm text-muted-foreground">
          Time runs left to right. Each line is a sender&apos;s window: how many packets it may have on the way at once, so a higher line
          means a faster sender. The faint lines are the whole run, still to come; once Play starts, the part already played is drawn in
          full colour and an upright line marks now. Where a line jumps up for a moment just after a loss, the sender is in fast recovery:
          each repeated acknowledgement (the receiver's note of what it has got) lets it send one more packet while it waits for the lost
          one to be resent. Select a point on the chart to jump there.
        </figcaption>
      </figure>
      <AboutExample
        note={
          presetInfo?.note ??
          `${params.flows.map((_, i) => flowLabel(params, i)).join("; ")} on a ${mbps(params.rate_bps)} link whose router holds ${params.buffer_pkts} waiting packets. Open "Change the settings", further down the page, to see the rest.`
        }
      />

      <StepCard
        live={!tl.playing}
        when={event ? `At ${timeIn(event.t, tl.duration)}${many ? ", the first sender" : ""}` : null}
        title={plain?.title}
        text={plain?.text}
        why={plain?.why}
        empty={
          tl.t > 0 && !inside ? (
            <>Playing too fast to follow each packet. Pause, or lower the speed, to see each event.</>
          ) : tl.t > 0 ? (
            <>No event{many ? " of the first sender" : ""} yet at this moment.</>
          ) : (
            <>
              Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time (the arrow keys do the
              same).
            </>
          )
        }
      />

      <StateView s={event?.state ?? null} run={overview} t={tl.t} p={params} />

      <Readouts
        caption="So far"
        cols={4}
        items={[
          ["Simulated time", timeIn(tl.t, tl.duration)],
          [`Packets lost${many ? ", first sender" : ""}`, String(count("drop"))],
          ["Resent after three repeated ACKs (fast retransmit)", String(count("fast"))],
          ["Times the timer ran out", String(count("timeout"))],
        ]}
      />

      <div className="space-y-2">
        <label className="block text-lg" htmlFor="tcp-preset">
          Try another example
        </label>
        <Select value={preset || "custom"} onValueChange={loadPreset}>
          <SelectTrigger
            id="tcp-preset"
            className="h-auto min-h-9 w-full max-w-xl text-left whitespace-normal [&_[data-slot=select-value]]:line-clamp-none"
          >
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
        {presetInfo && <p className="font-sans text-sm text-muted-foreground">{sourceLine(presetInfo.source)}</p>}
      </div>

      <div>
        <DeeperHeading />
        <Disclosure
          title={many ? "Each packet of the first sender, as a sequence diagram" : "Each packet, as a sequence diagram"}
          note="Time runs down the page: packets go from sender to receiver, acknowledgements come back. Select a packet to see its header or drop it."
          open={ladderOpen}
          onOpenChange={setLadderOpen}
        >
          <div className="space-y-2">
            <p className="max-w-(--site-measure) font-sans text-sm text-muted-foreground">
              A band from the sender is a packet, named by its number; a band back is an acknowledgement (ACK), named by the next packet the
              receiver expects. A repeated ACK is amber. A red cross is a lost packet. The dotted line is now
              {inside ? "" : racing ? "; the diagram catches up when you pause" : ""}. On the chart above, the shaded stretch is the part
              shown here.
            </p>
            <div onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}>
              <Ladder
                lanes={["Sender", "Receiver"]}
                flights={ladderFlights}
                marks={ladderMarks}
                t={tl.index >= 0 || tl.t > 0 ? tl.t : -1}
                start={ladderStart}
                duration={hi}
                usPerPx={usPerPx}
                selected={flight?.id ?? null}
                onSelect={(id) => {
                  const f = id !== null && detail ? detail.flights[id] : null
                  setPick(f ? pickOf(f) : null)
                }}
                follow={follow}
                height={LADDER_HEIGHT}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-muted-foreground">
              <span className="mr-auto">Select a packet to see its header. Press D to drop it, or to undo your drop.</span>
              <Button variant="ghost" size="xs" onClick={() => setZoom(zoom / 1.6)}>
                Show more time
              </Button>
              <Button variant="ghost" size="xs" onClick={() => setZoom(zoom * 1.6)}>
                Show less time
              </Button>
            </div>
            {flight && (
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-lg">The selected packet</h3>
                  <Button variant="ghost" size="xs" onClick={() => setPick(null)}>
                    Close
                  </Button>
                </div>
                <TcpPacket f={flight} p={params} scripted={scripted(flight)} onToggle={() => toggleDrop(flight)} />
              </div>
            )}
          </div>
        </Disclosure>
        <Disclosure
          title="Which mode the sender is in"
          note="The three modes as a diagram, with the one it is in now filled and the move it just made drawn heavier."
        >
          <p className="mb-2 max-w-(--site-measure) font-sans text-sm text-muted-foreground">
            On the diagram, cwnd is the congestion window and ssthresh the slow-start threshold, both in packets; a dup ACK is a repeated
            acknowledgement; recover is the highest packet sent when the loss was found.
          </p>
          <CongestionFsm event={event} before={before} algo={params.flows[0].algo} />
        </Disclosure>
        <Disclosure
          title="The router's queue and the round-trip time"
          note="The path drawn with the packets waiting at the router now, and how the queue and the round trip change over the run."
        >
          <div className="space-y-5">
            <Dumbbell run={overview} p={params} t={tl.t} />
            <QueueChart run={overview} p={params} t={tl.t} onSeek={seekTo} />
            <RttChart run={overview} p={params} t={tl.t} onSeek={seekTo} />
          </div>
        </Disclosure>
        {many && (
          <Disclosure
            title="The senders' rates against each other"
            note="One sender's rate across, the other's up, with the line where they are equal."
          >
            <PhasePlane run={overview} p={params} t={tl.t} />
          </Disclosure>
        )}
        {params.flows[0].algo === "cubic" && (
          <Disclosure
            title="CUBIC's curve since the last loss"
            note="The window CUBIC aims for, second by second, since it last cut its window."
          >
            {event && event.state.w_max > 0 ? (
              <CubicCurve s={event.state} />
            ) : (
              <p className="font-sans text-sm text-muted-foreground">No loss yet, so there is no curve. Play on until the first loss.</p>
            )}
          </Disclosure>
        )}
        <Disclosure
          title="The formulas, with this moment's numbers"
          note="Round trip, rate, timer, the sawtooth, the square-root law and CUBIC's curve, each with the numbers from now."
        >
          <LiveEquations run={overview} p={params} s={event?.state ?? null} t={tl.t} />
        </Disclosure>
        <Disclosure title="What the whole run averages" note="Measured over the second half of the run, after the start-up.">
          <Totals run={overview} p={params} />
        </Disclosure>
        <Disclosure
          title="Change the settings"
          note="The senders and their rules, the link's speed, the router's buffer, losses, and a second rule drawn dashed for comparison."
        >
          <TcpSetup p={params} set={(p) => apply(p)} cmp={cmp} setCmp={setCmp} />
        </Disclosure>
        <Disclosure
          title={many ? "Every step of the first sender near now, as a list" : "Every step near now, as a list"}
          note="The simulation's own log, with the step codes used in the program. Select a line to go to that moment."
        >
          <TraceList
            events={detail?.events.slice(traceFrom, traceFrom + TRACE_ROWS) ?? []}
            index={tl.index - traceFrom}
            onSeek={(i) => tl.seekIndex(i + traceFrom)}
          />
        </Disclosure>
        <Disclosure
          title="Exercises this page can check"
          note="Short tasks, from recall to investigation. The page checks your answer against the run."
          keepMounted
        >
          <LabPanel
            labs={LABS}
            load={(p) => {
              apply(p, "", 0)
              setCmp(null)
              tl.home()
            }}
            check={(lab) => LABS.find((l) => l.id === lab.id)!.check(params, overview, sim)}
          />
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust source, compiled into the page. The step behind the current event is shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">crates/netsim/src/tcp.rs</p>
          <LiterateSource source={source} active={event?.step ?? ""} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("tcp", { p: params, t: Math.round(tl.t), cmp } satisfies Shared)}
          figures={[
            {
              label: "the window chart",
              stem: `tcp-${preset || "custom"}-cwnd`,
              ...chartExports(() => cwndFigure(overview, compare, cmp, params, caption)),
            },
            {
              label: "the sequence diagram, last two round trips",
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

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} p={params} run={overview} onLoad={onLoad} />
      </div>
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

/** The sender's variables at the current event (or, between windows, from the curves), each named in full with its unit. */
function StateView({ s, run, t, p }: { s: State | null; run: TcpRun; t: number; p: TcpParams }) {
  const f = run.series[0]
  const who = p.flows.length > 1 ? "The first sender, now" : "The sender, now"
  const items: [string, string][] = s
    ? [
        ["Congestion window (cwnd)", packets(s.cwnd)],
        ["Slow-start threshold (ssthresh)", s.ssthresh >= 1e8 ? "not set until the first loss" : packets(s.ssthresh)],
        ["Mode", PHASE[s.phase]],
        ["Packets on the way, not yet acknowledged", String(s.nxt - s.una)],
        ["Oldest unacknowledged packet, next to send", `${s.una}, ${s.nxt}`],
        ["Repeated acknowledgements in a row", String(s.dupacks)],
        ["Smoothed round-trip time (SRTT)", s.srtt_us > 0 ? us(s.srtt_us) : "no measurement yet"],
        ["Round-trip variation (RTTVAR)", s.srtt_us > 0 ? us(s.rttvar_us) : "no measurement yet"],
        ["Retransmission timeout (RTO)", us(s.rto_us)],
        ["Timer runs out at", s.timer_at === null ? "not running" : formatTime(s.timer_at)],
        ["Packets waiting at the router", `${s.queue} of ${p.buffer_pkts}`],
        ...(p.flows[0].algo === "cubic" && s.w_max > 0
          ? ([
              ["CUBIC: window at the last loss (W_max)", packets(s.w_max)],
              ["CUBIC: time to get back to it (K)", `${s.k.toFixed(2)} s`],
              [
                "CUBIC: part of the curve",
                { F: "as fast as Reno would be", C: "rising, slowing near W_max", X: "past W_max, speeding up", "-": "none yet" }[s.region],
              ],
            ] as [string, string][])
          : []),
      ]
    : [
        ["Congestion window (cwnd)", packets(valueAt(f.cwnd, t))],
        [
          "Slow-start threshold (ssthresh)",
          valueAt(f.ssthresh, t) >= 1e8 ? "not set until the first loss" : packets(valueAt(f.ssthresh, t)),
        ],
        ["Smoothed round-trip time (SRTT)", f.srtt.length && f.srtt[0][0] <= t ? us(valueAt(f.srtt, t)) : "no measurement yet"],
        ["Retransmission timeout (RTO)", us(valueAt(f.rto, t))],
        ["Packets waiting at the router", `${valueAt(run.queue, t)} of ${p.buffer_pkts}`],
      ]
  return <Readouts caption={who} items={items} />
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

/** Measured over the second half of the run, after the start-up. */
const Totals = memo(function Totals({ run, p }: { run: TcpRun; p: TcpParams }) {
  const T = run.totals
  const items: [string, string][] = [
    ["Share of time the link is busy", pct(T.utilisation)],
    ...(p.flows.length === 1 ? ([["What the sawtooth formula predicts", pct(run.theory.reno_utilisation)]] as [string, string][]) : []),
    ...T.flows.map(
      (f, i) =>
        [
          p.flows.length > 1 ? `Data delivered per second, sender ${i + 1} (${algoName(p.flows[i].algo)})` : "Data delivered per second",
          mbps(f.goodput_bps),
        ] as [string, string],
    ),
    ...(p.flows.length > 1 ? ([["Jain's fairness index (1 means equal shares)", T.jain.toFixed(3)]] as [string, string][]) : []),
    ["Fast retransmits, whole run", String(T.flows[0].fast_retransmits)],
    ["Times the timer ran out, whole run", String(T.flows[0].timeouts)],
    ["Average round trip", formatTime(T.flows[0].mean_rtt_us)],
    ["Average packets waiting at the router", `${T.mean_queue.toFixed(1)} packets`],
  ]
  return <Readouts items={items} />
})
