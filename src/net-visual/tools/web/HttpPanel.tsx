// The HTTP modes of "Naming and the web": page loads over HTTP/1.0, 1.1, 2
// and 3, with a stream view, a packet ladder, live equations and sweeps.
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
  HTTP_LABS,
  HTTP_PRESETS,
  HTTP_STEPS,
  HTTP_TOUR,
  MS,
  fmtNs,
  runHttp,
  type HttpMode,
  type HttpRun,
  type HttpWeb,
} from "../../core/http"
import type { Netsim } from "../../core/netsim"
import { linkFor } from "../../core/share"
import { RefLines, ShapeView, chartFigure } from "../link/LinkViews"
import { figSvg, figTikz } from "../link/shapes"
import { HttpAnalysis, HttpFrontier, HttpInternals, HttpIntro, HttpMechanics } from "./HttpArticle"
import { ladderFigure, streamsFigure } from "./httpFigures"
import { HttpEquations, HttpObjects, HttpSetup, HttpTotals, httpChart } from "./HttpViews"
import { ModeSwitch, type AnyMode } from "./ModeSwitch"

/** What a shared link carries for the HTTP modes: the setup and the clock in µs. */
export interface HttpShared {
  h: HttpWeb
  t?: number
}

type View = "streams" | "ladder"
const DEFAULT_VIEW: Record<HttpMode, View> = { connections: "ladder", hol: "streams", handshake: "ladder" }

const HELP: Record<View, string> = {
  streams:
    "One row per object. Upper ticks are packets as they arrive, lower ticks as they are handed to the browser; a red bar is data that has arrived but is held behind a gap, and a cross marks a lost packet. Dashed red lines mark each loss across every row.",
  ladder:
    "Client on the left, server on the right, time running down. Grey lines are handshakes, dark ones requests, coloured ones data packets (one colour per object). A cross is a lost packet, a dashed line its retransmission, and a red dot the moment the server noticed.",
}

const SLICE = 200
/** Seconds of real time to play a whole page load at speed 1. */
const PLAY_SECONDS = 12

