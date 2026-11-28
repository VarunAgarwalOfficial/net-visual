// The HTTP modes of "Naming and the web": page loads over HTTP/1.0, 1.1, 2
// and 3, with a stream view, a packet ladder, live equations and sweeps.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { chartExports } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, useWidth } from "../../components/LineChart"
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
} from "../../components/ToolFrame"
import { keepFocus, timeIn, timelineKeys, useTimeline } from "../../components/timeline"
import {
  HTTP_LABS,
  HTTP_PRESETS,
  HTTP_STEPS,
  HTTP_TOUR,
  MS,
  fmtNs,
  isHttpMode,
  runHttp,
  type HttpMode,
  type HttpRun,
  type HttpWeb,
} from "../../core/http"
import type { Netsim } from "../../core/netsim"
import { linkFor } from "../../core/share"
import { RefLines, ShapeView, chartFigure, figureWidth } from "../link/LinkViews"
import { figSvg, figTikz } from "../link/shapes"
import { HttpAnalysis, HttpFrontier, HttpInternals, HttpIntro, HttpMechanics } from "./HttpArticle"
import { ladderFigure, streamsFigure } from "./httpFigures"
import { HttpEquations, HttpObjects, HttpSetup, HttpTotals, httpChart } from "./HttpViews"
import { WebPicker, modeOf, type AnyMode } from "./ModeSwitch"

/** What a shared link carries for the HTTP modes: the setup and the clock in µs. */
export interface HttpShared {
  h: HttpWeb
  t?: number
}

type View = "streams" | "ladder"
const DEFAULT_VIEW: Record<HttpMode, View> = { connections: "ladder", hol: "streams", handshake: "ladder" }

const HELP: Record<View, string> = {
  streams:
    "One row per object, a file the page needs, with its size; time left to right. Upper ticks are packets as they arrive, lower ticks as they are handed to the browser; a red bar is data that has arrived but is held behind a gap, and a cross marks a lost packet. Dashed red lines mark each loss across every row.",
  ladder:
    "The client (the browser) on the left, the server on the right, time running down. Light brown lines are handshakes: SYN, SYN-ACK and ACK open a TCP (Transmission Control Protocol) connection, and ClientHello, ServerHello and Finished set up its encryption (TLS, Transport Layer Security). Dark lines are requests, and blue ones data packets, alternate objects thin and thick. Where there are several connections, [1], [2] and so on say which one a line belongs to. A cross is a lost packet, a dashed line its retransmission, and a red dot the moment the server noticed.",
}

const SLICE = 200
/** Seconds of real time to play a whole page load at speed 1. */
const PLAY_SECONDS = 12

