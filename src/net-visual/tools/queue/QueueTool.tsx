import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
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
import { keepFocus, spanIn, timeIn, timelineKeys, useTimeline } from "../../components/timeline"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import {
  LABS,
  MODES,
  PRESETS,
  TOUR,
  runDuration,
  runQueue,
  type Mode,
  type QPacket,
  type QueueParams,
  type QueueRun,
} from "../../core/queue"
import { linkFor, readHash } from "../../core/share"
import { pathAt, pathSvg, pathTikz } from "./pathFigure"
import { QueueAnalysis, QueueFrontier, QueueInternals, QueueIntro, QueueMechanics } from "./QueueArticle"
import {
  EquationCard,
  PacketTable,
  PathView,
  QueueSetup,
  RefLines,
  SchedulerPanel,
  ShaperPanel,
  SweepPanel,
  Totals,
  chartFigure,
  eventText,
  eventTitle,
  eventWhy,
  modeChart,
  useRunning,
} from "./QueueViews"

interface Shared {
  p: QueueParams
  mode: Mode
  t?: number
}

/** Queueing and delay: the four delays, M/M/1 and M/D/1, shapers and schedulers on one output port. */
export function QueueTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <QueueLoaded sim={sim} />
}

/** The deeper view that belongs to each mode. */
const MODE_VIEW: Record<Mode, { title: string; note: string }> = {
  delay: {
    title: "Average time in the router against load, measured and predicted",
    note: "Runs this queue at many loads, with up to a hundred thousand packets each, and sets the averages beside the formula's.",
  },
  shaping: {
    title: "The bucket over time",
    note: "How full the bucket was, and what went in and came out, against the limit it promises.",
  },
  scheduling: {
    title: "The scheduler against the ideal split",
    note: "Each packet's departure beside when an ideal, perfectly shared link would have finished it.",
  },
}
/** Events in each slice of the trace on screen; the slice moves in steps so most clock ticks re-render nothing. */
const SLICE = 200

function QueueLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("queue"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<QueueParams>(shared?.p ?? first.params)
  const [mode, setMode] = useState<Mode>(shared?.mode ?? first.mode)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tour, setTour] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("queue", "source"), [sim])

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: QueueParams; run: QueueRun }>(() => ({ p: params, run: runQueue(sim, params) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runQueue(sim, params) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run, p } = good

  const times = useMemo(() => run.events.map((e) => e.t), [run])
  const duration = useMemo(() => runDuration(run), [run])
  // About three packets a second on the link at speed 1, or the whole run in five minutes if that is quicker.
  const meanTrans = (8e6 * p.flows.reduce((a, f) => a + f.size_bytes, 0)) / p.flows.length / p.rate_bps
  const tl = useTimeline(times, duration, Math.max(meanTrans / 0.3, duration / 300), shared?.t ?? 0)
  const index = Math.max(0, tl.index)
  const event = run.events[index]

  // Before the first step nothing has arrived, even a packet due at time 0.
  const fig = useMemo(() => pathAt(p, run, tl.index >= 0 ? tl.t : -1, selected), [p, run, tl.t, tl.index, selected])
  const running = useRunning(run)
  const chart = useMemo(() => modeChart(mode, p, run, duration), [mode, p, run, duration])
  // The packet whose delays the equation card shows: the one picked, else the last to arrive by now.
  const focus: QPacket | null = useMemo(() => {
    if (selected !== null && run.packets[selected]) return run.packets[selected]
    let last: QPacket | null = null
    for (const q of run.packets) if (q.t_reach !== null && q.t_reach <= tl.t && (!last || q.t_reach > last.t_reach!)) last = q
    return last
  }, [run, selected, tl.t])

  const trace = useMemo(() => run.events.map((e) => ({ t: e.t, step: e.step, text: eventText(p, run, e) })), [p, run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const apply = (next: QueueParams, id = "") => {
    setParams(next)
    setPreset(id)
    setSelected(null)
    keepFocus(root)
  }
  const switchMode = (m: Mode) => setMode(m)
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    switchMode(pr.mode)
    tl.pause()
    tl.seek(at)
  }
  // The article is memoised, so it gets a stable function that calls the latest loader.
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })
  const onLoad = useCallback((id: string) => {
    loader.current(id)
    root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
    root.current?.focus({ preventScroll: true })
  }, [])
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }
  const pick = (q: QPacket) => {
    setSelected(q.id)
    tl.pause()
    tl.seek(q.t_arrive)
    keepFocus(root)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  const caption = `${title}, at ${timeIn(tl.t, tl.duration)}`
  const started = tl.index >= 0
  const many = p.flows.length > 1
  const shaped = p.flows.some((f) => f.shaper.kind !== "none")
  const now = running(tl.t)

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Queueing and delay"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={tl.toggle} />}

      <ExampleIntro title={title} />
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <Transport tl={tl} events={run.events.length} stepIs="one packet arriving, starting to be sent, or leaving" />

      <figure className="space-y-2">
        <PathView fig={fig} label={`${caption}: ${fig.waiting.length} packets waiting, ${fig.delivered} arrived, ${fig.dropped} lost`} />
        <figcaption className="max-w-(--site-measure) font-sans text-sm text-muted-foreground">
          {started ? "" : "Nothing has been sent yet. "}Packets go left to right.{" "}
          {many
            ? "Each flow has its own mark, named on the left: filled or outlined, in dark or light brown. "
            : "They come from the source on the left. "}
          {shaped ? "They pass through a bucket that smooths bursts (the filled part is how full it is), then " : "They "}
          enter the router (the long box). Inside it, each packet is first checked in the dashed square marked process, then waits in line
          (the next to go is on the right), then is sent from the solid square marked send: pushed onto the wire bit by bit. Then it travels
          along the link. Each block on the wire is one packet, as long as the stretch of link its bits fill. The box on the right counts
          packets that have arrived.
        </figcaption>
      </figure>
      <AboutExample
        note={
          presetInfo?.note ??
          `${p.flows.length} flow${many ? "s" : ""} of packets into a router whose link sends ${p.rate_bps / 1e6} Mb/s. Open "Change the link and the traffic", further down the page, to see the rest.`
        }
      />

      <StepCard
        live={!tl.playing}
        when={started ? `At ${timeIn(event.t, tl.duration)}` : null}
        title={started ? eventTitle(event) : undefined}
        text={started ? trace[index].text : undefined}
        why={started ? eventWhy(p, event) : undefined}
        empty={
          <>
            Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time (the arrow keys do the
            same).
          </>
        }
      />

      <Readouts
        caption="So far"
        items={[
          ["Simulated time", timeIn(tl.t, tl.duration)],
          ["Waiting in line now", `${fig.waiting.length} packet${fig.waiting.length === 1 ? "" : "s"}`],
          ["Arrived at the far end", `${fig.delivered} of ${run.packets.length} packets`],
          ["Lost", fig.dropped ? `${fig.dropped} packet${fig.dropped === 1 ? "" : "s"}` : "none"],
          ["Average time in line and being sent, packets sent so far", now.w === null ? "none sent yet" : spanIn(now.w)],
        ]}
      />

      <div className="space-y-2">
        <label className="block text-lg" htmlFor="queue-preset">
          Try another example
        </label>
        <Select
          value={preset || "custom"}
          onValueChange={(id) => {
            setTour(null)
            load(id)
          }}
        >
          <SelectTrigger
            id="queue-preset"
            className="h-auto min-h-9 w-full max-w-xl text-left whitespace-normal [&_[data-slot=select-value]]:line-clamp-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectGroup key={m.id}>
                <SelectLabel>{m.title}</SelectLabel>
                {PRESETS.filter((pr) => pr.mode === m.id).map((pr) => (
                  <SelectItem key={pr.id} value={pr.id}>
                    {pr.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectItem value="custom" disabled>
              Your own setup
            </SelectItem>
          </SelectContent>
        </Select>
        {presetInfo && <p className="font-sans text-sm text-muted-foreground">{sourceLine(presetInfo.source)}</p>}
      </div>

      <div>
        <DeeperHeading />
        <Disclosure title={chart.title} note="The whole run as a chart, faint past the current moment. Select a point to jump there.">
          <LineChart
            title={chart.title}
            series={chart.series}
            xLabel="time (milliseconds)"
            yLabel={chart.yLabel}
            xFormat={(v) => String(Number((v / 1000).toPrecision(4)))}
            yFormat={chart.yFormat}
            xDomain={[0, duration]}
            yDomain={chart.yDomain}
            height={220}
            cursor={tl.t}
            upTo={tl.t}
            onSeek={(t) => tl.seek(t)}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </Disclosure>
        <Disclosure
          title="Each packet's delays"
          note="One row per packet: when it set off and how long each delay took. Select a row to follow it."
        >
          <PacketTable p={p} run={run} t={tl.t} selected={selected} onPick={pick} />
        </Disclosure>
        <Disclosure
          title="The formulas, with this run's numbers"
          note="What queueing theory predicts for this example, set beside what the run measured."
        >
          <EquationCard mode={mode} p={p} run={run} t={tl.t} running={running} focus={focus} />
        </Disclosure>
        <Disclosure title={MODE_VIEW[mode].title} note={MODE_VIEW[mode].note}>
          {mode === "delay" && <SweepPanel sim={sim} p={p} />}
          {mode === "shaping" && <ShaperPanel p={p} run={run} end={duration} cursor={tl.t} onSeek={(t) => tl.seek(t)} />}
          {mode === "scheduling" && <SchedulerPanel p={p} run={run} end={duration} cursor={tl.t} onSeek={(t) => tl.seek(t)} />}
        </Disclosure>
        <Disclosure title="What the whole run comes to" note="Totals for the full run, from start to end.">
          <Totals run={run} p={p} />
        </Disclosure>
        <Disclosure
          title="Change the link and the traffic"
          note="The link's rate and length, the buffer, the order packets are sent in, and each flow's packets."
        >
          <QueueSetup p={params} set={(next) => apply(next)} />
        </Disclosure>
        <Disclosure title="Every step, as a list" note="Each event of the run in order. Select one to jump there.">
          <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} />
          {run.events.length > traceSlice.length && (
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              Events {offset + 1} to {offset + traceSlice.length} of {run.events.length}; the list follows the clock.
            </p>
          )}
        </Disclosure>
        <Disclosure title="Exercises this page can check" note="Short tasks; each says whether the run on screen meets it." keepMounted>
          <LabPanel
            labs={LABS}
            load={(start) => {
              const pr = PRESETS.find((q) => q.params === start)
              apply(start, pr?.id ?? "")
              if (pr) switchMode(pr.mode)
              setTour(null)
              tl.home()
            }}
            check={(lab) => LABS.find((l) => l.id === lab.id)!.check(p, run)}
          />
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust code behind the simulation, with the step behind the current event shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">
            From crates/netsim/src/queue.rs, compiled into the page. Each step has a letter and number, such as A1; the list of steps above
            uses the same names.
          </p>
          <LiterateSource source={source} active={started ? event.step : null} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("queue", { p, mode, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: "the path at this moment",
              stem: `queue-${preset || "custom"}-path`,
              svg: () => pathSvg({ ...fig, caption }),
              tikz: () => pathTikz({ ...fig, caption }),
            },
            {
              label: `the chart: ${chart.title.toLowerCase()}`,
              stem: `queue-${preset || "custom"}-${mode}`,
              ...chartExports(() => chartFigure(chart, duration, `${title}: ${chart.title.toLowerCase()}`)),
            },
          ]}
        />
      </div>

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} p={p} run={run} onLoad={onLoad} />
      </div>
    </section>
  )
}

const Article = memo(function Article(props: { sim: Netsim; p: QueueParams; run: QueueRun; onLoad(id: string): void }) {
  return (
    <>
      <QueueIntro onLoad={props.onLoad} />
      <QueueMechanics />
      <QueueAnalysis {...props} />
      <QueueFrontier />
      <QueueInternals />
    </>
  )
})
