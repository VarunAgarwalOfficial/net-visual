import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, useWidth } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
import {
  LABS,
  MODES,
  PRESETS,
  TOUR,
  eventTimes,
  fmtTime,
  frameNs,
  linkDuration,
  runLink,
  type LinkParams,
  type LinkRun,
  type Mode,
} from "../../core/link"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import { linkFor, readHash } from "../../core/share"
import { LinkAnalysis, LinkFrontier, LinkInternals, LinkIntro, LinkMechanics } from "./LinkArticle"
import { alohaFigure, caFigure, cdFigure } from "./linkFigures"
import {
  AlohaFrames,
  CaStations,
  CdBackoffs,
  EquationCard,
  LinkSetup,
  RefLines,
  ShapeView,
  Totals,
  chartFigure,
  eventText,
  eventWho,
  modeChart,
} from "./LinkViews"
import { figSvg, figTikz, type ShapeFigure } from "./shapes"

interface Shared {
  p: LinkParams
  t?: number
}

/** Link layer and wireless: ALOHA, CSMA/CD with binary exponential backoff, and 802.11 CSMA/CA. */
export function LinkTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <LinkLoaded sim={sim} />
}

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
/** The tab that belongs to each mode. */
const MODE_TAB: Record<Mode, { id: string; title: string }> = {
  aloha: { id: "frames", title: "Frames" },
  csmacd: { id: "backoff", title: "Backoff" },
  csmaca: { id: "stations", title: "Stations" },
}
/** Stable time formatters, so the memoised trace rows do not re-render. */
const FORMAT: Record<Mode, (t: number) => string> = {
  aloha: (t) => fmtTime(t, "aloha"),
  csmacd: (t) => fmtTime(t, "csmacd"),
  csmaca: (t) => fmtTime(t, "csmaca"),
}
/** Events in each slice of the trace on screen; the slice moves in steps so most clock ticks re-render nothing. */
const SLICE = 200

const HELP: Record<Mode, string> = {
  aloha:
    "One row per station, time left to right. A frame is drawn as it is sent: solid when it got through, red when another frame overlapped it. The shaded band is the latest frame's vulnerable window: any other start inside it destroys the frame.",
  csmacd:
    "Position along the cable across, time down. Each transmission spreads both ways along the cable at the speed of the signal, so it fills a widening band; a station hears another only once that band reaches its line. Red is the jam after a collision is heard.",
  csmaca:
    "The map shows who hears whom (dashed lines join nodes in range) and, while a frame is on the air, its sender's range. Below, one lane per node: frames on the air, red when lost at their receiver, and dashed bars where the node's NAV holds it silent.",
}

function rateFor(p: LinkParams, duration: number): number {
  // Real seconds per frame at speed 1: half a second for ALOHA's frames, a second and a half for an Ethernet frame, a millisecond of air per second for Wi-Fi.
  const base = p.mode === "aloha" ? 2 * p.aloha.frame_us : p.mode === "csmacd" ? frameNs(p.cd) / 1.5 : 1000
  return Math.max(base, duration / 300)
}

function figureFor(p: LinkParams, r: LinkRun, t: number, w: number): { fig: ShapeFigure; label: string } {
  if (p.mode === "aloha" && r.mode === "aloha") {
    const f = alohaFigure(p.aloha, r.run, t, w)
    return { fig: f, label: `${f.onAir} frames on the air, ${f.delivered} delivered and ${f.garbled} lost so far` }
  }
  if (p.mode === "csmacd" && r.mode === "csmacd") {
    const f = cdFigure(p.cd, r.run, t, w)
    return { fig: f, label: `Space-time diagram of the cable: ${f.collisions} collisions so far` }
  }
  if (p.mode === "csmaca" && r.mode === "csmaca") {
    const f = caFigure(p.ca, r.run, t, w)
    return { fig: f, label: f.onAir.length ? `On the air: ${f.onAir.join(", ")}` : "The medium is idle" }
  }
  throw new Error("settings and run disagree on the mode")
}

function LinkLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("link"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<LinkParams>(shared?.p ?? first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tab, setTab] = useState("trace")
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const [figBox, width] = useWidth<HTMLDivElement>()

  const source = useMemo(() => sim.call<string>("link", "source"), [sim])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: LinkParams; run: LinkRun }>(() => ({ p: params, run: runLink(sim, params) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runLink(sim, params) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run, p } = good
  const mode = p.mode
  const fmt = FORMAT[mode]

  const times = useMemo(() => eventTimes(run), [run])
  const duration = useMemo(() => linkDuration(p), [p])
  const tl = useTimeline(times, duration, rateFor(p, duration), shared?.t ?? 0)
  const index = Math.max(0, tl.index)
  const event = run.run.events[index]

  const { fig, label } = useMemo(() => figureFor(p, run, tl.t, Math.max(320, Math.round(width))), [p, run, tl.t, width])
  const chart = useMemo(() => modeChart(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.run.events.map((e, i) => ({ t: e.t, step: e.step, text: eventText(p, run, i) })), [p, run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const apply = (next: LinkParams, id = "") => {
    if (next.mode !== params.mode && tab === MODE_TAB[params.mode].id) setTab(MODE_TAB[next.mode].id)
    setParams(next)
    setPreset(id)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
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
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    root.current?.focus({ preventScroll: true })
  }, [])
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  const caption = `${title}, at ${fmt(tl.t)}`
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
        aria-label="Which protocol"
        value={mode}
        onValueChange={(v) => {
          if (!v) return
          load(PRESETS.find((pr) => pr.mode === v)!.id)
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
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="link-preset">
            Scenario
          </label>
          <Select value={preset || "custom"} onValueChange={(id) => load(id)}>
            <SelectTrigger id="link-preset" className="w-full max-w-md">
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
          link={() => linkFor("link", { p, t: Math.round(tl.t) } satisfies Shared)}
          figures={[
            {
              label: mode === "csmacd" ? "The space-time diagram at this moment" : "The channel at this moment",
              stem: `link-${preset || "custom"}-figure`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: chart.title,
              stem: `link-${preset || "custom"}-chart`,
              ...chartExports(() => chartFigure(chart, `${title}: ${chart.title.toLowerCase()}`)),
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
          <div ref={figBox}>
            <ShapeView fig={fig} label={`${caption}. ${label}`} />
          </div>
          <p className="font-sans text-xs text-muted-foreground">{HELP[mode]} Space plays, arrow keys step, Home and End jump.</p>
          <Transport tl={tl} events={run.run.events.length} format={fmt} />
          <LineChart
            title={chart.title}
            series={chart.series}
            xLabel={chart.xLabel}
            yLabel={chart.yLabel}
            xFormat={chart.xFormat}
            yFormat={chart.yFormat}
            xDomain={chart.xDomain}
            yDomain={chart.yDomain}
            height={220}
            cursor={chart.timed ? tl.t : undefined}
            onSeek={chart.timed ? (t) => tl.seek(t) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </div>

        <div className="min-w-0 space-y-4">
          {event && (
            <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
              <p className="font-sans text-xs text-muted-foreground">
                {fmt(event.t)}, {eventWho(p, run, index)}
              </p>
              <p className="mt-0.5">
                <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {eventText(p, run, index)}
              </p>
            </div>
          )}
          <Totals p={p} r={run} />
          <EquationCard p={p} r={run} t={tl.t} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value={MODE_TAB[mode].id}>{MODE_TAB[mode].title}</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmt} />
              {run.run.events.length > traceSlice.length && (
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Events {offset + 1} to {offset + traceSlice.length} of {run.run.events.length}; the list follows the clock.
                </p>
              )}
            </TabsContent>
            <TabsContent value="frames">{tab === "frames" && run.mode === "aloha" && <AlohaFrames run={run.run} t={tl.t} />}</TabsContent>
            <TabsContent value="backoff">
              {tab === "backoff" && p.mode === "csmacd" && run.mode === "csmacd" && <CdBackoffs p={p.cd} run={run.run} t={tl.t} />}
            </TabsContent>
            <TabsContent value="stations">
              {tab === "stations" && p.mode === "csmaca" && run.mode === "csmaca" && <CaStations p={p.ca} run={run.run} t={tl.t} />}
            </TabsContent>
            <TabsContent value="setup">
              <LinkSetup p={params} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/link.rs), compiled into the page. The step behind the current event is
                shaded.
              </p>
              <LiterateSource source={source} active={tab === "source" && event ? event.step : null} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
              <LabPanel
                labs={LABS}
                load={(start) => {
                  // Lab starts are copies, so match a scenario by its settings.
                  const key = JSON.stringify(start)
                  const pr = PRESETS.find((q) => q.mode === start.mode && JSON.stringify(q.params) === key)
                  apply(start, pr?.id ?? "")
                  setTour(null)
                  tl.home()
                }}
                check={(lab) => LABS.find((l) => l.id === lab.id)!.check(p, run)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <Article sim={sim} onLoad={onLoad} />
    </section>
  )
}

const Article = memo(function Article({ sim, onLoad }: { sim: Netsim; onLoad(id: string): void }) {
  return (
    <>
      <LinkIntro onLoad={onLoad} />
      <LinkMechanics />
      <LinkAnalysis sim={sim} />
      <LinkFrontier />
      <LinkInternals />
    </>
  )
})
