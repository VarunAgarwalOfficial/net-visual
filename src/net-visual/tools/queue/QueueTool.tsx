import { memo, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import {
  LABS,
  MODES,
  PRESETS,
  TOUR,
  runDuration,
  runQueue,
  us,
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
  modeChart,
  packetName,
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

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
/** The tab that belongs to each mode. */
const MODE_TAB: Record<Mode, { id: string; title: string }> = {
  delay: { id: "sweep", title: "W against ρ" },
  shaping: { id: "shaper", title: "Shaper" },
  scheduling: { id: "scheduler", title: "Scheduler" },
}
/** Events in each slice of the trace on screen; the slice moves in steps so most clock ticks re-render nothing. */
const SLICE = 200

function QueueLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("queue"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<QueueParams>(shared?.p ?? first.params)
  const [mode, setMode] = useState<Mode>(shared?.mode ?? first.mode)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tab, setTab] = useState("packets")
  const [tour, setTour] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("queue", "source"), [sim])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

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

  const fig = useMemo(() => pathAt(p, run, tl.t, selected), [p, run, tl.t, selected])
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
  const switchMode = (m: Mode) => {
    setMode(m)
    if (tab === MODE_TAB[mode].id) setTab(MODE_TAB[m].id)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    switchMode(pr.mode)
    tl.pause()
    tl.seek(at)
  }
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
  const caption = `${title}, at ${us(tl.t)}`
  const choices = PRESETS.filter((pr) => pr.mode === mode)

  return (
    <section
      ref={root}
      tabIndex={-1}
      className="nv-tool space-y-5 outline-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label="What to study"
        value={mode}
        onValueChange={(v) => {
          if (!v) return
          const m = v as Mode
          load(PRESETS.find((pr) => pr.mode === m)!.id)
          setTour(null)
        }}
        className="flex-wrap"
      >
        {MODES.map((m) => (
          <ToggleGroupItem key={m.id} value={m.id} className="px-3">
            {m.title}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="queue-preset">
            Scenario
          </label>
          <Select value={preset || "custom"} onValueChange={(id) => load(id)}>
            <SelectTrigger id="queue-preset" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((pr) => (
                <SelectItem key={pr.id} value={pr.id}>
                  {pr.title}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Your own setup
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("queue", { p, mode, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: "The path at this moment",
              stem: `queue-${preset || "custom"}-path`,
              svg: () => pathSvg({ ...fig, caption }),
              tikz: () => pathTikz({ ...fig, caption }),
            },
            {
              label: chart.title,
              stem: `queue-${preset || "custom"}-${mode}`,
              ...chartExports(() => chartFigure(chart, duration, `${title}: ${chart.title.toLowerCase()}`)),
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
            <Button size="sm" variant="ghost" onClick={() => tl.toggle()}>
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
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <PathView fig={fig} label={`${caption}: ${fig.waiting.length} packets waiting, ${fig.delivered} arrived, ${fig.dropped} lost`} />
          <p className="font-sans text-xs text-muted-foreground">
            Packets go left to right: {p.flows.some((f) => f.shaper.kind !== "none") ? "through the shaper, " : ""}into the router, where
            they are processed, wait in the queue (the next to go on the right), and are pushed onto the link; then they cross it at the
            signal's speed. Each block on the wire is one packet, as long as the stretch of link its bits occupy. Space plays, arrow keys
            step, Home and End jump.
          </p>
          <Transport tl={tl} events={run.events.length} />
          <LineChart
            title={chart.title}
            series={chart.series}
            xLabel="time (ms)"
            yLabel={chart.yLabel}
            xFormat={(v) => String(Number((v / 1000).toPrecision(4)))}
            yFormat={chart.yFormat}
            xDomain={[0, duration]}
            yDomain={chart.yDomain}
            height={220}
            cursor={tl.t}
            onSeek={(t) => tl.seek(t)}
          >
            {(s) => <RefLines s={s} refs={chart.refs} />}
          </LineChart>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
            <p className="font-sans text-xs text-muted-foreground">
              {us(event.t)}, {packetName(p, run.packets[event.packet]).toLowerCase()}
            </p>
            <p className="mt-0.5">
              <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {trace[index].text}
            </p>
          </div>
          <Totals run={run} p={p} />
          <EquationCard mode={mode} p={p} run={run} t={tl.t} running={running} focus={focus} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="packets">Packets</TabsTrigger>
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value={MODE_TAB[mode].id}>{MODE_TAB[mode].title}</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="packets">
              <PacketTable p={p} run={run} t={tl.t} selected={selected} onPick={pick} />
            </TabsContent>
            <TabsContent value="trace">
              <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} />
              {run.events.length > traceSlice.length && (
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Events {offset + 1} to {offset + traceSlice.length} of {run.events.length}; the list follows the clock.
                </p>
              )}
            </TabsContent>
            <TabsContent value="sweep">{tab === "sweep" && <SweepPanel sim={sim} p={p} />}</TabsContent>
            <TabsContent value="shaper">
              {tab === "shaper" && <ShaperPanel p={p} run={run} end={duration} cursor={tl.t} onSeek={(t) => tl.seek(t)} />}
            </TabsContent>
            <TabsContent value="scheduler">
              {tab === "scheduler" && <SchedulerPanel p={p} run={run} end={duration} cursor={tl.t} onSeek={(t) => tl.seek(t)} />}
            </TabsContent>
            <TabsContent value="setup">
              <QueueSetup p={params} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/queue.rs), compiled into the page. The step behind the current event is
                shaded.
              </p>
              <LiterateSource source={source} active={tab === "source" ? event.step : null} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
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
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Article sim={sim} p={p} run={run} onLoad={(id) => load(id)} />
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
