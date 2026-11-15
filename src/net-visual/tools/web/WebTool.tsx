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
  ExampleIntro,
  Readouts,
  StepCard,
  TourAndSharing,
  TourCard,
  scrollBehavior,
} from "../../components/ToolFrame"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
import { LABS, PRESETS, SOURCE, TOUR, eventAt, fmtUs, runDns, type DnsRun, type WebMode, type WebParams } from "../../core/dns"
import { isHttpMode, type HttpMode } from "../../core/http"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import { linkFor, readHash } from "../../core/share"
import { RefLines, ShapeView, chartFigure } from "../link/LinkViews"
import { figSvg, figTikz } from "../link/shapes"
import { DnsAnalysis, DnsFrontier, DnsInternals, DnsIntro, DnsMechanics } from "./DnsArticle"
import { ladderFigure } from "./dnsFigures"
import { HttpPanel, type HttpShared } from "./HttpPanel"
import { WebPicker, modeOf, type AnyMode } from "./ModeSwitch"
import { DnsCaches, DnsEquations, DnsSetup, DnsTotals, dnsChart, dnsWho } from "./DnsViews"

interface Shared {
  p: WebParams
  i?: number
}

/** Naming and the web: DNS resolution, caches and TTLs; HTTP from 1.0 to 3. */
export function WebTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <WebPage sim={sim} />
}

/** Picks the DNS or HTTP panel; a mode in the other group swaps panels. */
function WebPage({ sim }: { sim: Netsim }) {
  const [start] = useState(() => {
    const h = readHash<Shared | HttpShared>("web")
    return h && "h" in h ? { http: h } : { dns: h ?? undefined }
  })
  const [pick, setPick] = useState<{ mode: AnyMode | null; preset?: string; n: number }>({ mode: null, n: 0 })
  const http = pick.mode === null ? "http" in start : isHttpMode(pick.mode)
  const onSwitch = useCallback((mode: AnyMode, preset?: string) => setPick((q) => ({ mode, preset, n: q.n + 1 })), [])
  if (http)
    return (
      <HttpPanel
        key={pick.n}
        sim={sim}
        shared={pick.mode === null ? start.http : undefined}
        startMode={pick.mode === null ? undefined : (pick.mode as HttpMode)}
        startPreset={pick.preset}
        onSwitch={onSwitch}
      />
    )
  return (
    <DnsPanel
      key={pick.n}
      sim={sim}
      shared={pick.mode === null ? start.dns : undefined}
      startMode={pick.mode === null ? undefined : (pick.mode as WebMode)}
      startPreset={pick.preset}
      onSwitch={onSwitch}
    />
  )
}

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
/** Events in each slice of the trace on screen. */
const SLICE = 200
/** Events a second at speed 1: the clock steps through events, not microseconds, because a lookup's milliseconds and a TTL's minutes share a run. */
const RATE = 1.5

const HELP: Record<WebMode, string> = {
  resolve:
    "One lookup at a time: a column per machine, time running down. Each device asks through its stub, a small resolver that only passes the question on; the resolver does the looking up and keeps what it learns. Grey lines are questions, blue referrals (go and ask this other server), green answers, orange an alias (a CNAME, canonical name, record) and red a reply that the name does not exist. A small square marks a set of records being cached. Names end in a dot, which stands for the root of the name tree. The clock steps from event to event; the card below gives each one's real time.",
  cache:
    "The ladder shows the lookup behind the current event; most are answered by the resolver from its cache, in one round trip. The chart under Go deeper compares the share of lookups the cache answered with what the formula predicts, or, with several names, counts the questions each level of server received.",
  ttl: "The ladder shows the lookup behind the current event. Every cached answer carries a time to live (TTL): how long a cache may keep it. The chart under Go deeper draws the TTL left on the resolver's copy, falling to zero at each expiry; dots are answers, red where the address was already out of date.",
}

const FIGURE_LABEL = "The lookup at this moment"

