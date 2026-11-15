import { memo, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { chartExports, type ChartFigure } from "../../components/figure"
import { LabPanel } from "../../components/LabPanel"
import { LineChart, type Series } from "../../components/LineChart"
import { LiterateSource } from "../../components/LiterateSource"
import { ToolActions } from "../../components/ToolActions"
import { TraceList } from "../../components/TraceList"
import { Transport } from "../../components/Transport"
import { keepFocus, timelineKeys, useTimeline } from "../../components/timeline"
import { loadNetsim } from "../../core/load"
import type { Netsim } from "../../core/netsim"
import {
  LABS,
  PRESETS,
  TOUR,
  clock,
  epochAt,
  forwardingTo,
  normalise,
  periodic,
  runDuration,
  runRouting,
  showDist,
  stateAfter,
  type RoutingParams,
  type RoutingRun,
} from "../../core/routing"
import { linkFor, readHash } from "../../core/share"
import { toEnd } from "../tcp/CwndChart"
import { Graph, type DijkstraOverlay, type WireMessage } from "./Graph"
import { graphAt, graphSvg, graphTikz } from "./graphFigure"
import { RoutingAnalysis, RoutingFrontier, RoutingInternals, RoutingIntro } from "./RoutingArticle"
import { BellmanCard, DijkstraTable, LinkEditor, MapCard, RoutingSetup, VectorMatrix } from "./RoutingViews"

interface Shared {
  p: RoutingParams
  t?: number
  dest?: number
}

/** Routing: distance vector and link state on the same network. */
export function RoutingTool() {
  const [sim, setSim] = useState<Netsim | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadNetsim().then(setSim, (e: Error) => setError(e.message))
  }, [])
  if (error) return <p role="alert">The simulation could not load: {error}</p>
  if (!sim) return <p className="font-sans text-sm text-muted-foreground">Loading the simulation…</p>
  return <RoutingLoaded sim={sim} />
}

const STEP_RE = /([A-Z]\d+)\.\s\[([^\]]+)\]/g
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"]

/** Each router's cost to the destination over time, as step series. */
function distanceSeries(run: RoutingRun, p: RoutingParams, dest: number, end: number) {
  const top = Math.max(4, ...run.events.flatMap((e) => e.dist.map((row) => row[dest]).filter((d) => d < p.infinity)))
  const cap = Math.min(p.infinity, Math.ceil(top * 1.12) + 1)
  const series: Series[] = []
  p.nodes.forEach((n, x) => {
    if (x === dest) return
    const pts: [number, number][] = []
    for (const e of run.events) {
      const d = Math.min(cap, e.dist[x][dest])
      if (!pts.length || pts[pts.length - 1][1] !== d) pts.push([e.t, d])
    }
    series.push({
      id: n,
      label: n,
      color: COLORS[series.length % COLORS.length],
      kind: "step",
      points: toEnd(pts, end),
      dashed: series.length >= COLORS.length,
    })
  })
  return { series, cap }
}