export function HttpPanel({
  sim,
  shared,
  startMode,
  startPreset,
  onSwitch,
}: {
  sim: Netsim
  shared?: HttpShared
  startMode?: HttpMode
  startPreset?: string
  onSwitch(m: AnyMode, preset?: string): void
}) {
  const first =
    HTTP_PRESETS.find((pr) => pr.id === startPreset) ?? HTTP_PRESETS.find((pr) => pr.mode === (startMode ?? HTTP_PRESETS[0].mode))!
  const [params, setParams] = useState<HttpWeb>(shared?.h ?? first.params)
  const [preset, setPreset] = useState<string>(() =>
    shared ? (HTTP_PRESETS.find((q) => JSON.stringify(q.params) === JSON.stringify(shared.h))?.id ?? "") : first.id,
  )
  const [view, setView] = useState<View>(DEFAULT_VIEW[params.mode])
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
  const source = useMemo(() => sim.call<string>("http", "source"), [sim])

  // The clock runs in microseconds of simulated time.
  const n = run.events.length
  const times = useMemo(() => run.events.map((e) => e.t / 1000), [run])
  const duration = Math.max(1, run.stats.plt_ns / 1000)
  const tl = useTimeline(times, duration, duration / PLAY_SECONDS, shared?.t ?? 0)
  const tNs = Math.round(tl.t * 1000)
  // Before the first event the pictures are empty, even where events fall at 0 ns.
  const figT = tl.index < 0 ? -1 : tNs
  const index = Math.max(0, Math.min(n - 1, tl.index))
  const event = run.events[index]

  const w = figureWidth(width, 10)
  const fig = useMemo(
    () => (view === "streams" ? streamsFigure(p.http, run, figT, w) : ladderFigure(p.http, run, figT, w)),
    [view, p, run, figT, w],
  )
  const chart = useMemo(() => httpChart(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.events.map((e) => ({ t: e.t, step: e.step, text: e.text })), [run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  const focusRoot = () => setTimeout(() => root.current?.focus({ preventScroll: true }), 0)
  // Arriving from the other panel's picker, whose button is now gone: take the keys for the clock.
  const switchedIn = useRef(!!startPreset)
  useEffect(() => {
    if (switchedIn.current) focusRoot()
  }, [])
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
    root.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
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
  const started = tl.index >= 0 && !!event
  const figLabel = view === "streams" ? "each object's bytes, arrived and delivered" : "the handshakes, requests and packets"
  const caption = `${title}, at ${fmtNs(tNs)}: ${fig.summary}`
  const other: View = view === "streams" ? "ladder" : "streams"
  const otherFig = () => (other === "streams" ? streamsFigure(p.http, run, figT, w) : ladderFigure(p.http, run, figT, w))
  const who =
    started && event
      ? [
          event.conn !== null && run.conns.length > 1 ? `connection ${event.conn + 1}` : "",
          event.obj !== null ? run.objects[event.obj].name : "",
        ]
          .filter(Boolean)
          .join(", ")
      : ""
  const stepTitle = started ? (HTTP_STEPS[event.step] ?? "") : ""
  const pickExample = (id: string) => {
    setTour(null)
    const m = modeOf(id)
    if (m && !isHttpMode(m)) onSwitch(m, id)
    else load(id)
    focusRoot()
  }

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Naming and the web"
      className="nv-tool max-w-4xl space-y-4 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      {tour !== null && <TourCard index={tour} steps={HTTP_TOUR} go={goTour} playing={tl.playing} toggle={tl.toggle} />}

      <ExampleIntro title={title} />
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <Transport tl={tl} events={n} stepIs="one packet or message sent or arriving" />

      <figure className="space-y-2">
        <div ref={figBox}>
          <ShapeView fig={fig} label={caption} px={width} />
        </div>
        <figcaption className="max-w-(--site-measure) font-sans text-sm text-muted-foreground">{HELP[view]}</figcaption>
      </figure>
      <div className="space-y-2">
        <p className="font-sans text-sm text-muted-foreground" id="http-view">
          Showing {view === "ladder" ? "packets on the wire" : "streams, each object"}. To draw the page load the other way:
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
          className="flex-wrap"
        >
          <ToggleGroupItem value="ladder" className="px-3">
            Packets on the wire
          </ToggleGroupItem>
          <ToggleGroupItem value="streams" className="px-3">
            Streams: each object
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <AboutExample
        note={presetInfo?.note ?? 'Your own settings for the page load. Open "Change the settings", further down the page, to see them.'}
      />

      <StepCard
        live={!tl.playing}
        when={started ? `At ${timeIn(event.t / 1000, tl.duration)}${who ? `, ${who}` : ""}` : null}
        title={stepTitle ? stepTitle[0].toUpperCase() + stepTitle.slice(1) : undefined}
        text={started ? event.text : undefined}
        empty={
          <>
            Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next</b> to go one step at a time (the arrow keys do the
            same).
          </>
        }
      />

      <Readouts
        caption="So far"
        cols={2}
        items={[
          ["Simulated time", timeIn(tl.t, tl.duration)],
          ["Steps so far", `${started ? tl.index + 1 : 0} of ${n}`],
        ]}
      />
      {started && <p className="max-w-(--site-measure) font-sans text-sm">{fig.summary[0].toUpperCase() + fig.summary.slice(1)}.</p>}

      <WebPicker id="http-preset" value={preset} onPick={pickExample} />

      <div>
        <DeeperHeading />
        <Disclosure title={chart.title} note="The whole run as a chart. Where it runs over time, select a point to jump there.">
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
            upTo={chart.timed ? tNs / MS : undefined}
            onSeek={chart.timed ? (x) => tl.seek(x * 1000) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </Disclosure>
        <Disclosure title="Each object" note="Every file the page needs: its size, when it was asked for and when it was complete.">
          <HttpObjects run={run} />
        </Disclosure>
        <Disclosure
          title="The formulas, with this run's numbers"
          note="What theory predicts for this page load, set beside what the run did."
        >
          <HttpEquations w={p} run={run} t={tNs} />
        </Disclosure>
        <Disclosure title="What the whole run comes to" note="Totals for the full page load, from start to end.">
          <HttpTotals run={run} />
        </Disclosure>
        <Disclosure title="Change the settings" note="The path, the protocol, the objects and the losses; the run follows at once.">
          <HttpSetup w={params} set={(next) => apply(next)} />
        </Disclosure>
        <Disclosure title="Every step, as a list" note="Each event of the run in order. Select one to jump there.">
          <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmtNs} />
          {n > traceSlice.length && (
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              Events {offset + 1} to {offset + traceSlice.length} of {n}; the list follows the clock.
            </p>
          )}
        </Disclosure>
        <Disclosure title="Exercises this page can check" note="Short tasks; each says whether the run on screen meets it." keepMounted>
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
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust code behind the simulation, with the step behind the current event shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">
            From crates/netsim/src/http.rs, compiled into the page. Each step has a letter and number, such as C1; the list of steps above
            uses the same names.
          </p>
          <LiterateSource source={source} active={started ? event.step : null} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={HTTP_TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("web", { h: p, t: Math.round(tl.t) } satisfies HttpShared)}
          figures={[
            {
              label: figLabel,
              stem: `http-${preset || "custom"}-${view}`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: other === "streams" ? "each object's bytes, arrived and delivered" : "the handshakes, requests and packets",
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
              label: `the chart: ${chart.title.toLowerCase()}`,
              stem: `http-${preset || "custom"}-chart`,
              ...chartExports(() => chartFigure(chart, `${title}: ${chart.title.toLowerCase()}`)),
            },
          ]}
        />
      </div>

      <div>
        <DeeperHeading>Read about it</DeeperHeading>
        <Article sim={sim} onLoad={onLoad} />
      </div>
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