function DnsPanel({
  sim,
  shared,
  startMode,
  startPreset,
  onSwitch,
}: {
  sim: Netsim
  shared?: Shared
  startMode?: WebMode
  startPreset?: string
  onSwitch(m: AnyMode, preset?: string): void
}) {
  const first = PRESETS.find((pr) => pr.id === startPreset) ?? PRESETS.find((pr) => pr.mode === (startMode ?? PRESETS[0].mode))!
  const [params, setParams] = useState<WebParams>(shared?.p ?? first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tour, setTour] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)
  const [figBox, width] = useWidth<HTMLDivElement>()

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: WebParams; run: DnsRun }>(() => ({ p: params, run: runDns(sim, params.dns) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runDns(sim, params.dns) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run, p } = good
  const mode = p.mode
  const sourceTool = SOURCE[mode].tool
  const source = useMemo(() => sim.call<string>(sourceTool, "source"), [sim, sourceTool])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  const n = run.events.length
  const times = useMemo(() => run.events.map((_, i) => i), [run])
  const tl = useTimeline(times, Math.max(1, n - 1), RATE, shared?.i ?? 0)
  const index = Math.max(0, Math.min(n - 1, tl.index))
  const event = run.events[index]
  const fmtClock = useCallback((x: number) => fmtUs(run.events[Math.max(0, Math.min(n - 1, Math.round(x)))]?.t ?? 0), [run, n])

  // Before the first event the ladder is empty, not the first lookup already finished.
  const figIndex = tl.index < 0 ? -1 : index
  const fig = useMemo(() => ladderFigure(p.dns, run, figIndex, Math.max(320, Math.round(width))), [p, run, figIndex, width])
  const chart = useMemo(() => dnsChart(sim, p, run), [sim, p, run])

  const trace = useMemo(() => run.events.map((e) => ({ t: e.t, step: e.step, text: e.text })), [run])
  const offset = Math.max(0, Math.floor(index / SLICE) * SLICE - SLICE)
  const traceSlice = useMemo(() => trace.slice(offset, offset + 3 * SLICE), [trace, offset])

  // After a mode, scenario or tour button the keys belong to the clock again, not to the button group.
  const focusRoot = () => setTimeout(() => root.current?.focus({ preventScroll: true }), 0)
  const apply = (next: WebParams, id = "") => {
    setParams(next)
    setPreset(id)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    tl.pause()
    // The clock counts events, so find the event at that moment in the run about to replace this one.
    tl.seek(at > 0 ? eventAt(runDns(sim, pr.params.dns), at) : 0)
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
    focusRoot()
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const title = presetInfo?.title ?? "Your own setup"
  const started = tl.index >= 0 && !!event
  const caption = `${title}, at ${started ? fmtUs(event.t) : "0 s"}: ${fig.summary}`
  const stepTitle = started ? (stepTitles.get(event.step) ?? "").replace(/\.$/, "") : ""
  const who = started ? dnsWho(run, index) : ""
  const pickExample = (id: string) => {
    setTour(null)
    const m = modeOf(id)
    if (m && isHttpMode(m)) onSwitch(m, id)
    else load(id)
    focusRoot()
  }

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Naming and the web"
      className="nv-tool max-w-4xl space-y-6 outline-none [&.nv-present]:max-w-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
      }}
    >
      {tour !== null && <TourCard index={tour} steps={TOUR} go={goTour} playing={tl.playing} toggle={tl.toggle} />}

      <ExampleIntro
        title={title}
        note={presetInfo?.note ?? 'Your own settings for the name lookups. Open "Change the settings" below to see them.'}
      />
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          That setting cannot run ({error}); the run shown is the last one that could.
        </p>
      )}

      <Transport tl={tl} events={n} format={fmtClock} />

      <figure className="space-y-2">
        <figcaption className="max-w-[70ch] font-sans text-sm text-muted-foreground">{HELP[mode]}</figcaption>
        <div ref={figBox}>
          <ShapeView fig={fig} label={caption} />
        </div>
      </figure>

      <StepCard
        live={!tl.playing}
        when={started ? `At ${fmtUs(event.t)}${who ? `, ${who}` : ""}` : null}
        title={stepTitle || undefined}
        text={started ? event.text : undefined}
        empty={
          <>
            Nothing has happened yet. Press <b>Play</b> to run the example, or <b>Next event</b> to go one event at a time (the arrow keys
            do the same).
          </>
        }
      />

      <Readouts
        caption="So far"
        cols={2}
        items={[
          ["Simulated time", started ? fmtUs(event.t) : "0 s"],
          ["Events so far", `${started ? tl.index + 1 : 0} of ${n}`],
        ]}
      />
      {started && <p className="max-w-[70ch] font-sans text-sm">{fig.summary[0].toUpperCase() + fig.summary.slice(1)}.</p>}

      <WebPicker id="web-preset" value={preset} onPick={pickExample} />
      <div className="space-y-2">
        <p className="font-sans text-sm text-muted-foreground" id="web-resolve">
          How the servers are asked
        </p>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby="web-resolve"
          value={params.dns.mode}
          onValueChange={(v) => {
            if (v === "iterative" || v === "recursive") apply({ ...params, dns: { ...params.dns, mode: v } })
            focusRoot()
          }}
          className="flex-wrap"
        >
          <ToggleGroupItem value="iterative" className="px-3">
            The resolver asks each (iterative)
          </ToggleGroupItem>
          <ToggleGroupItem value="recursive" className="px-3">
            Each asks the next (recursive)
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

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
            height={220}
            cursor={chart.timed && started ? event.t : undefined}
            upTo={chart.timed ? (started ? event.t : 0) : undefined}
            onSeek={chart.timed ? (x) => tl.seekIndex(eventAt(run, x)) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </Disclosure>
        <Disclosure
          title="Every cache, at this moment"
          note="What the resolver and each device's stub hold now, and how long each entry has left."
        >
          <DnsCaches p={p.dns} run={run} t={started ? event.t : 0} />
        </Disclosure>
        <Disclosure
          title="The formulas, with this run's numbers"
          note="What theory predicts for this example, set beside what the run did."
        >
          <DnsEquations w={p} run={run} index={index} />
        </Disclosure>
        <Disclosure title="What the whole run comes to" note="Totals for the full run, from start to end.">
          <DnsTotals p={p.dns} run={run} />
        </Disclosure>
        <Disclosure
          title="Change the settings"
          note="The devices, the servers, the names and their times to live; the run follows at once."
        >
          <DnsSetup w={params} set={(next) => apply(next)} />
        </Disclosure>
        <Disclosure title="Every step, as a list" note="Each event of the run in order. Select one to jump there.">
          <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmtUs} />
          {n > traceSlice.length && (
            <p className="mt-1 font-sans text-xs text-muted-foreground">
              Events {offset + 1} to {offset + traceSlice.length} of {n}; the list follows the clock.
            </p>
          )}
        </Disclosure>
        <Disclosure title="Exercises this page can check" note="Short tasks; each says whether the run on screen meets it." keepMounted>
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
        </Disclosure>
        <Disclosure
          title="The program that produced this run"
          note="The Rust code behind the simulation, with the step behind the current event shaded."
        >
          <p className="mb-2 font-sans text-xs text-muted-foreground">
            From crates/netsim/src/{SOURCE[mode].file}, compiled into the page. Each step has a letter and number, such as R1; the list of
            steps above uses the same names.
          </p>
          <LiterateSource source={source} active={started ? event.step : null} className="max-h-[32rem]" />
        </Disclosure>
        <TourAndSharing
          root={root}
          tour={tour}
          stops={TOUR.length}
          startTour={() => goTour(0)}
          link={() => linkFor("web", { p, i: index } satisfies Shared)}
          figures={[
            {
              label: FIGURE_LABEL.toLowerCase(),
              stem: `dns-${preset || "custom"}-ladder`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: `the chart: ${chart.title.toLowerCase()}`,
              stem: `dns-${preset || "custom"}-chart`,
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
      <DnsIntro onLoad={onLoad} />
      <DnsMechanics />
      <DnsAnalysis sim={sim} />
      <DnsFrontier />
      <DnsInternals />
    </>
  )
})
