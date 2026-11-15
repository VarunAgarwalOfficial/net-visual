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
import { ModeSwitch, type AnyMode } from "./ModeSwitch"
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
  const [pick, setPick] = useState<{ mode: AnyMode | null; n: number }>({ mode: null, n: 0 })
  const http = pick.mode === null ? "http" in start : isHttpMode(pick.mode)
  const onSwitch = useCallback((mode: AnyMode) => setPick((q) => ({ mode, n: q.n + 1 })), [])
  if (http)
    return (
      <HttpPanel
        key={pick.n}
        sim={sim}
        shared={pick.mode === null ? start.http : undefined}
        startMode={pick.mode === null ? undefined : (pick.mode as HttpMode)}
        onSwitch={onSwitch}
      />
    )
  return (
    <DnsPanel
      key={pick.n}
      sim={sim}
      shared={pick.mode === null ? start.dns : undefined}
      startMode={pick.mode === null ? undefined : (pick.mode as WebMode)}
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
    "One lookup at a time: a column per machine, time running down. Grey lines are queries, blue referrals, green answers, orange a CNAME and red a denial. A small square marks a record set cached. The clock steps from event to event; the card gives each one's real time.",
  cache:
    "The ladder shows the lookup behind the current event; most are answered by the resolver in one round trip. The chart sweeps λT with the same zones and compares the measured hit ratio with the formula, or, with several names, counts the queries each level of server received.",
  ttl: "The ladder shows the lookup behind the current event. In the chart the line is the TTL left on the resolver's copy, falling to zero at each expiry; dots are answers, red where the address was already out of date.",
}

const FIGURE_LABEL = "The lookup at this moment"

function DnsPanel({ sim, shared, startMode, onSwitch }: { sim: Netsim; shared?: Shared; startMode?: WebMode; onSwitch(m: AnyMode): void }) {
  const first = PRESETS.find((pr) => pr.mode === (startMode ?? PRESETS[0].mode))!
  const [params, setParams] = useState<WebParams>(shared?.p ?? first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [tab, setTab] = useState("trace")
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

  const fig = useMemo(() => ladderFigure(p.dns, run, index, Math.max(320, Math.round(width))), [p, run, index, width])
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
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" })
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
  const caption = `${title}, at ${event ? fmtUs(event.t) : "0 s"}: ${fig.summary}`
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
      <ModeSwitch
        mode={mode}
        onPick={(v) => {
          setTour(null)
          focusRoot()
          if (isHttpMode(v)) onSwitch(v)
          else load(PRESETS.find((pr) => pr.mode === v)!.id)
        }}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="web-preset">
            Scenario
          </label>
          <Select
            value={preset || "custom"}
            onValueChange={(id) => {
              load(id)
              focusRoot()
            }}
          >
            <SelectTrigger id="web-preset" className="w-full max-w-md">
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
          <p className="mb-1 font-sans text-xs text-muted-foreground" id="web-resolve">
            Resolution
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
          >
            <ToggleGroupItem value="iterative" className="px-3">
              Iterative
            </ToggleGroupItem>
            <ToggleGroupItem value="recursive" className="px-3">
              Recursive
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("web", { p, i: index } satisfies Shared)}
          figures={[
            {
              label: FIGURE_LABEL,
              stem: `dns-${preset || "custom"}-ladder`,
              svg: () => figSvg({ ...fig, caption }),
              tikz: () => figTikz({ ...fig, caption }),
            },
            {
              label: chart.title,
              stem: `dns-${preset || "custom"}-chart`,
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
            <ShapeView fig={fig} label={caption} />
          </div>
          <p className="font-sans text-xs text-muted-foreground">{HELP[mode]} Space plays, arrow keys step, Home and End jump.</p>
          <Transport tl={tl} events={n} format={fmtClock} />
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
            cursor={chart.timed && event ? event.t : undefined}
            onSeek={chart.timed ? (x) => tl.seekIndex(eventAt(run, x)) : undefined}
            overlay={(s) => <RefLines s={s} refs={chart.refs} />}
          />
        </div>

        <div className="min-w-0 space-y-4">
          {event && (
            <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
              <p className="font-sans text-xs text-muted-foreground">
                {fmtUs(event.t)}, {dnsWho(run, index)}
              </p>
              <p className="mt-0.5">
                <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {event.text}
              </p>
            </div>
          )}
          <DnsTotals p={p.dns} run={run} />
          <DnsEquations w={p} run={run} index={index} />

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value="caches">Caches</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="trace">
              <TraceList events={traceSlice} index={tl.index - offset} onSeek={(i) => tl.seekIndex(i + offset)} format={fmtUs} />
              {n > traceSlice.length && (
                <p className="mt-1 font-sans text-xs text-muted-foreground">
                  Events {offset + 1} to {offset + traceSlice.length} of {n}; the list follows the clock.
                </p>
              )}
            </TabsContent>
            <TabsContent value="caches">{tab === "caches" && event && <DnsCaches p={p.dns} run={run} t={event.t} />}</TabsContent>
            <TabsContent value="setup">
              <DnsSetup w={params} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/{SOURCE[mode].file}), compiled into the page. The step behind the current
                event is shaded.
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
      <DnsIntro onLoad={onLoad} />
      <DnsMechanics />
      <DnsAnalysis sim={sim} />
      <DnsFrontier />
      <DnsInternals />
    </>
  )
})