function RoutingLoaded({ sim }: { sim: Netsim }) {
  const shared = useMemo(() => readHash<Shared>("routing"), [])
  const first = PRESETS[0]
  const [params, setParams] = useState<RoutingParams>(shared?.p ? normalise(shared.p) : first.params)
  const [preset, setPreset] = useState<string>(shared ? "" : first.id)
  const [dest, setDest] = useState(Math.min(shared?.dest ?? first.dest, params.nodes.length - 1))
  const [router, setRouter] = useState(0)
  const [link, setLink] = useState<[number, number] | null>(null)
  const [tab, setTab] = useState("tables")
  const [tour, setTour] = useState<number | null>(null)
  const [dijSource, setDijSource] = useState(0)
  const [dijStep, setDijStep] = useState<number | null>(null)
  const root = useRef<HTMLElement>(null)

  const source = useMemo(() => sim.call<string>("routing", "source"), [sim])
  const stepTitles = useMemo(() => new Map([...source.matchAll(STEP_RE)].map((m) => [m[1], m[2]])), [source])

  // A setting the model refuses leaves the last good run on screen with the reason.
  const [good, setGood] = useState<{ p: RoutingParams; run: RoutingRun }>(() => ({ p: params, run: runRouting(sim, params) }))
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(params)
  if (tried !== params) {
    // Adjusting state while rendering, as React documents for derived state.
    setTried(params)
    try {
      setGood({ p: params, run: runRouting(sim, params) })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { run } = good
  const p = good.p

  const times = useMemo(() => run.events.map((e) => e.t), [run])
  const duration = useMemo(() => runDuration(run, p), [run, p])
  // A round of messages in about a second; with RIP's timer, a period in a second and a half.
  const timed = periodic(p)
  const tl = useTimeline(times, duration, timed ? p.period_us / 1.5 : p.delay_us / 1.2, shared?.t ?? 0)
  const ls = p.algorithm === "ls"
  const index = Math.max(0, tl.index)
  const event = run.events[index]
  const epoch = epochAt(run, event.t)
  const state = useMemo(() => stateAfter(run, p, index), [run, p, index])
  const d = Math.min(dest, p.nodes.length - 1)
  const x = Math.min(router, p.nodes.length - 1)

  // The event that sent each message: the first whose count of messages sent passes its id.
  const sendIndex = useMemo(() => {
    const m = new Map<number, number>()
    let i = 0
    for (const msg of run.messages) {
      while (i < run.events.length - 1 && run.events[i].sent <= msg.id) i++
      m.set(msg.id, i)
    }
    return m
  }, [run])
  const arriveIndex = useMemo(() => {
    const m = new Map<number, number>()
    run.events.forEach((e, i) => {
      if (e.message !== null) m.set(e.message, i)
    })
    return m
  }, [run])

  const wire: WireMessage[] = []
  const onLink = new Map<string, WireMessage>()
  for (const m of run.messages) {
    if (m.t_send > tl.t || (sendIndex.get(m.id) ?? 0) > index) continue
    const arrived = arriveIndex.get(m.id)
    if (arrived !== undefined ? arrived <= index : tl.t >= m.t_arrive) continue
    const frac = Math.min(1, Math.max(0, (tl.t - m.t_send) / Math.max(1, m.t_arrive - m.t_send)))
    const label = m.lsa ? `${p.nodes[m.lsa.origin]} #${m.lsa.seq}` : m.omitted.includes(d) ? "–" : showDist(m.vector[d], p.infinity)
    // Flooding puts several LSAs on a link at once: draw them as one box with a count.
    const prev = m.lsa ? onLink.get(`${m.from}-${m.to}`) : undefined
    if (prev && Math.abs(prev.frac - frac) < 0.08 && prev.lost === m.lost) {
      const more = prev.label.match(/ \+(\d+)$/)
      prev.label = more ? prev.label.replace(/\d+$/, String(Number(more[1]) + 1)) : `${prev.label} +1`
      continue
    }
    const w = { id: m.id, from: m.from, to: m.to, frac, label, poisoned: m.poisoned.includes(d) || m.omitted.includes(d), lost: m.lost }
    wire.push(w)
    onLink.set(`${m.from}-${m.to}`, w)
  }

  const fig = useMemo(() => graphAt(run, p, index, d), [run, p, index, d])
  const loops = forwardingTo(event.hop, d)
  const changed = useMemo(() => new Set(event.changed.map(([r]) => r)), [event])

  const dij = epoch.dijkstra[Math.min(dijSource, p.nodes.length - 1)]
  const k = Math.min(dijStep ?? dij.length - 1, dij.length - 1)
  const overlay: DijkstraOverlay | null =
    tab === "dijkstra"
      ? {
          source: Math.min(dijSource, p.nodes.length - 1),
          done: new Set(dij.slice(0, k + 1).map((s) => s.added)),
          added: dij[k].added,
          d: dij[k].d,
          p: dij[k].p,
          infinity: p.infinity,
        }
      : null

  const chart = useMemo(() => distanceSeries(run, p, d, duration), [run, p, d, duration])

  const apply = (next: RoutingParams, id = "") => {
    setParams(next)
    setPreset(id)
    setDijStep(null)
    keepFocus(root)
  }
  const closeLink = () => {
    setLink(null)
    keepFocus(root)
  }
  const load = (id: string, at = 0) => {
    const pr = PRESETS.find((q) => q.id === id)
    if (!pr) return
    apply(pr.params, pr.id)
    setDest(pr.dest)
    setRouter(pr.params.nodes.findIndex((_, i) => i !== pr.dest))
    setLink(null)
    tl.pause()
    tl.seek(at)
  }
  const goTour = (i: number | null) => {
    setTour(i)
    if (i === null) return
    load(TOUR[i].preset, TOUR[i].at)
    setTab("tables")
  }
  const pick = (r: number, y: number) => {
    setRouter(r)
    setDest(y)
  }

  const presetInfo = PRESETS.find((q) => q.id === preset)
  const caption = `${presetInfo?.title ?? "Your network"}: routes to ${p.nodes[d]} at ${clock(event.t, p)}`
  // Rounds when every message takes one delay, as the clock elsewhere says; otherwise milliseconds.
  const xAxis = timed
    ? { label: "time (s)", format: (v: number) => String(Number((v / 1e6).toFixed(0))) }
    : p.jitter_us === 0
      ? { label: "round", format: (v: number) => String(Number((v / p.delay_us).toFixed(1))) }
      : { label: "time (ms)", format: (v: number) => String(Number((v / 1000).toFixed(1))) }
  const chartFigure = (): ChartFigure => ({
    xLabel: xAxis.label,
    yLabel: `cost to ${p.nodes[d]}`,
    xFormat: xAxis.format,
    yFormat: (v) => (v >= p.infinity ? "∞" : String(Math.round(v))),
    xDomain: [0, duration],
    yDomain: [0, chart.cap],
    series: chart.series.map((s) => ({ label: s.label, color: s.color, points: s.points, dashed: s.dashed, step: true })),
    refs: [{ y: chart.cap, label: chart.cap >= p.infinity ? `unreachable (infinity = ${p.infinity})` : "unreachable" }],
    caption: `${presetInfo?.title ?? "Your network"}: each router's cost to ${p.nodes[d]}`,
  })

  return (
    <section
      ref={root}
      tabIndex={-1}
      className="nv-tool space-y-5 outline-none [&.nv-present]:[zoom:1.2] [&.nv-present]:overflow-auto [&.nv-present]:bg-background [&.nv-present]:p-6"
      onKeyDown={(e) => {
        if (timelineKeys(tl, e)) e.preventDefault()
        else if (e.key === "Escape") closeLink()
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label className="mb-1 block font-sans text-xs text-muted-foreground" htmlFor="routing-preset">
            Scenario
          </label>
          <Select value={preset || "custom"} onValueChange={(id) => load(id)}>
            <SelectTrigger id="routing-preset" className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((pr) => (
                <SelectItem key={pr.id} value={pr.id}>
                  {pr.title}
                </SelectItem>
              ))}
              <SelectItem value="custom" disabled>
                Your own network
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant={tour === null ? "outline" : "secondary"} onClick={() => goTour(tour === null ? 0 : null)}>
          {tour === null ? "Guided tour" : "End tour"}
        </Button>
        <ToolActions
          root={root}
          link={() => linkFor("routing", { p, t: Math.round(tl.t), dest: d } satisfies Shared)}
          figures={[
            {
              label: "Network and routes",
              stem: `routing-${preset || "custom"}-graph`,
              svg: () => graphSvg({ ...fig, caption }),
              tikz: () => graphTikz({ ...fig, caption }),
            },
            { label: "Costs over time", stem: `routing-${preset || "custom"}-costs`, ...chartExports(chartFigure) },
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
          <div className="flex flex-wrap items-center gap-2 font-sans text-sm">
            <span className="text-muted-foreground">Routes to</span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Destination"
              value={String(d)}
              onValueChange={(v) => v && setDest(Number(v))}
            >
              {p.nodes.map((n, i) => (
                <ToggleGroupItem key={i} value={String(i)} aria-label={`Routes to ${n}`} className="min-w-8">
                  {n}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Graph
            fig={fig}
            messages={wire}
            changed={changed}
            actor={event.node}
            selected={x}
            link={link}
            dijkstra={overlay}
            onNode={(i) => (tab === "dijkstra" ? setDijSource(i) : setRouter(i))}
            onLink={(a, b) => setLink(link && link[0] === a && link[1] === b ? null : [a, b])}
          />
          <p className="font-sans text-xs text-muted-foreground" aria-live="polite">
            {overlay ? (
              <>Dijkstra from {p.nodes[overlay.source]}: filled routers are in N′; solid arrows are the shortest-path tree so far.</>
            ) : loops.cycles.length > 0 ? (
              <span className="text-destructive">
                Forwarding loop: packets for {p.nodes[d]} would go{" "}
                {loops.cycles.map((c) => [...c, c[0]].map((v) => p.nodes[v]).join(" → ")).join(", and ")}.
              </span>
            ) : ls ? (
              <>
                Arrows are each router's next hop towards {p.nodes[d]}; boxes on the links are LSAs in flight, named by the router that
                wrote them and their sequence number; "+2" means two more on the same link.
              </>
            ) : (
              <>
                Arrows are each router's next hop towards {p.nodes[d]}; boxes on the links are vectors in flight, showing the sender's cost
                to {p.nodes[d]} (dashed when poisoned, a dash when split horizon leaves it out).
              </>
            )}
          </p>
          {link && (
            <LinkEditor
              key={`${link[0]}-${link[1]}-${preset}`}
              p={params}
              link={link}
              now={tl.t}
              costNow={state.cost[link[0]][link[1]] >= 0 ? state.cost[link[0]][link[1]] : null}
              set={(next) => apply(next)}
              close={closeLink}
            />
          )}
          <Transport tl={tl} events={run.events.length} />
          <p className="font-sans text-xs text-muted-foreground">
            Click a router to see its {ls ? "map" : "equation"}, a link to change it. Space plays, arrow keys step, Home and End jump.
          </p>
          <LineChart
            title={`Each router's cost to ${p.nodes[d]}`}
            series={chart.series}
            xLabel={xAxis.label}
            yLabel={`cost to ${p.nodes[d]}`}
            xFormat={xAxis.format}
            yFormat={(v) => (v >= p.infinity ? "∞" : String(Math.round(v)))}
            xDomain={[0, duration]}
            yDomain={[0, chart.cap]}
            height={220}
            cursor={tl.t}
            onSeek={(t) => tl.seek(t)}
          >
            {(s) => (
              // Unreachable is drawn on the top line of the chart, which stands for infinity.
              <g pointerEvents="none">
                <line
                  x1={s.left}
                  x2={s.right}
                  y1={s.sy(chart.cap)}
                  y2={s.sy(chart.cap)}
                  stroke="var(--chart-ink)"
                  strokeOpacity={0.4}
                  strokeDasharray="2 3"
                />
                <text x={s.left - 6} y={s.sy(chart.cap)} dy="0.32em" textAnchor="end" fontSize="12" fill="var(--chart-ink)">
                  ∞
                </text>
              </g>
            )}
          </LineChart>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="rounded-sm border border-border p-3" aria-live={tl.playing ? "off" : "polite"}>
            <p className="font-sans text-xs text-muted-foreground">
              {clock(event.t, p)}, {event.node < 0 ? "the network" : `router ${p.nodes[event.node]}`}
            </p>
            <p className="mt-0.5">
              <b className="lining">{event.step}.</b> [{stepTitles.get(event.step) ?? ""}] {event.text}
            </p>
          </div>
          <Totals run={run} p={p} />
          {ls ? <MapCard p={p} s={state} event={event} x={x} y={d} /> : <BellmanCard p={p} s={state} event={event} x={x} y={d} />}

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="tables">Tables</TabsTrigger>
              <TabsTrigger value="trace">Trace</TabsTrigger>
              <TabsTrigger value="dijkstra">Dijkstra</TabsTrigger>
              <TabsTrigger value="setup">Setup</TabsTrigger>
              <TabsTrigger value="source">Source</TabsTrigger>
              <TabsTrigger value="lab">Lab</TabsTrigger>
            </TabsList>
            <TabsContent value="tables">
              <VectorMatrix p={p} event={event} epoch={epoch} router={x} dest={d} onPick={pick} />
            </TabsContent>
            <TabsContent value="trace">
              <TraceList events={run.events} index={tl.index} onSeek={tl.seekIndex} />
            </TabsContent>
            <TabsContent value="dijkstra">
              <DijkstraTable
                p={p}
                epoch={epoch}
                source={Math.min(dijSource, p.nodes.length - 1)}
                k={k}
                setK={setDijStep}
                setSource={(s) => {
                  setDijSource(s)
                  setDijStep(0)
                }}
              />
            </TabsContent>
            <TabsContent value="setup">
              <RoutingSetup p={params} set={(next) => apply(next)} />
            </TabsContent>
            <TabsContent value="source">
              <p className="mb-2 font-sans text-xs text-muted-foreground">
                The Rust that produced this run (crates/netsim/src/routing.rs), compiled into the page. The step behind the current event is
                shaded; K1 to K3 are Dijkstra's.
              </p>
              <LiterateSource source={source} active={tab === "source" ? event.step : null} className="max-h-[32rem]" />
            </TabsContent>
            <TabsContent value="lab" forceMount className="data-[state=inactive]:hidden">
              <LabPanel
                labs={LABS}
                load={(start) => {
                  apply(start)
                  setLink(null)
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

const Article = memo(function Article(props: { sim: Netsim; p: RoutingParams; run: RoutingRun; onLoad(id: string): void }) {
  return (
    <>
      <RoutingIntro onLoad={props.onLoad} />
      <RoutingAnalysis {...props} />
      <RoutingFrontier />
      <RoutingInternals />
    </>
  )
})

const Totals = memo(function Totals({ run, p }: { run: RoutingRun; p: RoutingParams }) {
  const T = run.totals
  const updates = run.events.reduce((n, e) => n + e.changed.length, 0)
  const items: [string, string, boolean][] = [
    ["last table change", clock(T.last_change_us, p), false],
    ["tables correct at the end", T.truncated ? "run cut short" : T.converged ? "yes" : "no", !T.converged],
    [p.algorithm === "ls" ? "LSAs sent" : "vectors sent", `${T.messages}${T.lost ? ` (${T.lost} lost)` : ""}`, false],
    ["table entries changed", String(updates), false],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-sans text-sm">
      {items.map(([k, v, bad]) => (
        <div key={k}>
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className={cn("tabular-nums lining", bad && "text-destructive")}>{v}</dd>
        </div>
      ))}
    </dl>
  )
})