export function HttpPanel({
  sim,
  shared,
  startMode,
  onSwitch,
}: {
  sim: Netsim
  shared?: HttpShared
  startMode?: HttpMode
  onSwitch(m: AnyMode): void
}) {
  const first = HTTP_PRESETS.find((pr) => pr.mode === (startMode ?? HTTP_PRESETS[0].mode))!
  const [params, setParams] = useState<HttpWeb>(shared?.h ?? first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [view, setView] = useState<View>(DEFAULT_VIEW[params.mode])
  const [tab, setTab] = useState("trace")
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const [figBox, width] = useWidth<HTMLDivElement>()

  const [good, setGood] = useState<{ p: HttpWeb; run: HttpRun }>(() => ({ p: params, run: runHttp(sim, params.http) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    setTried(params)
    try {
      setGood({ p: params, run: runHttp(sim, params.http) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run, p } = good
  const mode = p.mode
  const source = useMemo(() => sim.call<string>("http", "source"), [sim])

  // The clock runs in microseconds of simulated time.
  const n = run.events.length
  const times = useMemo(() => run.events.map((e) => e.t / 1000), [run])
  const duration = Math.max(1, run.stats.plt_ns / 1000)
  const tl = useTimeline(times, duration, duration / PLAY_SECONDS, shared?.t ?? 0)
  const tNs = Math.round(tl.t * 1000)
  const index = Math.max(0, Math.min(n - 1, tl.index))
  const event = run.events[index]

  const w = Math.max(320, Math.round(width))
  const fig = useMemo(
    () => (view === "streams" ? streamsFigure(p.http, run, tNs, w) : ladderFigure(p.http, run, tNs, w)),
    [view, p, run, tNs, w],
  )
  const chart = useMemo(() => httpChart(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.events.map((e) => ({ t: e.t, step: e.step, text: e.text })), [run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const focusRoot = () => setTimeout(() => root.current?.focus({ preventScroll: true }), 0)
  const apply = (next: HttpWeb, id = "") => {
    if (next.mode !== params.mode) setView(DEFAULT_VIEW[next.mode])
    setParams(next)
    setPreset(id)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = HTTP_PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    tl.pause()
    tl.seek(at)
  }
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
    focusRoot()
    if (i === null) return
    load(HTTP_TOUR[i].preset, HTTP_TOUR[i].at)
  }

  const presetInfo = HTTP_PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  const figLabel = view === "streams" ? "Each object's bytes, arrived and delivered" : "Handshakes, requests and packets"
  const caption = `${title}, at ${fmtNs(tNs)}: ${fig.summary}`
  const choices = HTTP_PRESETS.filter((pr) => pr.mode === mode)
  const other: View = view === "streams" ? "ladder" : "streams"
  const otherFig = () => (other === "streams" ? streamsFigure(p.http, run, tNs, w) : ladderFigure(p.http, run, tNs, w))
  const who = event
    ? [
        event.conn !== null && run.conns.length > 1 ? `connection ${event.conn + 1}` : "",
        event.obj !== null ? run.objects[event.obj].name : "",
      ]
        .filter(Boolean)
        .join(", ")
    : ""

  return (
    <section
      ref={root}
      tabIndex={-1}
      className="nv-tool space-y-5 outline-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      <ModeSwitch
        mode={mode}
        onPick={(v) => {
          setTour(null)
          focusRoot()
          if (v === "connections" || v === "hol" || v === "handshake") load(HTTP_PRESETS.find((pr) => pr.mode === v)!.id)
          else onSwitch(v)
        }}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="http-preset">
            Scenario
          </label>
          <Select
            value={preset || "custom"}
            onValueChange={(id) => {
              load(id)
              focusRoot()
            }}
          >
            <SelectTrigger id="http-preset" className="w-full max-w-md">
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
        <div>
          <p className="mb-1 font-sans text-xs text-muted-foreground" id="http-view">
            View
          </p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-labelledby="http-view"
            value={view}
            onValueChange={(v) => {
              if (v === "streams" || v === "ladder") setView(v)
              focusRoot()
            }}
          >
            <ToggleGroupItem value="streams" className="px-3">
              Streams
            </ToggleGroupItem>
            <ToggleGroupItem value="ladder" className="px-3">
              Packets
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("web", { h: p, t: Math.round(tl.t) } satisfies HttpShared)}
          figures={[
            {
              label: figLabel,
              stem: `http-${preset || "custom"}-${view}`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: other === "streams" ? "Each object's bytes, arrived and delivered" : "Handshakes, requests and packets",
              stem: `http-${preset || "custom"}-${other}`,
              svg: () => {
                const f = otherFig()
                return figSvg({ ...f, caption: `${title}, at ${fmtNs(tNs)}: ${f.summary}` })
              },
              tikz: () => {
                const f = otherFig()
                return figTikz({ ...f, caption: `${title}, at ${fmtNs(tNs)}: ${f.summary}` })
              },
            },
            {
              label: chart.title,
              stem: `http-${preset || "custom"}-chart`,
              ...chartExports(() => chartFigure(chart, `${title}: ${chart.title.toLowerCase()}`)),
            },
          ]}
        />
      </div>

      {tour !== null ? (
        <div className="rounded-sm border border-border bg-muted/40 p-4" aria-live="polite">
          <p className="font-sans text-xs text-muted-foreground">
            Tour, {tour + 1} of {HTTP_TOUR.length}
          </p>
          <p className="mt-1 max-w-[70ch]">{HTTP_TOUR[tour].text}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" disabled={tour === 0} onClick={() => goTour(tour - 1)}>
              Back
            </Button>
            <Button size="sm" onClick={() => goTour(tour + 1 < HTTP_TOUR.length ? tour + 1 : null)}>
              {tour + 1 < HTTP_TOUR.length ? "Next" : "Finish"}
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
            <ShapeView fig={fig} label={caption} />
          </div>
          <p className="font-sans text-xs text-muted-foreground">{HELP[view]} Space plays, arrow keys step, Home and End jump.</p>
          <Transport tl={tl} events={n} format={(x) => fmtNs(x * 1000)} />
          <LineChart
            title={chart.title}
            series={chart.series}
            xLabel={chart.xLabel}
            yLabel={chart.yLabel}
            xFormat={chart.xFormat}
            yFormat={chart.yFormat}
            xDomain={chart.xDomain}
            yDomain={chart.yDomain}
            height={240}
            cursor={chart.timed ? tNs / MS : undefined}
            onSeek={chart.timed ? (x) => tl.seek(x * 1000) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </div>

        <div className="min-w-0 space-y-4">
          {event && (
            <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
              <p className="font-sans text-xs text-muted-foreground">
                {fmtNs(event.t)}
                {who ? `, ${who}` : ""}
              </p>
              <p className="mt-0.5">
                <b className="lining">{event.step}.</b> [{HTTP_STEPS[event.step] ?? ""}] {event.text}
              </p>
            </div>
          )}
          <HttpTotals run={run} />
          <HttpEquations w={p} run={run} t={tNs} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value="objects">Objects</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmtNs} />
              {n > traceSlice.length && (
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Events {offset + 1} to {offset + traceSlice.length} of {n}; the list follows the clock.
                </p>
              )}
            </TabsContent>
            <TabsContent value="objects">{tab === "objects" && <HttpObjects run={run} />}</TabsContent>
            <TabsContent value="setup">
              <HttpSetup w={params} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/http.rs), compiled into the page. The step behind the current event is
                shaded.
              </p>
              <LiterateSource source={source} active={tab === "source" && event ? event.step : null} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
              <LabPanel
                labs={HTTP_LABS}
                load={(start) => {
                  const key = JSON.stringify(start)
                  const pr = HTTP_PRESETS.find((q) => JSON.stringify(q.params) === key)
                  apply(start, pr?.id ?? "")
                  setTour(null)
                  tl.home()
                }}
                check={(lab) => HTTP_LABS.find((l) => l.id === lab.id)!.check(p, run)}
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
      <HttpIntro onLoad={onLoad} />
      <HttpMechanics />
      <HttpAnalysis sim={sim} />
      <HttpFrontier />
      <HttpInternals />
    </>
  )
})
